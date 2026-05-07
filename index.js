// engines/fall-survive/mechanic/index.js
//
// Generic 3D-survival vertical slice. IP-agnostic — renders a hexagonal
// platform of 6-tessellation cylinders, a player capsule, and a wave of
// rolling spheres in a neutral palette. IP themes inject textures + skybox
// via level_config postMessage extensions; absent fields fall back to the
// neutral procedural rendering.
//
// Physics is bespoke — Babylon's MeshBuilder primitives only, no Cannon /
// Ammo / Havok / Oimo plugin. Player gets manual gravity + jump impulse;
// rolling spheres are kinematic with linear motion + sphere-vs-capsule
// resolution; ground-sensing is AABB-tile lookup at the player's feet.
// Architecture pick documented in PORT_NOTES.md.
//
// Boots straight into READY on level_config receipt. Emits board_cleared
// (survival success — outlasted target_duration_ms) / out_of_moves (fell
// off — Y below kill-plane) to the parent via postMessage.
//
// Parent → engine contract:
//   {type: 'level_config', payload: {
//     // Required for the play loop:
//     target_duration_ms:     int,    survive this long to win
//     wave_count:             int,    number of sphere waves over the round
//     wave_interval_ms:       int,    ms between wave spawns
//     spheres_per_wave:       int,    spheres spawned per wave
//     tile_fall_delay_ms:     int,    ms after step before tile drops
//     ring_count:             int,    rings of hexagons (1 = center+6, 2 = +12 outer, ...)
//     objective_text:         string, pre-formatted HUD line
//     // Optional IP-injection (any/all):
//     hex_top_url:        url           top-face texture for hex tiles
//     platform_skirt_url: url           side-face texture for hex tiles
//     player_skin_url:    url           player capsule texture
//     sphere_skin_url:    url           rolling-sphere texture
//     skybox_url:         url           skybox cubemap (.env or single equirect)
//     skybox_color:       #rrggbb       fallback solid sky color when no skybox_url
//   }}
//
// Engine → parent contract:
//   {type: 'event', name: 'mechanic_ready'}  on iframe boot
//   {type: 'event', name: 'board_cleared'}   on survival win
//   {type: 'event', name: 'out_of_moves'}    on player fall
//   {type: 'state', op: 'set', path: ..., value: ...}  live state broadcast

(function () {
  'use strict';

  // ===================================================================== //
  // Wave-1 add-on hooks. Optional modules (skybox.js / lighting.js /       //
  // vfx.js) register handlers on window.FallSurvive; index.js calls them   //
  // at the marked HOOK_* sites. Engine works fine without any modules.     //
  //                                                                        //
  // Recognised handlers (all optional):                                    //
  //   setupSkybox(scene, cfg) → returns BABYLON.Mesh | null                //
  //     called after default skybox build + on each level_config receive   //
  //   setupTileLighting(tiles, scene, cfg) → void                          //
  //     called after buildTileMeshes — own per-tile material assignment    //
  //   updateTileLighting(dt, scene, gameState) → void                      //
  //     per-frame inside the game loop (PLAYING state only)                //
  //   onTileTelegraph(tile, scene) → void                                  //
  //     fired when a tile is first stepped on (fall countdown begins)      //
  //   onTileFall(tile, scene) → void                                       //
  //     fired when fall countdown expires and the tile starts dropping     //
  //   onSphereImpact(sphere, player, scene) → void                         //
  //     fired the frame a sphere collides with the player                  //
  //   onWin(scene) → void                                                  //
  //   onLose(scene) → void                                                 //
  //   updateVfx(dt, scene) → void  (per-frame, PLAYING state only)         //
  // ===================================================================== //
  window.FallSurvive = window.FallSurvive || {};
  const Hooks = window.FallSurvive;

  // ===================================================================== //
  // Postmessage helpers — mirrors suika-game shape.                        //
  // ===================================================================== //
  function postState(path, value) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: 'state', op: 'set', path, value }, '*');
    } catch (_) {}
  }
  function postEvent(name, payload) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: 'event', name, payload }, '*');
    } catch (_) {}
  }
  function broadcastInitialState() {
    if (!Game.levelConfig) return;
    const cfg = Game.levelConfig;
    postState('mechanic.survived_ms',       0);
    postState('mechanic.target_duration_ms', cfg.target_duration_ms || 0);
    postState('mechanic.tiles_remaining',   Game.tiles.filter(t => !t.fallen).length);
    postState('mechanic.tiles_total',       Game.tiles.length);
    postState('mechanic.waves_spawned',     0);
    postState('mechanic.wave_count',        cfg.wave_count || 0);
    postState('mechanic.player_alive',      true);
    postState('mechanic.bots_alive',        countAliveBots());
    postState('mechanic.bots_total',        Game.botsTotal);
  }

  function countAliveBots() {
    let n = 0;
    for (const a of Game.actors) {
      if (a.control === 'ai' && a.alive) n++;
    }
    return n;
  }

  // ===================================================================== //
  // Tunables. Open to a TUNE panel later — for the first playable these    //
  // are constants. Survival mechanic-specific feel knobs.                  //
  // ===================================================================== //
  const TUNING = {
    // Tile geometry
    tile_radius:          1.4,    // hexagon outer-radius (Babylon CreateCylinder diameter / 2)
    tile_height:          0.3,
    tile_spacing_factor:  1.732,  // sqrt(3) — gives hex-tight packing on flat-top hex grid

    // Player
    player_radius:        0.45,
    player_height:        1.6,
    move_speed:           6.0,    // units/sec along XZ
    jump_velocity:        7.5,    // upward impulse on jump
    gravity:              20.0,   // units/sec^2 downward

    // Rolling spheres
    sphere_radius:        0.6,
    sphere_speed:         5.0,    // units/sec
    sphere_knock_impulse: 12.0,   // upward+outward velocity imparted on hit

    // Tile-fall behavior — "step → wait → drop"
    tile_fall_velocity:   8.0,    // units/sec downward once dropping
    tile_kill_y:          -50.0,  // below this Y the tile is despawned (and player too) — must be below the lowest decorative layer

    // Camera
    camera_height:        14.0,
    camera_distance:      14.0,
    camera_lerp:          0.08,

    // Stacked platform layers below the active gameplay layer. ALL layers
    // are fallable — step-trigger fires on any layer the player stands on,
    // matching Fall-Guys hex-stack rounds. A player who falls through a
    // hole on the top layer lands on the layer below and the game continues
    // until either they survive the timer or they fall off every layer.
    layers_below_active:  3,
    layer_spacing:        10.5,

    // Default bot count (mirrors level_config.bot_count). 3 NPCs per round
    // gives the player visible competition without tanking framerate.
    bot_count:            3,
  };

  // Observer / sim mode. When observer_mode is true the engine boots into
  // a watch-only sim — all 5 characters spawn as bots, no player, camera
  // auto-orbits the platform center. Click-to-throw drops spheres on bots.
  // Knobs auto-discovered by the panel agent.
  Hooks.simConfig = Hooks.simConfig || {
    observer_mode: true,         // true = watch sim; false = play (1 player + bots)
    observer_actor_count: 5,     // characters spawned in observer mode (1..5)
    camera_auto_orbit_speed: 0.06,  // radians/sec — slow cinematic rotation
    click_throw_enabled: true,   // pointer-down spawns a falling sphere at the picked point
    click_throw_height: 18,      // Y above platform top where the thrown sphere spawns
    auto_restart_ms: 2500,       // delay between round end and auto-restart in observer mode
  };

  // Publish base tuning to actor.js so it can compute per-character stats.
  // Actor.js exposes setTuningBase as a no-throw setter; call it once at
  // boot so future spawnPlayer / spawnBot calls have the right base values.
  if (Hooks.actorFactory && Hooks.actorFactory.setTuningBase) {
    Hooks.actorFactory.setTuningBase({
      player_radius: TUNING.player_radius,
      player_height: TUNING.player_height,
      move_speed:    TUNING.move_speed,
      jump_velocity: TUNING.jump_velocity,
      gravity:       TUNING.gravity,
    });
  }

  // ===================================================================== //
  // Babylon scene setup. Pulled out so the live state (tiles, spheres,     //
  // player) can reset on level_config without rebuilding the whole engine. //
  // ===================================================================== //
  const canvas = document.getElementById('render-canvas');
  const engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = BABYLON.Color3.FromHexString('#1a2a44').toLinearSpace().toColor4();

  // Lights — one hemispheric for ambient + one directional for shading on
  // the cylinders / sphere geometry. No PBR, just StandardMaterial + diffuse.
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.7;
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -1.0, -0.6), scene);
  sun.intensity = 0.6;
  // Shadow-camera bounds — Babylon needs an explicit ortho hint for a
  // directional light, otherwise its auto-fit either scopes to the first
  // registered caster (one tile) or to world-bounds (texel-stretch + no
  // detail where it matters). Tuned to the platform footprint + a few
  // layers below.
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 120;
  sun.shadowOrthoScale = 0.5;

  // ===================================================================== //
  // WAVE-5 — ACES filmic tone mapping + exposure 1.05.                     //
  // Bumps vibrancy across the whole scene + keeps highlights from clipping //
  // flat. ImageProcessingConfiguration is part of Babylon core (no         //
  // post-process pipeline / dependency required). Capability-guarded since //
  // some software-GL backends lack the ACES path.                          //
  // ===================================================================== //
  Hooks.renderingConfig = Hooks.renderingConfig || {
    tonemap_enabled:  true,
    tonemap_exposure: 1.05,
    tonemap_contrast: 1.0,
  };
  Hooks.renderingConfigMeta = Hooks.renderingConfigMeta || {
    tonemap_exposure: { min: 0.1, max: 3.0, step: 0.05, label: 'Exposure' },
    tonemap_contrast: { min: 0.5, max: 2.0, step: 0.05, label: 'Contrast' },
  };
  try {
    const ipc = scene.imageProcessingConfiguration;
    if (ipc && BABYLON.ImageProcessingConfiguration) {
      ipc.toneMappingEnabled = !!Hooks.renderingConfig.tonemap_enabled;
      // ACES constant lives at BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES
      // in Babylon 6.x. If it's missing (very old build), the default tonemap
      // still renders, just less filmic.
      if (typeof BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES === 'number') {
        ipc.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
      }
      ipc.exposure = Hooks.renderingConfig.tonemap_exposure;
      ipc.contrast = Hooks.renderingConfig.tonemap_contrast;
    }
  } catch (e) {
    console.warn('[fall-survive] tone mapping unavailable, skipping:', e);
  }

  // ===================================================================== //
  // WAVE-5 — Shadow casting from the directional sun.                      //
  // Capability-guarded: software-GL backends (Playwright + swiftshader for //
  // _smoke_test.py) sometimes fail to compile the ESM blur shader; we wrap //
  // construction in try/catch and silently skip if the GL path rejects.   //
  //                                                                        //
  // Caster registration is reactive — instead of editing buildTileMeshes / //
  // actor.js / spawnSphere (sibling-module territory in this wave), we     //
  // observe scene.onNewMeshAddedObservable and register meshes by name     //
  // pattern. Cloud puffs and skybox are explicitly excluded.               //
  // ===================================================================== //
  Hooks.shadowConfig = Hooks.shadowConfig || {
    enabled: true,
    quality: 'medium',     // 'low' = 1024 / 'medium' = 2048 / 'high' = 4096
    softness: 0.5,         // 0..1 → blurKernel multiplier (0=8px, 1=64px)
  };
  Hooks.shadowConfigEnums = Hooks.shadowConfigEnums || {
    quality: ['low', 'medium', 'high'],
  };
  Hooks.shadowConfigMeta = Hooks.shadowConfigMeta || {
    softness: { min: 0, max: 1, step: 0.05, label: 'Shadow softness' },
  };

  function _shadowMapSize(q) {
    if (q === 'low')  return 1024;
    if (q === 'high') return 4096;
    return 2048;
  }
  let shadowGen = null;
  if (Hooks.shadowConfig.enabled && typeof BABYLON.ShadowGenerator === 'function') {
    try {
      shadowGen = new BABYLON.ShadowGenerator(_shadowMapSize(Hooks.shadowConfig.quality), sun);
      shadowGen.useBlurExponentialShadowMap = true;
      shadowGen.useKernelBlur = true;
      shadowGen.blurKernel = Math.max(8, Math.round(8 + 56 * Hooks.shadowConfig.softness));
      shadowGen.depthScale = 30;
      shadowGen.darkness = 0.35;     // 0=fully dark / 1=no shadow; 0.35 = soft + readable
    } catch (e) {
      console.warn('[fall-survive] ShadowGenerator unavailable (likely software GL):', e);
      shadowGen = null;
    }
  }
  // Expose for sibling modules. actor.js / vfx.js / cloud rig in effects.js
  // can do Hooks.shadowGen.addShadowCaster(mesh) in a future pass.
  Hooks.shadowGen = shadowGen;

  // Reactive caster/receiver registration. Pattern-match mesh names so we
  // cover tiles, wave spheres, thrown spheres, the player capsule, and bot
  // meshes without editing those modules. Cloud puffs ('candy_cloud_*'),
  // the skybox, weather/trail particles, etc. are excluded.
  if (shadowGen) {
    const SHADOW_NAME_RE = /^(tile_|sphere_|thrown_|player|actor_|bot_)/i;
    const NO_SHADOW_RE   = /^(skybox|candy_cloud_|trail|particle|weather_|effects_)/i;
    function _registerForShadow(mesh) {
      try {
        if (!mesh || !mesh.name) return;
        if (NO_SHADOW_RE.test(mesh.name)) return;
        if (!SHADOW_NAME_RE.test(mesh.name)) return;
        shadowGen.addShadowCaster(mesh, true);
        mesh.receiveShadows = true;
      } catch (_) { /* one bad mesh shouldn't break the rest */ }
    }
    scene.onNewMeshAddedObservable.add(_registerForShadow);
    // Catch meshes already created before we wired in (rare on first boot,
    // but level-config rebuilds will hit the observable above going forward).
    try { for (const m of scene.meshes) _registerForShadow(m); } catch (_) {}
  }

  // Camera — ArcRotate orbiting the player. Right-click drag to rotate; pan
  // disabled. Each frame we lerp `camera.target` toward the player so the
  // user-set alpha/beta/radius are preserved while the framing follows.
  const initialRadius = Math.hypot(TUNING.camera_distance, TUNING.camera_height);
  const camera = new BABYLON.ArcRotateCamera(
    'cam',
    -Math.PI / 2,        // alpha — looking from -Z toward origin
    Math.PI / 3.5,       // beta — angled down from above
    initialRadius,
    new BABYLON.Vector3(0, 0, 0),
    scene
  );
  camera.fov = 1.0;
  camera.attachControl(canvas, true);
  // Right-click only for rotation; pan + middle-click disabled.
  camera.inputs.attached.pointers.buttons = [2];
  camera.panningSensibility = 0;
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 50;
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;
  camera.wheelPrecision = 50;
  // Suppress the browser context menu so right-click drag isn't interrupted.
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ===================================================================== //
  // Procedural neutral materials. IP themes override these via             //
  // level_config-supplied texture URLs; absent fields keep these defaults  //
  // so the slice is fully playable without theme assets.                   //
  // ===================================================================== //
  function makeStandardMat(name, hex, opts = {}) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = BABYLON.Color3.FromHexString(hex);
    m.specularColor = new BABYLON.Color3(0.1, 0.1, 0.12);
    if (opts.emissive) m.emissiveColor = BABYLON.Color3.FromHexString(opts.emissive);
    return m;
  }

  // Tile materials — top/skirt are separate so IP textures can target the
  // visible top face while the skirt stays neutral (or the reverse).
  // Babylon's CreateCylinder accepts a multi-material via `faceUV`/`subMaterial`
  // pattern: we use two child materials assigned via faceColors → multiMaterial
  // for simplicity and re-create per-tile when texture is assigned.
  const baseTopMat   = makeStandardMat('tile_top_default',   '#7a90b8');
  const baseSkirtMat = makeStandardMat('tile_skirt_default', '#3e4a66');

  // Player / sphere defaults
  const playerMat = makeStandardMat('player_default', '#e85da8');
  const sphereMat = makeStandardMat('sphere_default', '#5dc8d8', { emissive: '#1a2a3a' });

  // Skybox — large box w/ inverted normals, gradient fallback or cubemap when
  // skybox_url is provided. For first playable: vertical-gradient via two
  // emissive colors painted as faceColors. Fall back to scene.clearColor.
  let skybox = null;
  function buildDefaultSkybox(topHex = '#5b7fb3', bottomHex = '#1a1a30') {
    if (skybox) { skybox.dispose(); skybox = null; }
    skybox = BABYLON.MeshBuilder.CreateBox('skybox', { size: 2000 }, scene);
    const mat = new BABYLON.StandardMaterial('skyboxMat', scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = BABYLON.Color3.FromHexString(topHex);
    skybox.material = mat;
    skybox.infiniteDistance = true;
    // Vertical gradient — a quick CanvasTexture painted top→bottom. Wraps the
    // box uniformly; close enough to a sky for the neutral pass.
    const tex = new BABYLON.DynamicTexture('skyGradient', { width: 4, height: 256 }, scene, false);
    const ctx = tex.getContext();
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, topHex);
    grad.addColorStop(1, bottomHex);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    tex.update();
    mat.emissiveTexture = tex;
  }
  buildDefaultSkybox();

  // Apply IP-supplied textures via level_config. URL absent → neutral default
  // is kept. Errors fall back silently to neutral.
  function applyIPTextures(cfg) {
    function loadTo(material, url) {
      if (!url) return;
      try {
        const tex = new BABYLON.Texture(url, scene);
        material.diffuseTexture = tex;
        material.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.4); // brighten so texture shows
      } catch (_) {}
    }
    loadTo(baseTopMat,   cfg.hex_top_url);
    loadTo(baseSkirtMat, cfg.platform_skirt_url);
    loadTo(playerMat,    cfg.player_skin_url);
    loadTo(sphereMat,    cfg.sphere_skin_url);
    if (cfg.skybox_url) {
      // Treat as a cubemap base path (.env, .dds) OR an equirect single image.
      // For zero asset gen this slot stays empty; if provided we attempt cube.
      try {
        const isEnv = /\.env$/i.test(cfg.skybox_url);
        if (isEnv) {
          if (skybox) { skybox.dispose(); skybox = null; }
          skybox = BABYLON.MeshBuilder.CreateBox('skybox', { size: 2000 }, scene);
          const mat = new BABYLON.StandardMaterial('skyboxMat', scene);
          mat.backFaceCulling = false;
          mat.disableLighting = true;
          mat.reflectionTexture = new BABYLON.CubeTexture(cfg.skybox_url, scene);
          mat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
          mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
          mat.specularColor = new BABYLON.Color3(0, 0, 0);
          skybox.material = mat;
          skybox.infiniteDistance = true;
        }
      } catch (_) {}
    } else if (cfg.skybox_color) {
      // Solid-color sky fallback (cheapest IP injection — just a hex).
      buildDefaultSkybox(cfg.skybox_color, '#0e0e14');
    }
    // HOOK_SKYBOX: a registered skybox module may dispose+replace.
    if (Hooks.setupSkybox) {
      try { if (skybox) { skybox.dispose(); skybox = null; } } catch (_) {}
      const replacement = Hooks.setupSkybox(scene, cfg);
      if (replacement) skybox = replacement;
    }
  }

  // ===================================================================== //
  // Hex grid generation. Flat-top hexagons in concentric rings.            //
  //   ring 0: 1 tile (center)                                              //
  //   ring N: 6N tiles                                                     //
  // Total for ring_count=N: 1 + 3N(N+1).                                   //
  // ===================================================================== //
  function generateHexGrid(ringCount, layerCount, layerSpacing) {
    // Axial-coordinate hex spiral. For pointy-top hexes:
    //   sqrt(3) horizontal spacing, 1.5 vertical spacing per ring step.
    //   axial → cartesian: x = sqrt(3) * (q + s/2), z = 1.5 * s   (× r)
    // The 6 axial directions traverse a ring of distance 1 from origin.
    // The standard spiral walk algorithm: start at direction[4] * ring,
    // then for each of the 6 sides walk `ring` steps along direction[i].
    //
    // We then duplicate the same axial layout at layerCount Y-stacked
    // layers (layer 0 is the active top, layers 1..N below it). All layers
    // are fallable — step-trigger fires on any layer.
    const r = TUNING.tile_radius;
    const dx = r * TUNING.tile_spacing_factor;
    const dz = r * 1.5;
    const dirs = [
      [+1,  0], [+1, -1], [ 0, -1],
      [-1,  0], [-1, +1], [ 0, +1],
    ];
    const axialPositions = [[0, 0]];
    for (let ring = 1; ring <= ringCount; ring++) {
      // Start at direction[4] * ring = (-ring, +ring) — the +s axial axis.
      let q = dirs[4][0] * ring;
      let s = dirs[4][1] * ring;
      for (let side = 0; side < 6; side++) {
        for (let step = 0; step < ring; step++) {
          axialPositions.push([q, s]);
          q += dirs[side][0];
          s += dirs[side][1];
        }
      }
    }
    const tiles = [];
    for (let layer = 0; layer < layerCount; layer++) {
      const y = -layer * layerSpacing;
      for (const [q, s] of axialPositions) {
        const x = dx * (q + s / 2);
        const z = dz * s;
        tiles.push({ x, y, z, q, s, layer, fallen: false, dropping: false, fallTimer: 0, mesh: null });
      }
    }
    return tiles;
  }

  // Build one cylinder mesh per tile. Each tile owns its own material clone
  // because tiles can drop independently and we may want per-tile fade later.
  function buildTileMeshes(tiles) {
    for (const t of tiles) {
      // Babylon's tessellation:6 cylinder produces vertices at 0°/60°/120°/...
      // (flat-top hex — vertices on ±X axis). The axial spacing in generateHexGrid
      // is the pointy-top convention (dx = sqrt(3)*r, dz = 1.5*r). Rotating the
      // mesh by π/6 (30°) converts vertex angles to 30°/90°/150°/... — pointy-top
      // — matching the spacing. Without this, hex corners overlap by ~0.38 units
      // → Z-fight flicker at tile borders.
      // Diameter scaled by 0.99 — a 1% gap that's visually invisible but
      // eliminates exact-coincidence Z-fighting at touching corners.
      const cyl = BABYLON.MeshBuilder.CreateCylinder(
        `tile_${t.layer}_${t.q}_${t.s}`,
        { tessellation: 6, height: TUNING.tile_height, diameter: TUNING.tile_radius * 2 * 0.99 },
        scene
      );
      cyl.rotation.y = Math.PI / 6;
      cyl.position.set(t.x, t.y, t.z);
      // Multi-material: top/bottom + side. Babylon auto-generates 3 submeshes
      // for a cylinder via subMeshes array on the mesh. We use a MultiMaterial
      // wrapping top + side cloned from the IP-shared base materials so each
      // tile has its own diffuse instance and we can per-tile-tint later.
      const topClone   = baseTopMat.clone(`top_${t.q}_${t.s}`);
      const skirtClone = baseSkirtMat.clone(`skirt_${t.q}_${t.s}`);
      const multi = new BABYLON.MultiMaterial(`mm_${t.q}_${t.s}`, scene);
      multi.subMaterials.push(topClone);   // submesh 0 = top cap
      multi.subMaterials.push(skirtClone); // submesh 1 = side
      multi.subMaterials.push(topClone);   // submesh 2 = bottom cap
      cyl.material = multi;
      // Babylon's default cylinder generates a single submesh — split it into
      // 3 by index range so the multi-material binding takes effect. We do
      // this conservatively: leave as single submesh but assign the diffuse
      // material directly; the side is the dominant visible surface from the
      // play camera anyway. Future polish: explicit submesh split.
      cyl.material = topClone;  // simpler fallback — single material per tile
      t.mesh = cyl;
      t.topMat = topClone;
      t.skirtMat = skirtClone;
    }
  }

  function disposeTileMeshes(tiles) {
    for (const t of tiles) {
      if (t.mesh) { try { t.mesh.dispose(); } catch (_) {} t.mesh = null; }
    }
  }


  // ===================================================================== //
  // Actors. Position-driven (no engine-physics body) — we own gravity +    //
  // jump + ground-sense ourselves so dependencies stay zero. Refactored    //
  // from a single hard-coded `player` mesh into Game.actors[] where        //
  // exactly one actor has control='input' (the player) and the rest have  //
  // control='ai' (bots). The actor-factory module (actor.js) builds the    //
  // mesh per character.visual.shape, resolves stats from character mults,  //
  // and runs the per-tag AI tick. See actor.js for the per-behavior logic. //
  //                                                                        //
  // Player Actor remains addressable as Game.player for camera follow +    //
  // state.set broadcasts. Bot Actors live alongside in Game.actors and     //
  // share the gravity / ground-sense / sphere-collision pipeline.          //
  // ===================================================================== //
  function buildActors(playerCharacterId, botCount, tilesForSpawn) {
    // Tear down any existing actors (idempotent across restarts).
    for (const a of Game.actors) {
      if (Hooks.actorFactory && Hooks.actorFactory.disposeActor) {
        Hooks.actorFactory.disposeActor(a);
      } else {
        try { a.mesh && a.mesh.dispose(); } catch (_) {}
      }
    }
    Game.actors.length = 0;
    Game.player = null;

    // Observer mode: spawn N characters as bots, no player. Pass a
    // "no-such-character" id to spawnBots so all 5 characters in the roster
    // are eligible (the filter excludes only the player's character).
    if (Hooks.simConfig && Hooks.simConfig.observer_mode) {
      const N = Math.max(1, Math.min(5, Hooks.simConfig.observer_actor_count || 5));
      if (Hooks.actorFactory && Hooks.actorFactory.spawnBots) {
        const sims = Hooks.actorFactory.spawnBots(scene, N, '__observer_no_player__', tilesForSpawn);
        for (const a of sims) Game.actors.push(a);
      }
      Game.botsTotal = Game.actors.filter(a => a.control === 'ai').length;
      return;
    }

    // Spawn the player Actor at platform center.
    if (Hooks.actorFactory && Hooks.actorFactory.spawnPlayer) {
      const p = Hooks.actorFactory.spawnPlayer(scene, playerCharacterId);
      p.mesh.position.set(0, 4, 0);
      Game.actors.push(p);
      Game.player = p;
    } else {
      // Defensive fallback: if actor.js failed to load, build a minimal
      // capsule directly so the engine still boots.
      const fallback = BABYLON.MeshBuilder.CreateCapsule('player', {
        radius: TUNING.player_radius, height: TUNING.player_height,
      }, scene);
      fallback.position.set(0, 4, 0);
      fallback.material = playerMat;
      Game.player = {
        id: 'player', character: 'sprinter', control: 'input',
        stats: { move_speed: TUNING.move_speed, jump_velocity: TUNING.jump_velocity,
                 gravity: TUNING.gravity, radius: TUNING.player_radius, height: TUNING.player_height },
        mesh: fallback, vy: 0, grounded: false, alive: true, survivedMs: 0, behavior: null,
      };
      Game.actors.push(Game.player);
    }

    // Spawn bots — random non-player characters at random non-center tiles.
    if (botCount > 0 && Hooks.actorFactory && Hooks.actorFactory.spawnBots) {
      const bots = Hooks.actorFactory.spawnBots(scene, botCount, playerCharacterId, tilesForSpawn);
      for (const b of bots) Game.actors.push(b);
    }
    Game.botsTotal = Game.actors.filter(a => a.control === 'ai').length;
  }

  // Look up the player's character — wave-3 character-select agent will
  // populate localStorage; today we default to 'sprinter'.
  function resolvePlayerCharacterId() {
    try {
      const fromLS = window.localStorage && window.localStorage.getItem('fallSurvive.playerCharacter');
      if (fromLS && typeof fromLS === 'string') return fromLS;
    } catch (_) {}
    return 'sprinter';
  }

  // ===================================================================== //
  // Sphere wave manager.                                                   //
  // ===================================================================== //
  const Spheres = []; // { mesh, vx, vz, vy }
  function spawnSphere(originX, originZ, dirX, dirZ) {
    const s = BABYLON.MeshBuilder.CreateSphere(`sphere_${performance.now() | 0}`, {
      diameter: TUNING.sphere_radius * 2,
      segments: 12,
    }, scene);
    // Spawn AT active-layer top height so the sphere flies in level toward
    // the platform. Gravity is gated by the `grounded` flag (set true on
    // first ground contact) — until the sphere touches a tile, it doesn't
    // fall. This avoids the spawn-then-fall-through-the-void-then-teleport
    // -onto-the-platform "blink" you'd otherwise see.
    const spawnY = TUNING.tile_height / 2 + TUNING.sphere_radius;
    s.position.set(originX, spawnY, originZ);
    s.material = sphereMat;
    const len = Math.hypot(dirX, dirZ) || 1;
    Spheres.push({
      mesh: s,
      vx: (dirX / len) * TUNING.sphere_speed,
      vz: (dirZ / len) * TUNING.sphere_speed,
      vy: 0,
      grounded: false,
    });
  }
  function disposeAllSpheres() {
    for (const s of Spheres) { try { s.mesh.dispose(); } catch (_) {} }
    Spheres.length = 0;
  }
  // Click-to-throw variant. Spawns a sphere mid-air above the picked point
  // and gravity-falls it immediately. The `thrown` flag bypasses the normal
  // "no gravity until first ground contact" gate — these spheres start in
  // the air on purpose, so we skip the perimeter-fly-in pattern.
  function spawnFallingSphere(x, z, fromY) {
    const s = BABYLON.MeshBuilder.CreateSphere(`thrown_${performance.now() | 0}`, {
      diameter: TUNING.sphere_radius * 2,
      segments: 12,
    }, scene);
    s.position.set(x, fromY, z);
    s.material = sphereMat;
    Spheres.push({
      mesh: s,
      vx: 0,
      vz: 0,
      vy: 0,
      grounded: false,
      thrown: true,  // gravity bypass
    });
  }
  // Spawn a wave: spheres_per_wave spheres around the platform, each aimed
  // at a randomized point near the center — guarantees they cross the play
  // surface.
  function spawnWave(spheresPerWave) {
    const platRadius = (Game.levelConfig.ring_count + 1) * TUNING.tile_radius * 1.7;
    const spawnRadius = platRadius + 6;
    for (let i = 0; i < spheresPerWave; i++) {
      const angle = (i / spheresPerWave) * Math.PI * 2 + Math.random() * 0.6;
      const sx = Math.cos(angle) * spawnRadius;
      const sz = Math.sin(angle) * spawnRadius;
      // Aim at a slightly randomized center point.
      const tx = (Math.random() - 0.5) * platRadius * 0.7;
      const tz = (Math.random() - 0.5) * platRadius * 0.7;
      spawnSphere(sx, sz, tx - sx, tz - sz);
    }
    Game.wavesSpawned++;
    postState('mechanic.waves_spawned', Game.wavesSpawned);
  }

  // ===================================================================== //
  // Ground sensing. Player feet check tile XZ proximity each frame; if no  //
  // tile under the feet (or that tile has fallen / is dropping past the    //
  // foot Y), gravity takes over. Step-on triggers tile-fall countdown.     //
  // ===================================================================== //
  function tileUnderXZ(x, z) {
    // Returns the closest non-fallen tile whose center is within tile_radius*0.95.
    let best = null;
    let bestD2 = (TUNING.tile_radius * 0.95) ** 2;
    for (const t of Game.tiles) {
      if (t.fallen) continue;
      const dx = x - t.x;
      const dz = z - t.mesh ? (t.mesh.position.z) : t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = t; }
    }
    return best;
  }
  // Note: the dz computation above had a precedence bug; recomputed cleanly.
  function tileUnderXZSafe(x, z) {
    let best = null;
    let bestD2 = (TUNING.tile_radius * 0.95) ** 2;
    for (const t of Game.tiles) {
      if (t.fallen) continue;
      const tx = t.mesh ? t.mesh.position.x : t.x;
      const tz = t.mesh ? t.mesh.position.z : t.z;
      const dx = x - tx;
      const dz = z - tz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = t; }
    }
    return best;
  }

  // Layered ground-sense. Returns the highest tile-top surface that's at or
  // below the player's foot (with a small slack so first-snap on landing
  // works) across all layers. When the player has fallen past every layer
  // in XZ proximity, returns { topY: -Infinity, tile: null } and gravity
  // continues unimpeded.
  function groundSenseUnderXZ(x, z, playerFootY) {
    const radSq = (TUNING.tile_radius * 0.95) ** 2;
    const ySlack = 0.5;
    let bestTopY = -Infinity;
    let bestTile = null;
    for (const t of Game.tiles) {
      if (t.fallen) continue;
      const tx = t.mesh ? t.mesh.position.x : t.x;
      const tz = t.mesh ? t.mesh.position.z : t.z;
      if ((x - tx) ** 2 + (z - tz) ** 2 < radSq) {
        const topY = (t.mesh ? t.mesh.position.y : t.y) + TUNING.tile_height / 2;
        if (topY <= playerFootY + ySlack && topY > bestTopY) {
          bestTopY = topY;
          bestTile = t;
        }
      }
    }
    return { topY: bestTopY, tile: bestTile };
  }

  // ===================================================================== //
  // Game state machine.                                                    //
  // ===================================================================== //
  const States = { BOOT: 0, READY: 1, PLAYING: 2, DONE: 3 };

  const Game = {
    stateIndex: States.BOOT,
    levelConfig: null,
    tiles: [],
    survivedMs: 0,
    wavesSpawned: 0,
    waveTimer: 0,
    keysPressed: { w: false, a: false, s: false, d: false, space: false },
    // Wave-2 Actor refactor: actors[] holds the player + bots; player is
    // a special-case actor with control='input' kept addressable as
    // Game.player for camera follow + player-specific state.set broadcasts.
    // Per-actor velocity (vy) and grounded flags now live on the actor;
    // index.js no longer owns Game.playerVelocity.
    actors: [],
    player: null,
    botsTotal: 0,
    won: false,
    lost: false,

    startPlay(cfg) {
      // Reset world state to a fresh round driven by cfg.
      Game.levelConfig = cfg;
      Game.survivedMs = 0;
      Game.wavesSpawned = 0;
      Game.waveTimer = 0;
      Game.won = false;
      Game.lost = false;

      // Tear down + rebuild tiles for the requested ring_count. All layers
      // are fallable — `layers_below_active` controls how many extra layers
      // sit beneath the top one.
      disposeTileMeshes(Game.tiles);
      Game.tiles = generateHexGrid(
        cfg.ring_count || 2,
        1 + TUNING.layers_below_active,
        TUNING.layer_spacing
      );
      buildTileMeshes(Game.tiles);
      // HOOK_LIGHTING_SETUP: lighting module may decorate tile materials.
      if (Hooks.setupTileLighting) Hooks.setupTileLighting(Game.tiles, scene, cfg);
      // QA-debug: expose tile coords for headless probes (harmless in prod).
      try {
        window.__fall_survive_tiles = Game.tiles.map(t => ({q: t.q, s: t.s, x: t.x, z: t.z}));
      } catch (_) {}

      // Apply IP textures (no-op for absent fields).
      applyIPTextures(cfg);

      // Spawn actors — player at center + N bots at random non-center tiles.
      // Player character is read from localStorage (wave-3 select agent
      // writes it) with a sensible 'sprinter' default. Bot count comes from
      // level_config.bot_count, falling back to TUNING.bot_count (default 3).
      const playerCharId = resolvePlayerCharacterId();
      const botCount = (cfg.bot_count != null) ? cfg.bot_count : TUNING.bot_count;
      buildActors(playerCharId, botCount, Game.tiles);

      // Clear leftover spheres.
      disposeAllSpheres();

      // Update HUD strings.
      const objText = cfg.objective_text || `Survive ${Math.round((cfg.target_duration_ms || 0) / 1000)}s`;
      const objEl = document.getElementById('hud-objective');
      if (objEl) objEl.innerText = objText;

      // Hide end-banner if we're restarting from a previous round.
      const banner = document.getElementById('end-banner');
      if (banner) banner.classList.remove('visible', 'lose');

      // Initial state burst — host renders correct values before the first
      // frame of physics integrates.
      broadcastInitialState();

      Game.stateIndex = States.PLAYING;
    },

    win() {
      if (Game.won || Game.lost) return;
      Game.won = true;
      Game.stateIndex = States.DONE;
      // HOOK_VFX_WIN
      if (Hooks.onWin) try { Hooks.onWin(scene); } catch (_) {}
      // Standalone end-banner.
      const banner = document.getElementById('end-banner');
      const title = document.getElementById('end-title');
      const detail = document.getElementById('end-detail');
      if (banner && title && detail) {
        title.innerText = 'SURVIVED!';
        detail.innerText = `You outlasted the round (${(Game.survivedMs / 1000).toFixed(1)}s).`;
        banner.classList.add('visible');
        banner.classList.remove('lose');
      }
      postState('mechanic.player_alive', true);
      postEvent('board_cleared', {
        survived_ms: Game.survivedMs,
        target_duration_ms: (Game.levelConfig && Game.levelConfig.target_duration_ms) || 0,
        waves_survived: Game.wavesSpawned,
        wave_count: (Game.levelConfig && Game.levelConfig.wave_count) || 0,
        objectives_met: true,
      });
      // Star payload for host-side score formula (mirrors suika postToHost).
      postState('session.last_level_score', Math.round(Game.survivedMs / 100));
      postState('session.last_level_stars', 1);
      window.parent && window.parent.postMessage({
        type: 'state', op: 'increment', path: 'player.stars', by: 1
      }, '*');
    },

    lose() {
      if (Game.won || Game.lost) return;
      Game.lost = true;
      Game.stateIndex = States.DONE;
      // HOOK_VFX_LOSE
      if (Hooks.onLose) try { Hooks.onLose(scene); } catch (_) {}
      const banner = document.getElementById('end-banner');
      const title = document.getElementById('end-title');
      const detail = document.getElementById('end-detail');
      if (banner && title && detail) {
        title.innerText = 'YOU FELL!';
        detail.innerText = `You survived ${(Game.survivedMs / 1000).toFixed(1)}s.`;
        banner.classList.add('visible', 'lose');
      }
      postState('mechanic.player_alive', false);
      postEvent('out_of_moves', {
        survived_ms: Game.survivedMs,
        target_duration_ms: (Game.levelConfig && Game.levelConfig.target_duration_ms) || 0,
        waves_survived: Game.wavesSpawned,
        objectives_met: false,
      });
      postState('session.last_level_score', Math.round(Game.survivedMs / 100));
      postState('session.last_level_stars', 0);
    },
  };

  // ===================================================================== //
  // Input. WASD for XZ movement + space for jump. Camera-relative motion.  //
  // ===================================================================== //
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'KeyW') Game.keysPressed.w = true;
    else if (e.code === 'KeyA') Game.keysPressed.a = true;
    else if (e.code === 'KeyS') Game.keysPressed.s = true;
    else if (e.code === 'KeyD') Game.keysPressed.d = true;
    else if (e.code === 'Space') {
      Game.keysPressed.space = true;
      // Jump only if grounded — handled in update().
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') Game.keysPressed.w = false;
    else if (e.code === 'KeyA') Game.keysPressed.a = false;
    else if (e.code === 'KeyS') Game.keysPressed.s = false;
    else if (e.code === 'KeyD') Game.keysPressed.d = false;
    else if (e.code === 'Space') Game.keysPressed.space = false;
  });

  // ===================================================================== //
  // Frame update. Driven by the Babylon RAF loop via scene.onBeforeRender. //
  // ===================================================================== //
  let lastFrameMs = performance.now();
  scene.registerBeforeRender(() => {
    const nowMs = performance.now();
    const dtMs = Math.min(50, nowMs - lastFrameMs);
    lastFrameMs = nowMs;
    const dt = dtMs / 1000;

    // FPS pill update.
    const fpsEl = document.getElementById('hud-fps');
    if (fpsEl) fpsEl.innerText = `${engine.getFps().toFixed(0)} fps`;

    if (Game.stateIndex !== States.PLAYING) return;
    // Observer mode boots without Game.player — all actors are bots. The
    // player ref is kept null and downstream camera-follow + win/lose
    // checks branch on its absence. In play mode (observer_mode=false) the
    // player is required and the engine pauses if it's missing.
    const observerMode = !!(Hooks.simConfig && Hooks.simConfig.observer_mode);
    if (!observerMode && (!Game.player || !Game.player.mesh)) return;
    const player = Game.player ? Game.player.mesh : null;

    Game.survivedMs += dtMs;
    postState('mechanic.survived_ms', Math.round(Game.survivedMs));

    // ---------- Per-actor motion + gravity + ground-sense ----------------
    // Actor pipeline: for each alive actor, compute XZ intent (input for
    // the player, AI intent vector for bots), apply XZ motion at the
    // actor's stat.move_speed, then run shared gravity + ground-sense +
    // jump + tile-step trigger using per-actor stats. Player and bots
    // step-trigger tiles identically — bots cause tile drops just like
    // the player does.
    //
    // Approximate platform radius for AI behaviors (cautious / reckless /
    // edge_walker need an outward sense). We compute once per frame and
    // pass into the AI tick via gameApi. Layer-0 tile bounds give the
    // active platform footprint.
    let platformRadius = 6;
    let activeLayerY = 0;
    {
      let maxR = 0;
      let activeYSum = 0, activeYCount = 0;
      for (const t of Game.tiles) {
        if (t.layer !== 0 || t.fallen) continue;
        const r = Math.hypot(t.x, t.z);
        if (r > maxR) maxR = r;
        const ty = t.mesh ? t.mesh.position.y : t.y;
        activeYSum += ty + TUNING.tile_height / 2;
        activeYCount++;
      }
      if (maxR > 0) platformRadius = maxR + TUNING.tile_radius;
      if (activeYCount > 0) activeLayerY = activeYSum / activeYCount;
    }

    const aiGameApi = {
      tiles: Game.tiles,
      spheres: Spheres,
      platformRadius,
      activeLayerY,
    };

    for (const actor of Game.actors) {
      if (!actor.alive || !actor.mesh) continue;
      const stats = actor.stats;

      // ---- Compute XZ intent ----
      let mx = 0, mz = 0;
      let wantsJump = false;
      if (actor.control === 'input') {
        // Camera-relative input: W is "away from camera," AD strafe right/left,
        // S walks back toward camera. Resolve via the camera's projected
        // forward + right vectors so input feels right at any orbit angle.
        let inForward = 0, inRight = 0;
        if (Game.keysPressed.w) inForward += 1;
        if (Game.keysPressed.s) inForward -= 1;
        if (Game.keysPressed.a) inRight -= 1;
        if (Game.keysPressed.d) inRight += 1;
        if (inForward !== 0 || inRight !== 0) {
          const camFwd = camera.getDirection(BABYLON.Axis.Z);
          const camRgt = camera.getDirection(BABYLON.Axis.X);
          let fX = camFwd.x, fZ = camFwd.z;
          let rX = camRgt.x, rZ = camRgt.z;
          const fLen = Math.hypot(fX, fZ) || 1;
          const rLen = Math.hypot(rX, rZ) || 1;
          fX /= fLen; fZ /= fLen;
          rX /= rLen; rZ /= rLen;
          mx = inForward * fX + inRight * rX;
          mz = inForward * fZ + inRight * rZ;
          // Diagonals shouldn't exceed unit speed.
          const mLen = Math.hypot(mx, mz);
          if (mLen > 1) { mx /= mLen; mz /= mLen; }
        }
        wantsJump = !!Game.keysPressed.space;
      } else if (actor.control === 'ai' && Hooks.actorFactory && Hooks.actorFactory.tickAi) {
        Hooks.actorFactory.tickAi(actor, dt, aiGameApi);
        const intent = Hooks.actorFactory.getIntent(actor);
        mx = intent.x; mz = intent.z; wantsJump = intent.jump;
      }
      if (mx !== 0 || mz !== 0) {
        const len = Math.hypot(mx, mz) || 1;
        mx /= len; mz /= len;
        actor.mesh.position.x += mx * stats.move_speed * dt;
        actor.mesh.position.z += mz * stats.move_speed * dt;
      }

      // ---- Gravity + ground-sense + step-trigger + jump ----
      const feetX = actor.mesh.position.x;
      const feetZ = actor.mesh.position.z;
      const footY = actor.mesh.position.y - stats.height / 2;
      const ground = groundSenseUnderXZ(feetX, feetZ, footY);

      let grounded = false;
      if (ground.topY > -Infinity && Math.abs(footY - ground.topY) < 0.25 && actor.vy <= 0) {
        actor.mesh.position.y = ground.topY + stats.height / 2;
        actor.vy = 0;
        grounded = true;
        // Step trigger — any actor stepping on a non-dropping tile starts
        // the fall countdown. Identical for player + bots.
        if (ground.tile && !ground.tile.dropping) {
          ground.tile.dropping = true;
          ground.tile.fallTimer = (Game.levelConfig.tile_fall_delay_ms || 800) / 1000;
          // Wave-5 item 3 — start the heat-up at stage 0 (white). The per-
          // frame countdown loop below ramps through stages 1..3 as the
          // timer ticks. We seed _heatStage = -1 so the first stage-0
          // assignment registers as a transition (avoids skipping the
          // initial color set when fallTimer === fall_delay). Lighting
          // owns emissive (it pauses on dropping); we only ever touch
          // diffuseColor here.
          ground.tile._heatStage = -1;
          if (Hooks.onTileTelegraph) try { Hooks.onTileTelegraph(ground.tile, scene); } catch (_) {}
        }
      }
      actor.grounded = grounded;

      if (grounded && wantsJump) {
        actor.vy = stats.jump_velocity;
        grounded = false;
        // Bot AI: consume the jump intent so it doesn't auto-rejump every
        // frame until the next decision tick.
        if (actor.control === 'ai' && Hooks.actorFactory && Hooks.actorFactory.consumeJump) {
          Hooks.actorFactory.consumeJump(actor);
        }
      }

      if (!grounded) {
        actor.vy -= stats.gravity * dt;
        actor.mesh.position.y += actor.vy * dt;
      }
    }

    // ---------- Tile fall integration -----------------------------------
    // Wave-5 items 3+4 — 4-stage heat-up + bigger stage-3 pulse. The single
    // red-tint telegraph from wave-1 is replaced with white → yellow →
    // orange → red as the countdown progresses. Lighting agent's
    // pause_emissive_on_telegraph already silences the emissive wave on
    // dropping tiles, so this diffuse ramp reads cleanly without fighting
    // a glowing base color. Only set diffuseColor on stage transitions to
    // avoid material churn (Babylon allocates a new color each frame would
    // otherwise be wasteful). Stage-3 also wobbles scale + rotation.z.
    const TILE_HEAT_COLORS = ['#ffffff', '#ffd966', '#ff8a3d', '#ff3f3f'];
    const fallDelaySec = (Game.levelConfig.tile_fall_delay_ms || 800) / 1000;
    let tilesRemaining = 0;
    for (const t of Game.tiles) {
      if (t.fallen) continue;
      tilesRemaining++;
      if (t.dropping) {
        if (t.fallTimer > 0) {
          t.fallTimer -= dt;
          // 4-stage heat ramp — clamp the elapsed-fraction into 4 buckets.
          // The Math.min clamp protects against fallTimer going slightly
          // negative the same frame we crossed zero.
          const elapsedFrac = 1 - Math.max(0, t.fallTimer) / fallDelaySec;
          const heatStage = Math.min(3, Math.max(0, Math.floor(elapsedFrac * 4)));
          if (heatStage !== t._heatStage) {
            t._heatStage = heatStage;
            if (t.topMat) {
              t.topMat.diffuseColor = BABYLON.Color3.FromHexString(TILE_HEAT_COLORS[heatStage]);
            }
          }
          // Telegraph wobble — small Y bob around the tile's resting Y while
          // waiting to drop. Uses t.y as the rest position so wobble works
          // for tiles on any layer (active OR layers below).
          if (t.mesh) {
            t.mesh.position.y = t.y + Math.sin(performance.now() / 60) * 0.04;
            // Stage-3 (red, about-to-drop) — bigger pulse: scale + slight
            // tilt. The frequencies (22 / 18 / 24 rad/s) are intentionally
            // co-prime-ish so the wobble doesn't read as periodic. Stage
            // 0..2 keep the mesh at neutral scale/rotation.
            if (heatStage >= 3) {
              const phase = performance.now() / 1000;
              const sx = 1 + Math.sin(phase * 22) * 0.06;
              const sy = 1 + Math.sin(phase * 18) * 0.08;
              t.mesh.scaling.set(sx, sy, sx);
              t.mesh.rotation.z = Math.sin(phase * 24) * 0.04;
            } else if (t._wasHotPulsing) {
              // Defensive — if heatStage drops back below 3 (shouldn't
              // happen with monotonic countdown, but a host-tweaked
              // fall_delay during a round could) reset the wobble.
              t.mesh.scaling.set(1, 1, 1);
              t.mesh.rotation.z = 0;
            }
            t._wasHotPulsing = (heatStage >= 3);
          }
        } else {
          // Actively falling. HOOK_VFX_FALL fires once on the transition
          // from telegraph → falling (via the t._falling latch). Reset the
          // stage-3 pulse so the falling tile's mesh isn't wobbling on the
          // way down — vfx particle systems own the visual punctuation
          // from this point.
          if (!t._falling) {
            t._falling = true;
            if (t.mesh) {
              t.mesh.scaling.set(1, 1, 1);
              t.mesh.rotation.z = 0;
            }
            t._wasHotPulsing = false;
            if (Hooks.onTileFall) try { Hooks.onTileFall(t, scene); } catch (_) {}
          }
          if (t.mesh) {
            t.mesh.position.y -= TUNING.tile_fall_velocity * dt;
            if (t.mesh.position.y < TUNING.tile_kill_y) {
              t.fallen = true;
              try { t.mesh.dispose(); } catch (_) {}
              t.mesh = null;
            }
          }
        }
      }
    }
    postState('mechanic.tiles_remaining', tilesRemaining);

    // ---------- Sphere kinematics + collision ---------------------------
    for (let i = Spheres.length - 1; i >= 0; i--) {
      const s = Spheres[i];
      // Apply gravity ONLY after first ground contact (or immediately if the
      // sphere was thrown from above via click-to-throw). Wave spheres fly in
      // level from the perimeter so they don't fall through the void; thrown
      // spheres start in the air on purpose so they bypass that gate.
      if (s.grounded || s.thrown) s.vy -= TUNING.gravity * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      // Find tile under the sphere — clamp to top if grounded.
      const sTile = tileUnderXZSafe(s.mesh.position.x, s.mesh.position.z);
      const sTileTopY = sTile && sTile.mesh ? (sTile.mesh.position.y + TUNING.tile_height / 2) : -Infinity;
      const sFootY = s.mesh.position.y - TUNING.sphere_radius;
      if (sTile && !sTile.fallen && sFootY < sTileTopY + 0.05 && s.vy <= 0) {
        s.mesh.position.y = sTileTopY + TUNING.sphere_radius;
        s.vy = 0;
        s.grounded = true;
      } else {
        s.mesh.position.y += s.vy * dt;
      }
      // Sphere-vs-actor collision — fires for ANY alive actor (player +
      // bots). Each actor uses its own stat.radius / stat.height for the
      // collision check. The HOOK_VFX_SPHERE call now passes the actor's
      // mesh as the second arg (generalized from player-only); vfx.js
      // already accepts a single-mesh ref so the meaning shifts but the
      // API doesn't change.
      for (const actor of Game.actors) {
        if (!actor.alive || !actor.mesh) continue;
        const am = actor.mesh;
        const ar = actor.stats.radius;
        const ah = actor.stats.height;
        const dx = s.mesh.position.x - am.position.x;
        const dz = s.mesh.position.z - am.position.z;
        const dy = s.mesh.position.y - am.position.y;
        const horizD2 = dx * dx + dz * dz;
        const collideR = TUNING.sphere_radius + ar;
        if (horizD2 < collideR * collideR && Math.abs(dy) < ah / 2 + TUNING.sphere_radius) {
          const horizD = Math.sqrt(horizD2) || 1;
          const nx = -dx / horizD, nz = -dz / horizD;
          am.position.x += nx * 0.4;
          am.position.z += nz * 0.4;
          actor.vy = TUNING.sphere_knock_impulse * 0.5;
          // HOOK_VFX_SPHERE — fires for any actor hit; second arg is the
          // actor's mesh so the VFX module can read .position consistently.
          if (Hooks.onSphereImpact) try { Hooks.onSphereImpact(s, am, scene); } catch (_) {}
        }
      }
      // Despawn spheres that have fallen off the world.
      if (s.mesh.position.y < TUNING.tile_kill_y) {
        try { s.mesh.dispose(); } catch (_) {}
        Spheres.splice(i, 1);
      }
    }

    // ---------- Wave spawning -------------------------------------------
    if (Game.wavesSpawned < (Game.levelConfig.wave_count || 0)) {
      Game.waveTimer += dtMs;
      const interval = Game.levelConfig.wave_interval_ms || 4000;
      if (Game.waveTimer >= interval) {
        spawnWave(Game.levelConfig.spheres_per_wave || 3);
        Game.waveTimer = 0;
      }
    }

    // ---------- Camera follow -------------------------------------------
    // In play mode: lerp orbit target toward the PLAYER actor's mesh.
    // In observer mode: lerp toward platform center, optionally auto-orbit.
    // User-controlled alpha/beta/radius are preserved either way because we
    // only mutate camera.target (and alpha for auto-orbit), not setTarget().
    if (player) {
      camera.target.x += (player.position.x - camera.target.x) * TUNING.camera_lerp;
      camera.target.y += (player.position.y - camera.target.y) * TUNING.camera_lerp;
      camera.target.z += (player.position.z - camera.target.z) * TUNING.camera_lerp;
    } else {
      // Observer: target glides toward platform-center elevation
      camera.target.x += (0 - camera.target.x) * TUNING.camera_lerp;
      camera.target.y += (1.5 - camera.target.y) * TUNING.camera_lerp;
      camera.target.z += (0 - camera.target.z) * TUNING.camera_lerp;
      const orbitSpeed = (Hooks.simConfig && Hooks.simConfig.camera_auto_orbit_speed) || 0;
      if (orbitSpeed) camera.alpha += orbitSpeed * dt;
    }

    // ---------- Bot death checks ---------------------------------------
    // Bots that fell past kill_y are disposed and their alive flag flipped.
    // bots_alive is broadcast on each transition (cheap because actor count
    // is small).
    let botsAliveChanged = false;
    for (const actor of Game.actors) {
      if (actor.control !== 'ai' || !actor.alive || !actor.mesh) continue;
      if (actor.mesh.position.y < TUNING.tile_kill_y) {
        if (Hooks.actorFactory && Hooks.actorFactory.disposeActor) {
          Hooks.actorFactory.disposeActor(actor);
        } else {
          try { actor.mesh.dispose(); } catch (_) {}
          actor.mesh = null;
          actor.alive = false;
        }
        botsAliveChanged = true;
      }
    }
    if (botsAliveChanged) {
      postState('mechanic.bots_alive', countAliveBots());
    }

    // HOOK_LIGHTING_UPDATE + HOOK_VFX_UPDATE
    if (Hooks.updateTileLighting) try { Hooks.updateTileLighting(dt, scene, Game); } catch (_) {}
    if (Hooks.updateVfx)          try { Hooks.updateVfx(dt, scene); } catch (_) {}

    // ---------- Win/lose condition checks -------------------------------
    // Play mode: lose fires only when the PLAYER falls past kill_y.
    // Observer mode: lose fires when ALL actors are dead (no characters
    // left to watch). Win fires on timer expiry in both modes.
    if (player) {
      if (player.position.y < TUNING.tile_kill_y) {
        Game.lose();
        return;
      }
    } else {
      const aliveCount = countAliveBots();
      if (aliveCount === 0 && Game.actors.length > 0) {
        Game.lose();
        return;
      }
    }
    const target = Game.levelConfig.target_duration_ms || 30000;
    if (Game.survivedMs >= target) {
      Game.win();
      return;
    }
    // HUD survived pill update (standalone-only).
    const survEl = document.getElementById('hud-survived');
    if (survEl) survEl.innerText = `${(Game.survivedMs / 1000).toFixed(1)}s / ${(target / 1000).toFixed(0)}s`;
  });

  // ===================================================================== //
  // postMessage handler — host → engine level_config.                      //
  // ===================================================================== //
  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'level_config' && msg.payload) {
      Game.startPlay(msg.payload);
    }
  });

  // ===================================================================== //
  // Debug AUTOWIN — bottom-right button + backtick toggle. Standalone only.//
  // ===================================================================== //
  const debugBtn = document.getElementById('debug-autowin');
  if (debugBtn) {
    debugBtn.addEventListener('click', () => {
      if (Game.won || Game.lost) return;
      Game.win();
    });
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.key === '`' || ev.key === '~' || ev.code === 'Backquote') {
      if (debugBtn) debugBtn.classList.toggle('visible');
    }
  });

  // Retry button on end-banner — standalone-only convenience.
  const retryBtn = document.getElementById('end-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (Game.levelConfig) Game.startPlay(Game.levelConfig);
    });
  }

  // Click-to-throw (observer mode + opt-in for play mode). Left-click on the
  // canvas raycasts to the picked world point and spawns a sphere falling
  // from above it — useful for messing with the sim from the panel-watcher
  // POV. Right-click is reserved for the ArcRotate orbit drag, untouched.
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const cfg = Hooks.simConfig;
    if (!cfg || !cfg.click_throw_enabled) return;
    if (Game.stateIndex !== States.PLAYING) return;
    const pickInfo = scene.pick(scene.pointerX, scene.pointerY);
    if (!pickInfo || !pickInfo.hit || !pickInfo.pickedPoint) return;
    const p = pickInfo.pickedPoint;
    const fromY = (cfg.click_throw_height || 18);
    spawnFallingSphere(p.x, p.z, fromY);
  });

  // Observer-mode boot orchestration: skip the select screen (which select.js
  // shows on DOMContentLoaded) and auto-restart on round-end so the sim
  // loops continuously. We poll briefly for select.js to render its DOM,
  // then hide it; idempotent so it's safe even if select.js never loads.
  function applyObserverModeUI() {
    if (!Hooks.simConfig || !Hooks.simConfig.observer_mode) return;
    const sel = document.getElementById('select-screen');
    if (sel) {
      sel.style.display = 'none';
      sel.classList.add('hidden');
    }
  }
  // Apply once on DOMContentLoaded and again 200ms later (covers select.js's
  // own deferred show) — both no-ops if not in observer mode.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyObserverModeUI);
  } else {
    applyObserverModeUI();
  }
  setTimeout(applyObserverModeUI, 200);

  // Auto-restart on round end in observer mode — patches Game.win/lose so the
  // sim loops without requiring the retry click.
  const _origWin = Game.win.bind(Game);
  const _origLose = Game.lose.bind(Game);
  function maybeAutoRestart() {
    if (!Hooks.simConfig || !Hooks.simConfig.observer_mode) return;
    const delay = Hooks.simConfig.auto_restart_ms || 2500;
    setTimeout(() => {
      if (!Game.levelConfig) return;
      // Hide end-banner before restarting so it doesn't linger over the new round.
      const banner = document.getElementById('end-banner');
      if (banner) banner.classList.remove('visible', 'lose');
      // Hide select screen if select.js's retry-intercept showed it.
      applyObserverModeUI();
      Game.startPlay(Game.levelConfig);
    }, delay);
  }
  Game.win = function () { _origWin(); maybeAutoRestart(); };
  Game.lose = function () { _origLose(); maybeAutoRestart(); };

  // ===================================================================== //
  // Engine boot — start the render loop, fire mechanic_ready, fall back to //
  // a generic standalone config if no level_config arrives in 800 ms.      //
  // ===================================================================== //
  // Expose engine internals to wave-3+ add-on modules (effects.js, panel.js,
  // weather.js etc.) — they need scene/camera/Game refs to wire camera shake,
  // particle systems, trails reading from Game.actors, and panel knob discovery.
  // The Hooks registry above is for index.js → module callbacks; this is for
  // module → engine read access. Use sparingly; prefer the hook contract for
  // event-driven coupling.
  Hooks.engine = {
    scene,
    camera,
    Game,
    TUNING,
  };

  engine.runRenderLoop(() => {
    if (scene.activeCamera) scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  // Tell the parent we're alive so it can postMessage level_config.
  postEvent('mechanic_ready', { engine: 'fall-survive', version: '1.0' });

  // Standalone-iframe fallback config — boots a playable round if no host
  // injects a level_config within 800 ms. Keeps the engine independently
  // testable + previewable.
  setTimeout(() => {
    if (Game.stateIndex === States.BOOT) {
      Game.startPlay({
        level: 1,
        target_duration_ms: 25000,
        wave_count: 4,
        wave_interval_ms: 5000,
        spheres_per_wave: 3,
        tile_fall_delay_ms: 800,
        ring_count: 4,
        objective_text: 'Survive 25 seconds',
      });
    }
  }, 800);

  // Audio: TODO — upstream uses .mp3 for soundtrack/endgame/sphere1/sphere2.
  // We skip silently per PORT_BRIEF; mechanic.json#audio_todo flags this.
})();
