// engines/fall-survive/mechanic/lighting.js
//
// Wave-1 hex dance-floor lighting. Adds per-tile emissive that sweeps across
// the platform on a fixed BPM clock — reads as an actual lit dance floor under
// the IP-painted hex_top diffuse texture. Composes additively with the
// existing red-tint fall telegraph (we pause emissive on dropping tiles so
// the red still reads).
//
// Shipped pattern: BEAT-SYNCED WAVE (#3 from LIGHTING_BRIEF.md).
//   Intent block (full version in LIGHTING_NOTES.md):
//     trigger     — per-frame timer driven by a fixed BPM clock
//     recurrence  — continuous loop while PLAYING
//     ux_message  — "the platform is alive, you're in a venue, not a void"
//     narrative_role — dance-floor identity under fall-guys obstacle traversal
//
// Hooks registered on window.FallSurvive (called from index.js):
//   setupTileLighting(tiles, scene, cfg)  — once per round after buildTileMeshes
//   updateTileLighting(dt, scene, gameState) — per frame in PLAYING state
//
// All knobs at window.FallSurvive.lightingConfig — defaults below; cfg.lighting
// from level_config payload merges over them on each setupTileLighting call.

(function () {
  'use strict';

  window.FallSurvive = window.FallSurvive || {};
  const Hooks = window.FallSurvive;

  // ===================================================================== //
  // Tunable knobs — override via window.FallSurvive.lightingConfig.* before
  // setupTileLighting fires, OR via cfg.lighting on the level_config payload.
  // Per-knob comments call out what to twist if the iteration mode wants to.
  // ===================================================================== //
  const DEFAULT_CONFIG = {
    // Master enable. Flip false to bypass the whole module without removing
    // the script tag — engine still works, falls back to neutral materials.
    enabled: true,

    // Beat clock. Drives the sweep cadence. 70 BPM ≈ 0.86 sec/beat — slow
    // pulse, no strobe perception. Lower = slower / chiller; higher = more
    // frantic / arcade. Was 110 originally but read as flashing — bring it
    // back up if the floor feels too sleepy.
    bpm: 70,

    // Sweep wavelength in WORLD UNITS along the moving axis. Smaller = more
    // bands visible across the platform at once (tighter pattern); larger =
    // a single broad wash crossing the disc. The 4-ring default platform is
    // ~16 units across, so wavelength: 8 gives ~2 bands visible.
    wavelength: 8.0,

    // How fast the sweep AXIS rotates (radians/sec). 0 = fixed-angle stripe;
    // higher = sweep direction tumbles. Mild rotation prevents the pattern
    // from feeling locked in one direction. Tau over a leisurely 12 sec
    // is a calm, perceptible drift.
    sweep_axis_rotation_rate: (Math.PI * 2) / 12,

    // Emissive intensity envelope (0..1 multiplied through palette colors).
    // The wave function output is in [-1, +1]; we clamp the negative half to
    // a floor so unlit tiles still glow faintly (venue ambient) instead of
    // going pitch black. base_intensity = the floor; peak_intensity = the
    // crest. Both are multiplied through the palette.
    base_intensity: 0.20,    // dim ambient — tile still visible when "off"
    peak_intensity: 0.50,    // crest — softer than original 0.85 to avoid flash perception

    // Wave shape exponent. The base sine is squashed via Math.pow(x, k):
    //   k = 1.0 → smooth sine (broad bright bands)
    //   k = 2.0 → pinched peaks (sharper sweeps, more "scanline" feel)
    //   k = 0.5 → fattened peaks (most of the floor lit, brief dim valleys)
    wave_shape_exponent: 0.9,

    // Layer fall-off. Each Y-stacked layer below the active top has its
    // emissive dimmed by this multiplier per layer. 1.0 = all layers equally
    // bright (loses depth); 0.5 = halve each layer (strong "active layer is
    // the stage, lower layers are stagecraft"). Composes with #5 from the
    // pattern menu (layer-distinguished) without being the primary register.
    layer_falloff: 0.62,

    // Palette — the two emissive endpoints the wave interpolates between.
    // Hot dance-floor palette: a pinky-magenta + a cyan, so the cross-fade
    // crosses through bluish purple. Override per-IP via cfg.lighting.palette.
    color_a: '#ff3a8a',   // magenta crest
    color_b: '#3ad8ff',   // cyan trough — actually the COMPLEMENT crest
    // The wave produces values in [0,1]; we lerp color_a → color_b across it.
    // So you see SLABS of color_a chasing slabs of color_b across the disc.

    // Per-tile axial-parity tint — a subtle static checkerboard riding the
    // sweep, so even when the sweep crest is overhead the floor still has
    // 2-tone visual texture. Set to 0 to disable. Small additive offset to
    // peak_intensity for "even" hex coords; "odd" coords get nothing.
    parity_tint_strength: 0.08,

    // Telegraph compatibility. When true, tiles with .dropping === true skip
    // emissive updates entirely so the red diffuse telegraph (#c4624a set in
    // index.js step trigger) reads cleanly. Strongly recommend keeping true
    // — flipping false causes the cyan/magenta to fight the red.
    pause_emissive_on_telegraph: true,

    // Telegraph emissive damping. Even with pause_emissive_on_telegraph = true,
    // the LAST emissive value applied to the tile persists on the StandardMaterial
    // before the telegraph fires. We snap it to a low value so the red doesn't
    // get washed by leftover bright emissive. Hex; multiplied by 0.4 internally.
    telegraph_emissive_floor: '#1a1010',
  };

  // Public knob surface. Mutable. Iteration-mode CLI users edit this object
  // (or pass cfg.lighting in level_config) and the next setupTileLighting
  // re-merges it.
  Hooks.lightingConfig = Hooks.lightingConfig || Object.assign({}, DEFAULT_CONFIG);

  // Internal state — not part of the public knob surface. Lives across calls.
  const State = {
    tiles: null,         // active tile array reference
    config: null,        // merged config snapshot (DEFAULT ← lightingConfig ← cfg.lighting)
    elapsedSec: 0,       // total playing time (driven by updateTileLighting dt)
    cachedColorA: null,  // BABYLON.Color3 of palette[0]
    cachedColorB: null,  // BABYLON.Color3 of palette[1]
    cachedTelegraphFloor: null,  // BABYLON.Color3 of telegraph floor
  };

  // Merge order: DEFAULT_CONFIG ← Hooks.lightingConfig (CLI/global) ← cfg.lighting (per-IP).
  function buildMergedConfig(cfgLighting) {
    const merged = Object.assign({}, DEFAULT_CONFIG, Hooks.lightingConfig || {});
    if (cfgLighting && typeof cfgLighting === 'object') {
      Object.assign(merged, cfgLighting);
    }
    return merged;
  }

  function parseColor3(hex) {
    try { return BABYLON.Color3.FromHexString(hex); }
    catch (_) { return new BABYLON.Color3(0.5, 0.5, 0.5); }
  }

  // Per-tile bookkeeping we attach: axial parity bit + layer index already on
  // the tile object (t.layer, t.q, t.s). We also tag tiles with a stable hash
  // for any future per-tile RNG knobs — cheap to compute here so we don't
  // recompute per-frame.
  function decorateTile(t) {
    // Axial parity for the static parity tint.
    t._lightParity = ((t.q + t.s * 2) % 2 + 2) % 2;  // 0 or 1
    // Per-tile rotational offset in radians — small jitter so the sweep
    // doesn't have an unnaturally sharp single-line crest. Stable from q/s.
    const h = (t.q * 73856093) ^ (t.s * 19349663) ^ (t.layer * 83492791);
    t._lightHash = ((h >>> 0) % 1000) / 1000;  // [0, 1)
  }

  // ===================================================================== //
  // Hook: setupTileLighting — called once per round after buildTileMeshes.
  // Caches the tile array reference + merges cfg.lighting + decorates tiles.
  // Does NOT pre-set any emissive — first updateTileLighting tick will paint.
  // ===================================================================== //
  Hooks.setupTileLighting = function (tiles, scene, cfg) {
    State.tiles = tiles;
    State.config = buildMergedConfig(cfg && cfg.lighting);
    State.elapsedSec = 0;
    State.cachedColorA = parseColor3(State.config.color_a);
    State.cachedColorB = parseColor3(State.config.color_b);
    State.cachedTelegraphFloor = parseColor3(State.config.telegraph_emissive_floor);

    if (!State.config.enabled) return;

    for (const t of tiles) {
      decorateTile(t);
      // Initialize emissive on the topMat so the platform doesn't flash from
      // black on the first frame. Use base_intensity * color_a as a calm seed.
      if (t.topMat) {
        const seed = State.cachedColorA.scale(State.config.base_intensity);
        t.topMat.emissiveColor = seed;
      }
    }
  };

  // ===================================================================== //
  // Hook: updateTileLighting — per-frame, PLAYING state only.
  //
  // Wave equation:
  //   axis(t)         = unit vector rotating at sweep_axis_rotation_rate
  //   tile_projection = dot(tile_xz, axis(t))   // scalar position along axis
  //   beat_phase      = elapsed * (bpm/60) * 2π
  //   raw             = sin(2π * tile_projection / wavelength - beat_phase)
  //   shaped          = sign(raw) * |raw|^wave_shape_exponent     // [-1, +1]
  //   normalized      = (shaped + 1) / 2                          // [0, 1]
  //   intensity       = base + (peak - base) * normalized
  //   color           = lerp(color_a, color_b, normalized) * intensity
  //   layer_dim       = layer_falloff ^ tile.layer
  //   parity_bonus    = parity_tint_strength * tile._lightParity
  //   final           = (color + parity_bonus_magenta) * layer_dim
  // ===================================================================== //
  Hooks.updateTileLighting = function (dt, scene, gameState) {
    if (!State.tiles || !State.config || !State.config.enabled) return;

    State.elapsedSec += dt;
    const c = State.config;

    // Sweep axis rotation. axisAngle is the direction the wave PROPAGATES.
    const axisAngle = State.elapsedSec * c.sweep_axis_rotation_rate;
    const axisX = Math.cos(axisAngle);
    const axisZ = Math.sin(axisAngle);

    // Beat phase — full 2π per beat. Negative sign so crest moves
    // axis-forward (intuitive direction).
    const beatPhase = State.elapsedSec * (c.bpm / 60) * (Math.PI * 2);
    const invWavelength = (Math.PI * 2) / Math.max(c.wavelength, 0.001);

    const baseI = c.base_intensity;
    const peakI = c.peak_intensity;
    const intensitySpan = peakI - baseI;
    const exp = Math.max(0.05, c.wave_shape_exponent);
    const cA = State.cachedColorA;
    const cB = State.cachedColorB;
    const cTelF = State.cachedTelegraphFloor;
    const parityStrength = c.parity_tint_strength;
    const layerFalloff = c.layer_falloff;
    const pauseOnTelegraph = c.pause_emissive_on_telegraph;

    for (const t of State.tiles) {
      if (t.fallen) continue;
      if (!t.topMat) continue;

      // Telegraph compatibility: tiles in the dropping state get a damped
      // emissive floor so the red diffuse tint reads. Apply once on the
      // transition, then skip the wave entirely for that tile.
      if (t.dropping && pauseOnTelegraph) {
        if (!t._lightTelegraphLatched) {
          t._lightTelegraphLatched = true;
          // Damp emissive to 0.4× the configured floor so it's near-black —
          // gives the red diffuse the visual stage without going fully dark
          // (which would make the tile look like a hole in the lighting).
          t.topMat.emissiveColor = cTelF.scale(0.4);
        }
        continue;
      }

      // Wave evaluation.
      const tileX = t.mesh ? t.mesh.position.x : t.x;
      const tileZ = t.mesh ? t.mesh.position.z : t.z;
      const proj = tileX * axisX + tileZ * axisZ;
      // Per-tile hash adds 0..1 of phase jitter — softens the wave-front line.
      const phaseJitter = t._lightHash ? (t._lightHash - 0.5) * 0.4 : 0;
      const raw = Math.sin(proj * invWavelength - beatPhase + phaseJitter);
      const shaped = (raw < 0 ? -1 : 1) * Math.pow(Math.abs(raw), exp);
      const normalized = (shaped + 1) * 0.5;  // [0, 1]

      const intensity = baseI + intensitySpan * normalized;

      // Color lerp A → B.
      const r = (cA.r * (1 - normalized) + cB.r * normalized) * intensity;
      const g = (cA.g * (1 - normalized) + cB.g * normalized) * intensity;
      const b = (cA.b * (1 - normalized) + cB.b * normalized) * intensity;

      // Parity tint — additive magenta bias on "odd" tiles.
      const parity = t._lightParity || 0;
      const parityR = parityStrength * parity * cA.r;
      const parityG = parityStrength * parity * cA.g * 0.4;  // less green so it stays magenta-leaning
      const parityB = parityStrength * parity * cA.b * 0.6;

      // Layer falloff — exponential per layer index.
      const layerDim = Math.pow(layerFalloff, t.layer || 0);

      // Allocate a Color3 per tile per frame. ~50 tiles × 60fps = 3000 GC
      // allocations/sec — acceptable for the slice; can pool if it shows up
      // in profiling, but Color3 is cheap.
      t.topMat.emissiveColor = new BABYLON.Color3(
        Math.min(1, (r + parityR) * layerDim),
        Math.min(1, (g + parityG) * layerDim),
        Math.min(1, (b + parityB) * layerDim)
      );
    }
  };
})();
