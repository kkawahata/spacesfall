// engines/fall-survive/mechanic/effects.js
//
// Wave-3 effects bucket — four atmosphere/feel families wired onto the
// fall-survive engine through the Hooks chain pattern. Single-file IIFE so
// related knobs/intents stay in one place; if it grows past ~800 lines we'll
// split per-family. As of writing it's ~600.
//
// Families shipped (intent blocks per family — full prose in EFFECTS_NOTES.md):
//   1. Weather (rain / snow / fog / dust / none)
//        trigger     — `weatherConfig.mode` set or preset applied
//        recurrence  — continuous emit while PLAYING; particles tick per frame
//        ux_message  — "the venue has weather; the round is somewhere"
//        narrative_role — sets atmospheric register without fighting skybox
//   2. Camera shake (sphere impact / tile fall / lose / public API)
//        trigger     — onSphereImpact / onTileFall / onLose hooks + Hooks.shakeCamera
//        recurrence  — one shake per event, decaying damped sine over duration
//        ux_message  — "that hit landed; that fall mattered"
//        narrative_role — punctuates physical contacts without disturbing orbit math
//   3. Player trail (emissive ribbon behind moving player)
//        trigger     — every frame the player is moving and not stationary-grounded
//        recurrence  — continuous while moving; dies ~lifetime_ms after stop
//        ux_message  — "that's me, that's where I came from"
//        narrative_role — character identity layer; bots can opt-in via bot_trails
//   4. Time-of-day presets (default / sunset / night / void / rave / storm)
//        trigger     — `Hooks.applyPreset(name)` (panel selector or console)
//        recurrence  — applied once per call; mutates skybox/lighting/weather as a unit
//        ux_message  — "press a button, see a different world"
//        narrative_role — top-level mood selector for fast iteration / comparison
//
// All knobs at window.FallSurvive.{weatherConfig, cameraShakeConfig,
// trailConfig, presetsConfig}. Optional *ConfigMeta + *ConfigEnums siblings
// give the panel agent dropdown/range hints.
//
// Hard contract:
//   - Only mutates camera.target (never camera.position) — preserves ArcRotate orbit.
//   - Never replaces tile.topMat (lighting agent territory).
//   - CPU ParticleSystem only (BABYLON.ParticleSystem) — software-GL safe.
//   - Hook chain pattern: read existing handler, write wrapper that calls it then us.
//   - TrailMesh is capability-checked; falls back to a particle stream when absent.

(function () {
  'use strict';

  window.FallSurvive = window.FallSurvive || {};
  const FS = window.FallSurvive;

  // ===================================================================== //
  // 1) weatherConfig                                                        //
  // ===================================================================== //
  // Modes: drives both particle systems (rain/snow/dust) and scene fog
  // (rain/snow/fog/dust all set fog params; 'none' clears them). Tints are
  // per-mode override hexes the panel can override mid-round.
  FS.weatherConfig = FS.weatherConfig || {
    enabled: true,
    mode: 'none',          // one of: none, rain, snow, fog, dust
    intensity: 0.6,        // 0..1 — scales particle count + fog density
    tints: {
      rain: '#3a4a66',     // cool blue-grey haze
      snow: '#aab8c8',     // cold white-grey
      fog:  '#7a8898',     // neutral grey
      dust: '#caa57a',     // warm tan
    },
    // Coverage volume — particles emit from a flat slab above the player.
    // Edge of slab in XZ from camera target; height above target.
    cover_xz_radius: 30.0,
    cover_height:    30.0,
    // Per-mode particle target counts at intensity=1.0. Linearly scaled by intensity.
    counts: {
      rain: 800,
      snow: 600,
      dust: 220,
    },
    // Fog density caps at intensity=1.0. Linearly scaled by intensity.
    fog_density: {
      rain: 0.012,
      snow: 0.018,
      fog:  0.040,         // heaviest — fog mode is mostly fog, no particles
      dust: 0.014,
    },
  };
  FS.weatherConfigEnums = FS.weatherConfigEnums || {
    mode: ['none', 'rain', 'snow', 'fog', 'dust'],
  };
  FS.weatherConfigMeta = FS.weatherConfigMeta || {
    intensity:       { min: 0, max: 1, step: 0.05, label: 'Intensity' },
    cover_xz_radius: { min: 5, max: 80, step: 1, label: 'Coverage radius (XZ)' },
    cover_height:    { min: 5, max: 80, step: 1, label: 'Coverage height (Y)' },
  };

  // ===================================================================== //
  // 2) cameraShakeConfig                                                    //
  // ===================================================================== //
  FS.cameraShakeConfig = FS.cameraShakeConfig || {
    enabled: true,
    frequency: 30,             // Hz — damped-sine oscillation rate
    impact_magnitude:   0.15,  // sphere hit on player (or any actor)
    tilefall_magnitude: 0.04,  // very mild — fires often
    lose_magnitude:     0.40,  // sharp punctuation on player fall
    // Per-event durations in ms.
    impact_ms:   180,
    tilefall_ms: 120,
    lose_ms:     420,
    // Only shake on player-targeted events (not bot impacts). Set to false
    // to feel hits on bots too — cool for spectator iteration mode.
    player_only: true,
  };
  FS.cameraShakeConfigMeta = FS.cameraShakeConfigMeta || {
    frequency:          { min: 5, max: 80, step: 1, label: 'Frequency (Hz)' },
    impact_magnitude:   { min: 0, max: 1, step: 0.01 },
    tilefall_magnitude: { min: 0, max: 1, step: 0.01 },
    lose_magnitude:     { min: 0, max: 2, step: 0.01 },
    impact_ms:   { min: 0, max: 1500, step: 10 },
    tilefall_ms: { min: 0, max: 1500, step: 10 },
    lose_ms:     { min: 0, max: 3000, step: 10 },
  };

  // ===================================================================== //
  // 3) trailConfig                                                          //
  // ===================================================================== //
  FS.trailConfig = FS.trailConfig || {
    enabled: true,
    lifetime_ms: 600,
    width: 0.4,                // ribbon thickness (Babylon TrailMesh diameter)
    bot_trails: false,         // off by default — keeps the player visually distinct
    min_speed: 0.6,            // squared speed threshold below which trail is skipped
    color_override: null,      // hex (e.g. '#ff00ff') wins over character glow_color
    fallback_particles: true,  // when TrailMesh is missing, emit a particle ribbon
  };
  FS.trailConfigMeta = FS.trailConfigMeta || {
    lifetime_ms: { min: 100, max: 4000, step: 50 },
    width:       { min: 0.05, max: 2.0, step: 0.05 },
    min_speed:   { min: 0, max: 5, step: 0.1 },
  };

  // ===================================================================== //
  // 5) cloudsConfig — floating candy clouds (mesh-based)                    //
  // ===================================================================== //
  // Wave-5 visual layer. Mesh-rig cloud groups orbiting the platform with
  // cheap drift + bob. Distinct from the procedural in-shader clouds in
  // skybox.js (those are sky-baked distance haze; these are foreground
  // volumes that catch sun + cast shadows when the shadow generator is
  // wired up). Each cloud = a TransformNode group of 3-5 sphere primitives,
  // semi-transparent, no lighting, parented for cheap orbital + bob.
  //
  // Triggers:
  //   - First setupSkybox call (also rebuilds when preset swap fires it).
  //   - Disposed + rebuilt on round restart via onWeatherReset hook.
  //
  // UX message: "the venue has weather-as-decor — distance + atmosphere
  // without fighting platform readability".
  FS.cloudsConfig = FS.cloudsConfig || {
    enabled: true,
    count: 14,                    // groups orbiting the platform
    radius_min: 28,               // ring radius (units) — closest group
    radius_max: 48,               // outermost group
    height_min: 14,               // Y placement floor
    height_max: 24,               // Y placement ceiling
    drift_speed_mult: 1.0,        // global multiplier on per-cloud orbit speed
    bob_amplitude: 0.6,           // vertical wobble per cloud
    bob_frequency: 0.4,           // bob rate (Hz-ish, wraps in sin)
    palette: [                    // pastel candy-cloud colors
      '#ffffff',
      '#ffe6f0',
      '#fff0d9',
      '#ffd9e6',
    ],
    puff_min: 3,                  // sphere primitives per group (lower bound)
    puff_max: 5,                  // upper bound (random in [min, max])
    puff_radius_min: 1.6,
    puff_radius_max: 3.0,
    opacity: 0.9,
    cast_shadow: false,           // candy clouds float — they don't darken the floor
  };
  FS.cloudsConfigMeta = FS.cloudsConfigMeta || {
    count:            { min: 0, max: 40, step: 1, label: 'Cloud groups' },
    radius_min:       { min: 5, max: 80, step: 1 },
    radius_max:       { min: 5, max: 120, step: 1 },
    height_min:       { min: 0, max: 60, step: 1 },
    height_max:       { min: 0, max: 80, step: 1 },
    drift_speed_mult: { min: 0, max: 4, step: 0.05 },
    bob_amplitude:    { min: 0, max: 4, step: 0.05 },
    bob_frequency:    { min: 0, max: 3, step: 0.05 },
    opacity:          { min: 0, max: 1, step: 0.05 },
  };

  // ===================================================================== //
  // 4) presetsConfig                                                        //
  // ===================================================================== //
  // A preset bundles {skybox, lighting, weather, cameraShake} mutations.
  // applyPreset() shallow-merges each section over the corresponding
  // window.FallSurvive.*Config namespace, then re-fires the relevant setup
  // hooks (skybox, lighting). Weather + cameraShake re-read live so no
  // re-fire needed for those two.
  FS.presetsConfig = FS.presetsConfig || {
    current: 'default',
    available: {
      // Default — warm sunset register (matches wave-5 ship defaults). The
      // baseline reads as "atmospheric warm" so even an unstyled IP starts
      // with mood; vivid presets push further.
      default: {
        skybox: {
          color_zenith:  '#2c3a78',
          color_horizon: '#ff9a78',
          color_ground:  '#ffd9b3',
          sun_color:     '#ffc488',
          sun_direction: [0.4, 0.25, 0.6],
          sun_size:      0.08,
          sun_halo:      0.18,
          cloud_density: 0.20,
          cloud_softness:0.85,
          haze_strength: 0.45,
          night:         false,
          star_density:  0.4,
        },
        lighting: { bpm: 70, peak_intensity: 0.50, base_intensity: 0.20 },
        weather:  { mode: 'none', intensity: 0.6 },
        cameraShake: { enabled: true },
      },

      // Sunset — warm orange/pink horizon, slower BPM, no weather.
      sunset: {
        skybox: {
          color_zenith:  '#3a4078',
          color_horizon: '#ff9a5a',
          color_ground:  '#3a1a28',
          sun_color:     '#ffb868',
          sun_size:      0.10,
          sun_halo:      0.22,
          cloud_density: 0.35,
          cloud_softness:0.85,
          haze_strength: 0.55,
          night:         false,
        },
        lighting: { bpm: 48, peak_intensity: 0.42 },
        weather:  { mode: 'none', intensity: 0.4 },
      },

      // Night — deep sky + stars, cyan-only emissive lighting, light fog.
      night: {
        skybox: {
          color_zenith:  '#05060f',
          color_horizon: '#0e1a30',
          color_ground:  '#000005',
          sun_color:     '#aac8ff',
          sun_size:      0.04,
          sun_halo:      0.08,
          cloud_density: 0.10,
          cloud_softness:0.95,
          haze_strength: 0.2,
          night:         true,
          star_density:  0.65,
        },
        lighting: {
          bpm: 60,
          peak_intensity: 0.65,
          base_intensity: 0.12,
          color_a: '#3ad8ff',
          color_b: '#0a7aa8',
        },
        weather:  { mode: 'fog', intensity: 0.45 },
      },

      // Void — black sky no clouds, dim lighting, drifting dust.
      void: {
        skybox: {
          color_zenith:  '#000000',
          color_horizon: '#070710',
          color_ground:  '#000000',
          sun_color:     '#1a1a1a',
          sun_size:      0.0,
          sun_halo:      0.0,
          cloud_density: 0.0,
          haze_strength: 0.05,
          night:         true,
          star_density:  0.15,
        },
        lighting: {
          bpm: 30,
          peak_intensity: 0.28,
          base_intensity: 0.06,
          color_a: '#704090',
          color_b: '#2a1040',
        },
        weather: { mode: 'dust', intensity: 0.35 },
      },

      // Rave — saturated palette, high BPM, no weather (clear visibility).
      rave: {
        skybox: {
          color_zenith:  '#1a052a',
          color_horizon: '#5a1090',
          color_ground:  '#100020',
          sun_color:     '#ff6ad0',
          sun_size:      0.08,
          sun_halo:      0.18,
          cloud_density: 0.30,
          cloud_softness:0.6,
          haze_strength: 0.15,
          night:         true,
          star_density:  0.20,
        },
        lighting: {
          bpm: 140,
          peak_intensity: 0.85,
          base_intensity: 0.22,
          wave_shape_exponent: 1.6,
          color_a: '#ff3a8a',
          color_b: '#3affd8',
        },
        weather: { mode: 'none' },
      },

      // Candy — wave-5 saturated palette. Hot pink + arcade cyan + butter
      // yellow lifted from the variant's CHAR_COLORS (#ff6b9d, #4ad6ff,
      // #ffe14a, #ff8c42). Sky pushes the sunset further into vivid pink/
      // peach; lighting flips to a hot-pink↔cyan beat. Clear weather so
      // the candy clouds + saturated tile lighting both read clean.
      candy: {
        skybox: {
          color_zenith:  '#ff6bb5',  // hot pink top
          color_horizon: '#ffe14a',  // butter-yellow horizon (warm)
          color_ground:  '#ffd9e6',  // pink cream lower
          sun_color:     '#fff5b0',  // warm white-yellow
          sun_direction: [0.4, 0.30, 0.6],
          sun_size:      0.10,
          sun_halo:      0.24,
          cloud_density: 0.15,       // mostly mesh clouds; faint shader haze
          cloud_softness:0.95,
          cloud_color:   '#ffffff',
          haze_strength: 0.55,
          night:         false,
          star_density:  0.0,
        },
        clouds: {
          enabled: true,
          count: 16,
          drift_speed_mult: 1.4,
          // Saturated candy palette — derived from CHAR_COLORS (#ff6b9d /
          // #4ad6ff / #ffe14a / #6bff9c / #ff8c42 / #c56bff). Pastels
          // emissive-flat so they read as candy clouds, not toxic blobs.
          palette: [
            '#ffd9e6',  // pink-cream
            '#ffe6f0',  // pale pink
            '#fff0d9',  // butter cream
            '#d9f5ff',  // pale arcade-cyan
            '#f0d9ff',  // pale lavender
          ],
          opacity: 0.92,
        },
        lighting: {
          color_a:        '#ff6b9d',  // hot pink (CHAR_COLORS[0])
          color_b:        '#4ad6ff',  // arcade cyan (CHAR_COLORS[3])
          peak_intensity: 0.65,       // bumped for vibrancy
          base_intensity: 0.22,
          bpm: 90,
        },
        weather: { mode: 'none' },
        cameraShake: { enabled: true },
      },

      // Storm — dim cloudy sky, heavy rain, lighting muted.
      storm: {
        skybox: {
          color_zenith:  '#1a2030',
          color_horizon: '#36404a',
          color_ground:  '#10141c',
          sun_color:     '#7a8090',
          sun_size:      0.02,
          sun_halo:      0.06,
          cloud_density: 0.85,
          cloud_softness:0.5,
          haze_strength: 0.55,
          night:         false,
        },
        lighting: { bpm: 50, peak_intensity: 0.30, base_intensity: 0.12 },
        weather:  { mode: 'rain', intensity: 0.85 },
      },
    },
  };

  // ===================================================================== //
  // Capability check. If BABYLON isn't loaded yet, register stubs and bail. //
  // Mirrors vfx.js's contract.                                              //
  // ===================================================================== //
  if (typeof BABYLON === 'undefined' || !BABYLON.ParticleSystem) {
    console.warn('[fall-survive effects] BABYLON unavailable; effects disabled.');
    FS.shakeCamera = function () {};
    FS.applyPreset = function () {};
    return;
  }

  // ===================================================================== //
  // Internal state — all module-private. Public surface is the *Config      //
  // namespaces above + Hooks.shakeCamera + Hooks.applyPreset.               //
  // ===================================================================== //
  const State = {
    initialized: false,
    scene: null,
    camera: null,
    Game: null,
    TUNING: null,

    // Weather
    activeMode: null,           // last-applied mode string
    weatherSystem: null,        // BABYLON.ParticleSystem | null
    weatherFogBaseColor: null,  // BABYLON.Color3 backup of pre-effect scene.fogColor (always black, but be safe)
    weatherFogBaseMode: null,   // pre-effect scene.fogMode
    weatherFogBaseDensity: null,

    // Camera shake
    shakeQueue: [],             // active shakes [{ magnitude, durationMs, startedAt, frequency }]
    shakeOffset: { x: 0, z: 0 },// last-applied offset (so we can subtract it next frame)

    // Trail
    trail: null,                // BABYLON.TrailMesh | particle anchor
    trailKind: null,            // 'mesh' | 'particles'
    trailParticles: null,       // BABYLON.ParticleSystem when fallback path is in use
    trailLastPos: null,         // BABYLON.Vector3 for movement detection
    trailActorRef: null,        // weak ref to actor we attached to (player)

    // Clouds — array of { group:TransformNode, puffs:[Mesh], driftSpeed,
    // orbitAngle, orbitRadius, orbitY, bobPhase, materials:[Material] }.
    // Disposed on setupClouds() rebuild + on level reset (we also re-fire
    // setupClouds whenever setupSkybox is invoked since the rig is paired
    // with the sky in our visual stack).
    clouds: [],
    cloudsElapsedSec: 0,        // monotonic for bob/drift; only ticks while playing
  };

  // Shared particle texture — radial soft disc. Same trick vfx.js uses.
  let _sharedParticleTex = null;
  function getParticleTexture(scene) {
    if (_sharedParticleTex && !_sharedParticleTex._disposed) return _sharedParticleTex;
    const tex = new BABYLON.DynamicTexture('effects_particle', { width: 64, height: 64 }, scene, false);
    const ctx = tex.getContext();
    const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    tex.update();
    tex.hasAlpha = true;
    _sharedParticleTex = tex;
    return tex;
  }

  // Hex → BABYLON.Color3 / Color4 helpers (with safe fallback).
  function parseColor3(hex) {
    try { return BABYLON.Color3.FromHexString(hex); }
    catch (_) { return new BABYLON.Color3(0.5, 0.5, 0.5); }
  }
  function hexC4(hex, a) {
    const c = parseColor3(hex);
    return new BABYLON.Color4(c.r, c.g, c.b, a == null ? 1 : a);
  }

  // ===================================================================== //
  // 1) WEATHER                                                              //
  // ===================================================================== //
  // setupWeather (re-)builds the active weather system based on
  // FS.weatherConfig. Idempotent — safe to call from a panel "apply" button
  // or a preset switch any time. Keeps prior fog state so 'none' restores.

  function disposeWeather() {
    if (State.weatherSystem) {
      try { State.weatherSystem.dispose(); } catch (_) {}
      State.weatherSystem = null;
    }
  }

  function applyFog(mode, scene) {
    const cfg = FS.weatherConfig;
    if (mode === 'none' || !cfg.enabled) {
      // Restore prior fog state (defaults to NONE if we never captured).
      scene.fogMode = State.weatherFogBaseMode != null ? State.weatherFogBaseMode : BABYLON.Scene.FOGMODE_NONE;
      if (State.weatherFogBaseColor) scene.fogColor = State.weatherFogBaseColor.clone();
      if (State.weatherFogBaseDensity != null) scene.fogDensity = State.weatherFogBaseDensity;
      return;
    }
    // Ensure we captured baseline once (first time we touch fog).
    if (State.weatherFogBaseMode == null) {
      State.weatherFogBaseMode = scene.fogMode;
      State.weatherFogBaseColor = scene.fogColor ? scene.fogColor.clone() : new BABYLON.Color3(0, 0, 0);
      State.weatherFogBaseDensity = scene.fogDensity || 0;
    }
    const tintHex = cfg.tints[mode] || '#888888';
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
    scene.fogColor = parseColor3(tintHex);
    const baseDensity = (cfg.fog_density && cfg.fog_density[mode]) || 0.01;
    scene.fogDensity = baseDensity * Math.max(0, Math.min(1, cfg.intensity));
  }

  function buildWeatherParticles(mode, scene) {
    const cfg = FS.weatherConfig;
    if (mode === 'none' || mode === 'fog') return null;  // 'fog' is fog-only, no particles
    const baseCount = (cfg.counts && cfg.counts[mode]) || 200;
    const capacity = Math.max(8, Math.round(baseCount * Math.max(0, Math.min(1, cfg.intensity))));
    const ps = new BABYLON.ParticleSystem(`weather_${mode}`, capacity, scene);
    ps.particleTexture = getParticleTexture(scene);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;

    const tintHex = (cfg.tints && cfg.tints[mode]) || '#ffffff';

    // Emit volume — flat slab above-and-around player. We anchor to a
    // BABYLON.Vector3 we update each frame in the per-frame tick. For now
    // anchor at (0, cover_height, 0) — first frame may emit far away, but
    // the next tick repositions and the visual is invisible anyway.
    const anchor = new BABYLON.Vector3(0, cfg.cover_height, 0);
    ps.emitter = anchor;
    State._weatherAnchor = anchor;  // exposed so per-frame tick can update

    const r = cfg.cover_xz_radius;
    if (mode === 'rain') {
      // Tall thin streaks falling fast. Color a desaturated blue.
      ps.minEmitBox = new BABYLON.Vector3(-r, -1, -r);
      ps.maxEmitBox = new BABYLON.Vector3( r,  1,  r);
      ps.color1 = hexC4(tintHex, 0.35);
      ps.color2 = hexC4('#aac0e0', 0.55);
      ps.colorDead = hexC4(tintHex, 0);
      ps.minSize = 0.04; ps.maxSize = 0.10;
      ps.minScaleY = 5; ps.maxScaleY = 10;  // stretch into streaks
      ps.minScaleX = 0.4; ps.maxScaleX = 0.8;
      ps.minLifeTime = 0.9; ps.maxLifeTime = 1.4;
      ps.emitRate = capacity * 1.6;
      ps.gravity = new BABYLON.Vector3(0, -22, 0);
      ps.direction1 = new BABYLON.Vector3(-0.4, -10, -0.4);
      ps.direction2 = new BABYLON.Vector3( 0.4, -16,  0.4);
      ps.minEmitPower = 6; ps.maxEmitPower = 12;
    } else if (mode === 'snow') {
      ps.minEmitBox = new BABYLON.Vector3(-r, 0, -r);
      ps.maxEmitBox = new BABYLON.Vector3( r, 4,  r);
      ps.color1 = hexC4('#ffffff', 0.9);
      ps.color2 = hexC4(tintHex, 0.7);
      ps.colorDead = hexC4(tintHex, 0);
      ps.minSize = 0.10; ps.maxSize = 0.22;
      ps.minLifeTime = 4.0; ps.maxLifeTime = 7.0;
      ps.emitRate = capacity * 0.6;
      ps.gravity = new BABYLON.Vector3(0, -1.2, 0);
      ps.direction1 = new BABYLON.Vector3(-0.5, -1.2, -0.5);
      ps.direction2 = new BABYLON.Vector3( 0.5, -0.6,  0.5);
      ps.minEmitPower = 0.2; ps.maxEmitPower = 1.2;
      ps.minAngularSpeed = -1.5; ps.maxAngularSpeed = 1.5;
    } else if (mode === 'dust') {
      ps.minEmitBox = new BABYLON.Vector3(-r, -2, -r);
      ps.maxEmitBox = new BABYLON.Vector3( r, 2,  r);
      ps.color1 = hexC4(tintHex, 0.55);
      ps.color2 = hexC4('#e0c498', 0.40);
      ps.colorDead = hexC4(tintHex, 0);
      ps.minSize = 0.08; ps.maxSize = 0.30;
      ps.minLifeTime = 3.5; ps.maxLifeTime = 6.5;
      ps.emitRate = capacity * 0.3;
      ps.gravity = new BABYLON.Vector3(0, 0.05, 0);
      // Drift horizontally — slow wind from -X toward +X.
      ps.direction1 = new BABYLON.Vector3(1.5, -0.1, -0.4);
      ps.direction2 = new BABYLON.Vector3(3.0,  0.2,  0.4);
      ps.minEmitPower = 0.4; ps.maxEmitPower = 1.4;
    }

    ps.updateSpeed = 1 / 60;
    ps.start();
    return ps;
  }

  function setupWeather(scene) {
    const cfg = FS.weatherConfig;
    if (!cfg) return;
    const mode = cfg.enabled ? cfg.mode : 'none';

    // If the mode hasn't changed AND a system already exists, refresh fog
    // density (intensity may have moved) without rebuilding particles.
    if (mode === State.activeMode && State.weatherSystem) {
      applyFog(mode, scene);
      return;
    }

    // Mode changed — tear down + rebuild.
    disposeWeather();
    applyFog(mode, scene);
    State.weatherSystem = buildWeatherParticles(mode, scene);
    State.activeMode = mode;
  }
  FS.setupWeather = setupWeather;

  // Per-frame: keep the emitter anchor centered on the camera target so
  // weather follows the player. Cheap — no allocations.
  function tickWeather() {
    if (!State.weatherSystem || !State._weatherAnchor || !State.camera) return;
    const t = State.camera.target;
    State._weatherAnchor.x = t.x;
    State._weatherAnchor.z = t.z;
    State._weatherAnchor.y = t.y + (FS.weatherConfig.cover_height || 30) * 0.5;
  }

  // ===================================================================== //
  // 2) CAMERA SHAKE                                                         //
  // ===================================================================== //
  // We jitter camera.target only — index.js's per-frame target-lerp toward
  // the player undoes our offset naturally on the next frame. So our pattern
  // is: each frame, compute the desired offset for all active shakes (sum),
  // SUBTRACT last-frame offset from camera.target, ADD this-frame offset.
  // index.js's lerp absorbs any residual drift.

  function _applyShake(magnitude, durationMs) {
    if (!State.camera) return;
    const cfg = FS.cameraShakeConfig;
    if (!cfg || !cfg.enabled || magnitude <= 0 || durationMs <= 0) return;
    State.shakeQueue.push({
      magnitude,
      durationMs,
      startedAt: performance.now(),
      frequency: cfg.frequency || 30,
      // Random phase per axis so x/z don't oscillate in lockstep.
      phaseX: Math.random() * Math.PI * 2,
      phaseZ: Math.random() * Math.PI * 2,
    });
  }

  // Public API. Callable from the console / panel / preset hooks.
  FS.shakeCamera = function (magnitude, durationMs, axis) {
    // axis arg parked for future xy/xz-axis-pin support; we currently shake
    // both X and Z by default for an ArcRotate orbit (Y-vertical jitter
    // would fight the user's beta angle).
    _applyShake(
      typeof magnitude === 'number' ? magnitude : 0.15,
      typeof durationMs === 'number' ? durationMs : 200
    );
  };

  function tickCameraShake(dt) {
    if (!State.camera) return;
    const cam = State.camera;
    // First, undo last-frame offset so we don't accumulate.
    cam.target.x -= State.shakeOffset.x;
    cam.target.z -= State.shakeOffset.z;
    State.shakeOffset.x = 0;
    State.shakeOffset.z = 0;

    if (!State.shakeQueue.length) return;
    const cfg = FS.cameraShakeConfig;
    if (!cfg || !cfg.enabled) {
      State.shakeQueue.length = 0;
      return;
    }

    const now = performance.now();
    let sumX = 0, sumZ = 0;
    for (let i = State.shakeQueue.length - 1; i >= 0; i--) {
      const s = State.shakeQueue[i];
      const elapsed = now - s.startedAt;
      if (elapsed >= s.durationMs) {
        State.shakeQueue.splice(i, 1);
        continue;
      }
      const tnorm = elapsed / s.durationMs;       // 0..1
      const decay = 1 - tnorm;                    // 1..0 linear
      const tSec = elapsed / 1000;
      const w = 2 * Math.PI * s.frequency;
      sumX += s.magnitude * decay * Math.sin(tSec * w + s.phaseX);
      sumZ += s.magnitude * decay * Math.sin(tSec * w + s.phaseZ);
    }
    State.shakeOffset.x = sumX;
    State.shakeOffset.z = sumZ;
    cam.target.x += sumX;
    cam.target.z += sumZ;
  }

  // ===================================================================== //
  // 3) PLAYER TRAIL                                                         //
  // ===================================================================== //
  // Try BABYLON.TrailMesh. If unavailable, fall back to a particle stream
  // anchored to the player mesh.

  function disposeTrail() {
    if (State.trail) {
      try { State.trail.dispose(); } catch (_) {}
      State.trail = null;
    }
    if (State.trailParticles) {
      try { State.trailParticles.dispose(); } catch (_) {}
      State.trailParticles = null;
    }
    State.trailKind = null;
    State.trailActorRef = null;
    State.trailLastPos = null;
  }

  function resolveTrailColor(actor) {
    const cfg = FS.trailConfig;
    if (cfg.color_override) return parseColor3(cfg.color_override);
    // Pull glow_color from characters.json via the character id. We cache
    // a roster on FS._characterRoster on first lookup; fetch async if missing.
    if (FS._characterRoster && actor && actor.character) {
      const c = FS._characterRoster.find(x => x.id === actor.character);
      if (c && c.visual && c.visual.glow_color) return parseColor3(c.visual.glow_color);
    }
    // Sensible default: cyan (matches engine accent).
    return parseColor3('#6a8aff');
  }

  function loadCharacterRoster() {
    if (FS._characterRoster) return;
    try {
      fetch('./characters.json')
        .then(r => r.json())
        .then(j => { FS._characterRoster = j.characters || []; })
        .catch(() => {});
    } catch (_) {}
  }

  function buildTrailMesh(actor, scene) {
    const cfg = FS.trailConfig;
    if (typeof BABYLON.TrailMesh !== 'function') return null;
    try {
      // TrailMesh signature: (name, generator, scene, diameter, length, autoStart)
      const tm = new BABYLON.TrailMesh(
        'player_trail',
        actor.mesh,
        scene,
        cfg.width,
        Math.max(8, Math.round((cfg.lifetime_ms / 1000) * 30)),  // length in segments (~30/s)
        true
      );
      const mat = new BABYLON.StandardMaterial('player_trail_mat', scene);
      const col = resolveTrailColor(actor);
      mat.emissiveColor = col;
      mat.diffuseColor = col;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.alpha = 0.7;
      mat.disableLighting = true;
      // Best-effort additive blending where supported.
      try { mat.alphaMode = BABYLON.Engine.ALPHA_ADD; } catch (_) {}
      tm.material = mat;
      return tm;
    } catch (_) {
      return null;
    }
  }

  function buildTrailParticles(actor, scene) {
    const cfg = FS.trailConfig;
    const ps = new BABYLON.ParticleSystem('player_trail_particles', 200, scene);
    ps.particleTexture = getParticleTexture(scene);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.emitter = actor.mesh;  // attaches to mesh — emits from its origin
    ps.minEmitBox = new BABYLON.Vector3(-0.05, -0.2, -0.05);
    ps.maxEmitBox = new BABYLON.Vector3( 0.05,  0.0,  0.05);
    const col = resolveTrailColor(actor);
    ps.color1 = new BABYLON.Color4(col.r, col.g, col.b, 0.8);
    ps.color2 = new BABYLON.Color4(col.r * 0.6, col.g * 0.6, col.b * 0.6, 0.6);
    ps.colorDead = new BABYLON.Color4(col.r, col.g, col.b, 0);
    ps.minSize = cfg.width * 0.6;
    ps.maxSize = cfg.width * 1.2;
    ps.minLifeTime = (cfg.lifetime_ms / 1000) * 0.6;
    ps.maxLifeTime = (cfg.lifetime_ms / 1000) * 1.0;
    ps.emitRate = 0;             // off until movement detected
    ps.minEmitPower = 0; ps.maxEmitPower = 0.4;
    ps.gravity = new BABYLON.Vector3(0, 0, 0);
    ps.direction1 = new BABYLON.Vector3(0, 0.1, 0);
    ps.direction2 = new BABYLON.Vector3(0, 0.4, 0);
    ps.start();
    return ps;
  }

  function setupTrail() {
    const cfg = FS.trailConfig;
    if (!cfg.enabled) { disposeTrail(); return; }
    if (!State.scene || !State.Game || !State.Game.player || !State.Game.player.mesh) return;

    const actor = State.Game.player;
    if (State.trailActorRef === actor && State.trail) return;  // already wired

    disposeTrail();
    loadCharacterRoster();
    const tm = buildTrailMesh(actor, State.scene);
    if (tm) {
      State.trail = tm;
      State.trailKind = 'mesh';
    } else if (cfg.fallback_particles) {
      const ps = buildTrailParticles(actor, State.scene);
      State.trailParticles = ps;
      State.trailKind = 'particles';
    }
    State.trailActorRef = actor;
    State.trailLastPos = actor.mesh.position.clone();
  }

  function tickTrail(dt) {
    const cfg = FS.trailConfig;
    if (!cfg.enabled) return;
    if (!State.Game) return;
    const actor = State.Game.player;
    if (!actor || !actor.mesh) return;

    // Re-bind if player actor changed (e.g. round restart spawned a new mesh).
    if (State.trailActorRef !== actor) setupTrail();
    if (!State.trail && !State.trailParticles) return;

    // Movement detection — squared distance from last frame above min_speed^2 * dt^2.
    const p = actor.mesh.position;
    let moving = true;
    if (State.trailLastPos) {
      const dx = p.x - State.trailLastPos.x;
      const dz = p.z - State.trailLastPos.z;
      const dy = p.y - State.trailLastPos.y;
      const speedSq = (dx*dx + dz*dz + dy*dy) / Math.max(dt, 1/240);
      // grounded + slow → off; airborne always emits (jump arc reads).
      if (actor.grounded && speedSq < (cfg.min_speed * cfg.min_speed)) moving = false;
      State.trailLastPos.copyFrom(p);
    }

    // Drive emit / fade based on movement.
    if (State.trailKind === 'particles' && State.trailParticles) {
      State.trailParticles.emitRate = moving ? 80 : 0;
    }
    // TrailMesh has no "pause" knob; setting visibility 0 disables draw but
    // it still walks. Cheaper than dispose/rebuild on every stop-and-go.
    if (State.trailKind === 'mesh' && State.trail) {
      State.trail.visibility = moving ? 0.85 : 0;
    }
  }

  // Bot trails — opt-in. We track them in a parallel registry so they don't
  // collide with the player anchor. Cheap addition; off by default.
  function tickBotTrails(dt) {
    const cfg = FS.trailConfig;
    if (!cfg.enabled || !cfg.bot_trails) {
      // Tear down any extant bot trails.
      if (State._botTrails) {
        for (const t of State._botTrails.values()) try { t.dispose(); } catch (_) {}
        State._botTrails = null;
      }
      return;
    }
    if (!State.Game || !State.Game.actors) return;
    State._botTrails = State._botTrails || new Map();
    for (const actor of State.Game.actors) {
      if (actor.control !== 'ai' || !actor.alive || !actor.mesh) continue;
      if (!State._botTrails.has(actor)) {
        const tm = buildTrailMesh(actor, State.scene)
                || (cfg.fallback_particles ? buildTrailParticles(actor, State.scene) : null);
        if (tm) State._botTrails.set(actor, tm);
      }
    }
    // Cleanup dead bots.
    for (const [actor, tm] of State._botTrails) {
      if (!actor.alive || !actor.mesh) {
        try { tm.dispose(); } catch (_) {}
        State._botTrails.delete(actor);
      }
    }
  }

  // ===================================================================== //
  // 5) CANDY CLOUDS                                                         //
  // ===================================================================== //
  // Mesh rig of pastel sphere clusters orbiting the arena. Each cloud is a
  // TransformNode group with 3-5 child spheres at random sub-offsets; the
  // group orbits the platform center on a ring with bob-on-Y. Cheap to
  // build (~50 spheres total at default count), even cheaper to tick (just
  // group transforms — child spheres are static relative to parent).

  function disposeClouds() {
    if (!State.clouds || !State.clouds.length) return;
    for (const c of State.clouds) {
      try {
        if (c.materials) for (const m of c.materials) try { m.dispose(); } catch (_) {}
        if (c.puffs) for (const p of c.puffs) try { p.dispose(); } catch (_) {}
        if (c.group) try { c.group.dispose(); } catch (_) {}
      } catch (_) {}
    }
    State.clouds.length = 0;
  }

  function buildOneCloud(scene, idx, total, cfg) {
    const TransformNode = BABYLON.TransformNode;
    const group = new TransformNode(`candy_cloud_${idx}`, scene);
    const palette = (cfg.palette && cfg.palette.length) ? cfg.palette : ['#ffffff'];
    const baseHex = palette[idx % palette.length];
    const baseColor = parseColor3(baseHex);

    const puffCount = Math.max(1, Math.round(
      cfg.puff_min + Math.random() * Math.max(0, cfg.puff_max - cfg.puff_min)
    ));
    const puffs = [];
    const materials = [];
    for (let p = 0; p < puffCount; p++) {
      const r = cfg.puff_radius_min + Math.random() *
        Math.max(0, cfg.puff_radius_max - cfg.puff_radius_min);
      const sphere = BABYLON.MeshBuilder.CreateSphere(
        `candy_cloud_${idx}_puff_${p}`,
        { diameter: r * 2, segments: 8 },
        scene
      );
      // Local offsets within the group — flattens vertically, spreads in XZ.
      sphere.position.x = (Math.random() - 0.5) * 3.5;
      sphere.position.y = (Math.random() - 0.5) * 0.6;
      sphere.position.z = (Math.random() - 0.5) * 2.2;
      sphere.parent = group;

      const mat = new BABYLON.StandardMaterial(`candy_cloud_${idx}_${p}_mat`, scene);
      mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      // Emissive so the unlit-ish clouds read consistent regardless of sun direction.
      mat.emissiveColor = baseColor.scale(0.95);
      mat.alpha = Math.max(0, Math.min(1, cfg.opacity));
      mat.backFaceCulling = true;
      sphere.material = mat;

      // Don't shadow-receive (clouds are emissive-flat) and don't shadow-cast
      // by default (they'd darken the platform — visually wrong for "candy").
      sphere.receiveShadows = false;

      puffs.push(sphere);
      materials.push(mat);
    }

    // Distribute around the ring with a slight angular jitter.
    const angle = (idx / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const radius = cfg.radius_min +
      Math.random() * Math.max(0, cfg.radius_max - cfg.radius_min);
    const y = cfg.height_min +
      Math.random() * Math.max(0, cfg.height_max - cfg.height_min);
    group.position.x = Math.cos(angle) * radius;
    group.position.y = y;
    group.position.z = Math.sin(angle) * radius;
    const scale = 0.7 + Math.random() * 0.7;
    group.scaling = new BABYLON.Vector3(scale, scale * 0.85, scale);

    return {
      group,
      puffs,
      materials,
      driftSpeed: 0.4 + Math.random() * 0.5,    // raw orbit ω (rad/sec) — multiplied
      orbitAngle: angle,
      orbitRadius: radius,
      orbitY: y,
      bobPhase: Math.random() * Math.PI * 2,
    };
  }

  function setupClouds() {
    const cfg = FS.cloudsConfig;
    if (!cfg || !cfg.enabled) { disposeClouds(); return; }
    if (!State.scene) return;
    disposeClouds();
    const N = Math.max(0, Math.floor(cfg.count || 0));
    if (N === 0) return;
    for (let i = 0; i < N; i++) {
      try { State.clouds.push(buildOneCloud(State.scene, i, N, cfg)); }
      catch (e) { /* one bad cloud shouldn't tank the rig */ }
    }
    State.cloudsElapsedSec = 0;
  }
  FS.setupClouds = setupClouds;

  // Per-frame: cheap orbit + bob. Reads cfg fresh so panel-knob iteration
  // works without a rebuild (drift_speed_mult, bob_amplitude, bob_frequency).
  function tickClouds(dt) {
    if (!State.clouds || !State.clouds.length) return;
    const cfg = FS.cloudsConfig;
    if (!cfg || !cfg.enabled) return;
    State.cloudsElapsedSec += dt;
    const tSec = State.cloudsElapsedSec;
    const speedMult = (cfg.drift_speed_mult != null) ? cfg.drift_speed_mult : 1.0;
    const bobA = (cfg.bob_amplitude != null) ? cfg.bob_amplitude : 0.6;
    const bobF = (cfg.bob_frequency != null) ? cfg.bob_frequency : 0.4;
    for (const c of State.clouds) {
      // Slow orbit — same shape as the falling-clean variant: cheap angular
      // increment scaled by per-cloud driftSpeed and global mult.
      c.orbitAngle += c.driftSpeed * dt * 0.05 * speedMult;
      const g = c.group;
      if (!g) continue;
      g.position.x = Math.cos(c.orbitAngle) * c.orbitRadius;
      g.position.z = Math.sin(c.orbitAngle) * c.orbitRadius;
      g.position.y = c.orbitY + Math.sin(tSec * bobF + c.bobPhase) * bobA;
    }
  }

  // ===================================================================== //
  // 4) PRESETS                                                              //
  // ===================================================================== //
  // applyPreset(name) — shallow-merges each section into the corresponding
  // window.FallSurvive.*Config namespace, then re-fires the relevant setup
  // hooks so the change takes effect without a full level reset.
  //
  // Re-fires:
  //   skybox  -> Hooks.setupSkybox(scene, cfg) (with old skybox disposed)
  //   lighting-> Hooks.setupTileLighting(tiles, scene, cfg) — re-merges its config
  //   weather -> setupWeather(scene)
  //   cameraShake -> live (no re-fire needed; tick reads cfg fresh each frame)

  FS.applyPreset = function (name) {
    const presets = FS.presetsConfig && FS.presetsConfig.available;
    if (!presets || !presets[name]) {
      console.warn('[fall-survive effects] unknown preset:', name);
      return false;
    }
    if (!State.initialized) {
      console.warn('[fall-survive effects] not yet initialized; preset queued is not supported.');
      return false;
    }
    const bundle = presets[name];
    const scene = State.scene;
    const Game = State.Game;
    const levelCfg = (Game && Game.levelConfig) || {};

    // 1) Skybox: shallow-merge over FS.skyboxConfig.
    if (bundle.skybox && FS.skyboxConfig) {
      Object.assign(FS.skyboxConfig, bundle.skybox);
      if (typeof FS.setupSkybox === 'function') {
        // The skybox module's setupSkybox builds + returns a new mesh; the
        // engine's applyIPTextures hook in index.js disposes the old one
        // before calling. We don't have access to that flow here, but
        // setupSkybox itself reads FS.skyboxConfig directly. Best we can do
        // is call setupSkybox and let it rebuild — the function is
        // idempotent in its own state by design.
        try { FS.setupSkybox(scene, levelCfg); } catch (e) { console.warn('[effects] setupSkybox failed:', e); }
      }
    }

    // 2) Lighting: shallow-merge over FS.lightingConfig + re-fire setup.
    if (bundle.lighting && FS.lightingConfig) {
      Object.assign(FS.lightingConfig, bundle.lighting);
      if (typeof FS.setupTileLighting === 'function' && Game && Game.tiles) {
        try { FS.setupTileLighting(Game.tiles, scene, levelCfg); } catch (e) {
          console.warn('[effects] setupTileLighting failed:', e);
        }
      }
    }

    // 3) Weather: shallow-merge + re-fire setupWeather.
    if (bundle.weather && FS.weatherConfig) {
      // Deep-merge tints if both sides have them; shallow-merge top-level keys.
      if (bundle.weather.tints) {
        FS.weatherConfig.tints = Object.assign({}, FS.weatherConfig.tints, bundle.weather.tints);
      }
      const { tints, ...rest } = bundle.weather;
      Object.assign(FS.weatherConfig, rest);
      setupWeather(scene);
    }

    // 4) Camera shake: live read — just merge.
    if (bundle.cameraShake && FS.cameraShakeConfig) {
      Object.assign(FS.cameraShakeConfig, bundle.cameraShake);
    }

    // 5) Clouds: shallow-merge then rebuild the rig. The setupSkybox chain
    // above also fires setupClouds on its own when bundle.skybox is present,
    // so guard against double-build by only rebuilding when no sky swap
    // happened (otherwise the chain already covered it with the new cfg).
    if (bundle.clouds && FS.cloudsConfig) {
      // Deep-merge palette if both have one.
      if (bundle.clouds.palette && Array.isArray(bundle.clouds.palette)) {
        FS.cloudsConfig.palette = bundle.clouds.palette.slice();
      }
      const { palette, ...rest } = bundle.clouds;
      Object.assign(FS.cloudsConfig, rest);
      // If skybox didn't fire (no bundle.skybox), rebuild clouds explicitly.
      if (!bundle.skybox) {
        try { setupClouds(); } catch (e) { console.warn('[effects] preset setupClouds failed:', e); }
      }
    }

    FS.presetsConfig.current = name;
    return true;
  };

  // ===================================================================== //
  // Hook chain — wrap existing single-handler hooks.                       //
  // ===================================================================== //
  function installHookChains() {
    const Game = State.Game;

    // onSphereImpact — chain shake on top of vfx sparks.
    const origOnSphereImpact = FS.onSphereImpact;
    FS.onSphereImpact = function (sphere, hitMesh, scene) {
      if (origOnSphereImpact) try { origOnSphereImpact(sphere, hitMesh, scene); } catch (_) {}
      const cfg = FS.cameraShakeConfig;
      if (!cfg || !cfg.enabled) return;
      // Player-only filter: skip shake on bot impacts.
      if (cfg.player_only) {
        const pmesh = Game && Game.player && Game.player.mesh;
        if (!pmesh || hitMesh !== pmesh) return;
      }
      _applyShake(cfg.impact_magnitude, cfg.impact_ms);
    };

    // onTileFall — very mild shake.
    const origOnTileFall = FS.onTileFall;
    FS.onTileFall = function (tile, scene) {
      if (origOnTileFall) try { origOnTileFall(tile, scene); } catch (_) {}
      const cfg = FS.cameraShakeConfig;
      if (!cfg || !cfg.enabled) return;
      _applyShake(cfg.tilefall_magnitude, cfg.tilefall_ms);
    };

    // onLose — punctuating shake.
    const origOnLose = FS.onLose;
    FS.onLose = function (scene) {
      if (origOnLose) try { origOnLose(scene); } catch (_) {}
      const cfg = FS.cameraShakeConfig;
      if (!cfg || !cfg.enabled) return;
      _applyShake(cfg.lose_magnitude, cfg.lose_ms);
    };

    // updateVfx — per-frame chain for weather + shake + trail ticks.
    const origUpdateVfx = FS.updateVfx;
    FS.updateVfx = function (dt, scene) {
      if (origUpdateVfx) try { origUpdateVfx(dt, scene); } catch (_) {}
      try { tickWeather(); } catch (_) {}
      try { tickCameraShake(dt); } catch (_) {}
      try { tickTrail(dt); } catch (_) {}
      try { tickBotTrails(dt); } catch (_) {}
      try { tickClouds(dt); } catch (_) {}
    };

    // setupSkybox — chain so clouds rebuild every time the sky does (preset
    // swap, level reset, IP injection). The skybox module's setupSkybox
    // returns the new skybox mesh; we don't touch that, just react after.
    const origSetupSkybox = FS.setupSkybox;
    if (typeof origSetupSkybox === 'function') {
      FS.setupSkybox = function (scene, cfg) {
        const result = origSetupSkybox(scene, cfg);
        try { setupClouds(); } catch (e) { console.warn('[effects] setupClouds chain failed:', e); }
        return result;
      };
    }
  }

  // ===================================================================== //
  // Boot — wait for Hooks.engine to be set by index.js (it lands at the    //
  // bottom of index.js's IIFE just before runRenderLoop). Polls cheaply.   //
  // ===================================================================== //
  function tryInit() {
    if (State.initialized) return true;
    if (!FS.engine || !FS.engine.scene) return false;
    State.scene = FS.engine.scene;
    State.camera = FS.engine.camera;
    State.Game = FS.engine.Game;
    State.TUNING = FS.engine.TUNING;
    State.initialized = true;

    // Install chains AFTER vfx.js etc. have registered their handlers, but
    // the script order in index.html guarantees vfx.js precedes effects.js.
    // We chain unconditionally — if a hook is missing, our wrapper still
    // fires and the orig-call is a no-op.
    installHookChains();

    // Apply current weather mode + start trail. Trail wires up on first
    // setupTrail; if player isn't spawned yet we'll retry from tickTrail.
    setupWeather(State.scene);
    setupTrail();
    // Build the cloud rig once at boot. The setupSkybox chain (above) will
    // rebuild on every sky swap; this one covers the case where the engine
    // already booted past applyIPTextures before effects.js wired in.
    try { setupClouds(); } catch (e) { console.warn('[effects] initial setupClouds failed:', e); }

    // Console hook for ad-hoc poking. Mirror panel surface.
    console.info('[fall-survive effects] initialized — try Hooks.applyPreset("sunset")');
    return true;
  }

  if (!tryInit()) {
    const interval = setInterval(() => {
      if (tryInit()) clearInterval(interval);
    }, 50);
    // Safety stop after ~5 s — engine boot in 800ms-ish, so 100 ticks is plenty.
    setTimeout(() => clearInterval(interval), 5000);
  }

  // Re-bind trail when level restarts (the player mesh is recreated).
  // We can't hear startPlay directly, so we re-check trailActorRef each tick
  // (already done in tickTrail). This catches restart paths without a hook.
})();
