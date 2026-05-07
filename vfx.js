// engines/fall-survive/mechanic/vfx.js
//
// Wave-1 VFX bucket for the fall-survive engine slice. Registers handlers on
// window.FallSurvive that index.js's HOOK_VFX_* sites call. See VFX_NOTES.md
// for per-moment intent blocks (trigger / recurrence / ux_message /
// narrative_role).
//
// Five moments shipped — all use BABYLON.ParticleSystem (CPU) so the headless
// software-GL smoke test stays green. Calibration:
//   tile_telegraph  — subtlest (recurring, one-shot per tile, dust puff)
//   tile_fall       — mid-low (one per tile lifetime, debris drop)
//   sphere_impact   — mid (every-occurrence, contact sparks)
//   win             — loudest (sustained celebratory burst, 2-3s)
//   lose            — short sharp punctuation
//
// All emitters are world-space, never screen-space; never mutate tile.topMat
// (lighting agent owns tile materials); never override knock-back motion (we
// add visual punctuation, not gameplay feel).
//
// Tunable knobs live at window.FallSurvive.vfxConfig — host can override per
// level via level_config.payload.vfx merge.

(function () {
  'use strict';

  window.FallSurvive = window.FallSurvive || {};
  const FS = window.FallSurvive;

  // ===================================================================== //
  // vfxConfig — tunable knobs. CLI iteration: edit a hex / int / float and //
  // refresh the browser. Host can override any nested field by sending     //
  // level_config.payload.vfx; we merge in setupVfxLevel() below.           //
  // ===================================================================== //
  FS.vfxConfig = FS.vfxConfig || {
    tile_telegraph: {
      enabled:     true,
      count:       12,         // emitter capacity (CPU); single burst per call
      emitRate:    60,         // particles/sec
      burstMs:     180,        // emitter on for this long, then stops
      lifeMin:     0.30,
      lifeMax:     0.65,
      sizeMin:     0.05,
      sizeMax:     0.18,
      color1:      '#d4c5a8',  // beige dust
      color2:      '#8a7a60',  // dustier beige
      gravityY:     2.5,        // positive = floats up, dust-cloud feel
      spreadXZ:    0.55,       // outward velocity range
      velUp:       0.85,
      cleanupMs:   900,
    },
    tile_fall: {
      enabled:     true,
      count:       24,
      emitRate:    140,
      burstMs:     220,
      lifeMin:     0.55,
      lifeMax:     0.90,
      sizeMin:     0.08,
      sizeMax:     0.26,
      color1:      '#5a5048',  // charcoal/rock fragment
      color2:      '#2a261f',  // darker debris
      gravityY:    -8.0,        // negative = falls — debris drops with the tile
      spreadXZ:    1.4,
      velDown:     1.2,
      velUpBias:   0.8,        // small initial puff up before gravity wins
      cleanupMs:   1200,
    },
    sphere_impact: {
      enabled:     true,
      count:       18,
      emitRate:    220,
      burstMs:     90,         // sharp burst — physical hit, not lingering
      lifeMin:     0.18,
      lifeMax:     0.45,
      sizeMin:     0.06,
      sizeMax:     0.20,
      colorStart:  '#ffd060',  // warm yellow-orange
      colorEnd:    '#ff5030',  // red
      gravityY:    -3.0,
      spreadXZ:    2.4,
      velUp:       1.6,
      cooldownMs:  120,        // debounce — collision can fire many frames in a row
      cleanupMs:   700,
    },
    win: {
      enabled:     true,
      count:       240,
      rate:        90,         // particles/sec — sustained
      durationMs:  2200,       // emitter on for this long
      lifeMin:     1.10,
      lifeMax:     2.00,
      sizeMin:     0.10,
      sizeMax:     0.32,
      color1:      '#ffd95a',  // gold
      color2:      '#6a8aff',  // accent cyan-blue (matches engine --col-accent)
      color3:      '#ff8ad0',  // pink
      gravityY:    -3.5,
      spreadXZ:    3.5,
      velUp:       6.5,
      yOffset:     0.6,        // emit slightly above player anchor
      cleanupMs:   3600,
      // Wave-5 item 7 — staggered burst on win. When `staggered` is true,
      // we replace the single sustained emitter with `burst_count` smaller
      // bursts spaced `burst_interval_ms` apart, each from a slightly
      // randomized position above the arena center. Reads as celebratory
      // chained-fireworks instead of one big puff.
      staggered:        true,
      burst_count:      8,
      burst_interval_ms: 180,
      burst_count_each: 18,    // particles per individual burst
      burst_durationMs: 280,   // each emitter on for this long
      burst_yOffset:    9.0,   // bursts spawn this high above center (above arena)
      burst_xz_spread:  4.0,   // random x/z jitter per burst position
    },
    lose: {
      enabled:     true,
      count:       16,
      emitRate:    180,
      burstMs:     130,
      lifeMin:     0.30,
      lifeMax:     0.60,
      sizeMin:     0.10,
      sizeMax:     0.28,
      color1:      '#3a4050',  // dark blue-grey
      color2:      '#15171c',  // near-black
      gravityY:    -10.0,       // sharp downward
      spreadXZ:    1.0,
      velDown:     2.0,
      cleanupMs:   900,
    },
  };

  // ===================================================================== //
  // Wave-5 item 8 — fall splat decals. Pool of N flat planes parented to   //
  // the scene; spawned at an actor's last known position when they die,   //
  // fades over `lifetime_ms`. Cycle-allocates so we never allocate per     //
  // death past the pool size. The trigger lives in announcements.js's     //
  // death-diff loop (it calls FS.spawnSplat(actor, scene)); we just own   //
  // the geometry + tick.                                                   //
  // ===================================================================== //
  FS.splatsConfig = FS.splatsConfig || {
    enabled:     true,
    pool_size:   16,
    lifetime_ms: 1600,
    color_player: '#ff3355',
    color_bot:    '#333344',
    plane_size:  1.6,    // world-space plane width
    y_offset:    0.05,   // lift slightly above tile top to avoid Z-fight
    grow_factor: 0.4,    // how much the splat expands over its lifetime
  };

  // Capability check — software GL (swiftshader) supports ParticleSystem fine.
  // If for some reason BABYLON isn't loaded yet, register stubs and bail.
  if (typeof BABYLON === 'undefined' || !BABYLON.ParticleSystem) {
    console.warn('[fall-survive vfx] BABYLON.ParticleSystem unavailable; VFX disabled.');
    FS.onTileTelegraph = function () {};
    FS.onTileFall      = function () {};
    FS.onSphereImpact  = function () {};
    FS.onWin           = function () {};
    FS.onLose          = function () {};
    FS.updateVfx       = function () {};
    return;
  }

  // ===================================================================== //
  // Shared particle texture — a single soft white disc generated via       //
  // DynamicTexture so we don't depend on any image asset. Reused across    //
  // all systems; per-system color ramps tint it.                           //
  // ===================================================================== //
  let _sharedParticleTex = null;
  function getParticleTexture(scene) {
    // Babylon's Texture/DynamicTexture exposes `_disposed` as a flag in 6.x;
    // `isDisposed()` is on Mesh, not on Texture, so we check the flag directly
    // and fall through to rebuild if it's gone.
    if (_sharedParticleTex && !_sharedParticleTex._disposed) return _sharedParticleTex;
    const tex = new BABYLON.DynamicTexture('vfx_particle', { width: 64, height: 64 }, scene, false);
    const ctx = tex.getContext();
    // Soft radial-gradient white disc with alpha falloff.
    const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    tex.update();
    tex.hasAlpha = true;
    _sharedParticleTex = tex;
    return tex;
  }

  // Hex → BABYLON.Color4 with alpha=1
  function hexC4(hex, alpha) {
    const c = BABYLON.Color3.FromHexString(hex);
    return new BABYLON.Color4(c.r, c.g, c.b, alpha == null ? 1 : alpha);
  }

  // ===================================================================== //
  // Active-system tracker. We auto-dispose particle systems N ms after     //
  // emission stops so we don't leak emitters across long rounds. Cleaned   //
  // up in updateVfx().                                                     //
  // ===================================================================== //
  const _active = []; // [{ system, expireAt }]
  function trackSystem(system, lifetimeMs) {
    _active.push({ system, expireAt: performance.now() + lifetimeMs });
  }

  // ===================================================================== //
  // Helper — build a generic CPU ParticleSystem with sane defaults.        //
  // Each handler customizes specifics (velocity, color ramp, lifespan).    //
  // ===================================================================== //
  function makeSystem(name, scene, capacity) {
    const ps = new BABYLON.ParticleSystem(name, capacity, scene);
    ps.particleTexture = getParticleTexture(scene);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    ps.minAngularSpeed = -Math.PI;
    ps.maxAngularSpeed =  Math.PI;
    ps.preWarmCycles = 0;
    return ps;
  }

  // ===================================================================== //
  // 1) tile_telegraph — beige dust puff at tile top, subtle, one-shot.     //
  // ===================================================================== //
  FS.onTileTelegraph = function (tile, scene) {
    const cfg = FS.vfxConfig.tile_telegraph;
    if (!cfg || !cfg.enabled) return;
    if (!tile) return;

    const tx = tile.mesh ? tile.mesh.position.x : tile.x;
    const ty = (tile.mesh ? tile.mesh.position.y : tile.y) + 0.18;
    const tz = tile.mesh ? tile.mesh.position.z : tile.z;

    const ps = makeSystem(`vfx_tt_${performance.now() | 0}`, scene, cfg.count);
    ps.emitter = new BABYLON.Vector3(tx, ty, tz);
    // Small disc-ish emit zone (top face of the hex).
    ps.minEmitBox = new BABYLON.Vector3(-0.5, 0, -0.5);
    ps.maxEmitBox = new BABYLON.Vector3( 0.5, 0,  0.5);

    ps.color1 = hexC4(cfg.color1, 0.85);
    ps.color2 = hexC4(cfg.color2, 0.7);
    ps.colorDead = hexC4(cfg.color1, 0);

    ps.minSize = cfg.sizeMin;
    ps.maxSize = cfg.sizeMax;
    ps.minLifeTime = cfg.lifeMin;
    ps.maxLifeTime = cfg.lifeMax;
    ps.emitRate = cfg.emitRate;

    ps.gravity = new BABYLON.Vector3(0, cfg.gravityY, 0);
    ps.direction1 = new BABYLON.Vector3(-cfg.spreadXZ, cfg.velUp * 0.5, -cfg.spreadXZ);
    ps.direction2 = new BABYLON.Vector3( cfg.spreadXZ, cfg.velUp,        cfg.spreadXZ);

    ps.minEmitPower = 0.4;
    ps.maxEmitPower = 1.1;
    ps.updateSpeed = 1 / 60;

    ps.start();
    setTimeout(() => { try { ps.stop(); } catch (_) {} }, cfg.burstMs);
    trackSystem(ps, cfg.cleanupMs);
  };

  // ===================================================================== //
  // 2) tile_fall — debris/rock chunks, downward-biased, one-shot per tile. //
  // ===================================================================== //
  FS.onTileFall = function (tile, scene) {
    const cfg = FS.vfxConfig.tile_fall;
    if (!cfg || !cfg.enabled) return;
    if (!tile) return;

    const tx = tile.mesh ? tile.mesh.position.x : tile.x;
    const ty = (tile.mesh ? tile.mesh.position.y : tile.y) + 0.15;
    const tz = tile.mesh ? tile.mesh.position.z : tile.z;

    const ps = makeSystem(`vfx_tf_${performance.now() | 0}`, scene, cfg.count);
    ps.emitter = new BABYLON.Vector3(tx, ty, tz);
    ps.minEmitBox = new BABYLON.Vector3(-0.7, -0.05, -0.7);
    ps.maxEmitBox = new BABYLON.Vector3( 0.7,  0.10,  0.7);

    ps.color1 = hexC4(cfg.color1, 0.95);
    ps.color2 = hexC4(cfg.color2, 0.85);
    ps.colorDead = hexC4(cfg.color2, 0);

    ps.minSize = cfg.sizeMin;
    ps.maxSize = cfg.sizeMax;
    ps.minLifeTime = cfg.lifeMin;
    ps.maxLifeTime = cfg.lifeMax;
    ps.emitRate = cfg.emitRate;

    ps.gravity = new BABYLON.Vector3(0, cfg.gravityY, 0);
    ps.direction1 = new BABYLON.Vector3(-cfg.spreadXZ,  cfg.velUpBias, -cfg.spreadXZ);
    ps.direction2 = new BABYLON.Vector3( cfg.spreadXZ,  cfg.velUpBias * 0.2 - cfg.velDown, cfg.spreadXZ);

    ps.minEmitPower = 0.7;
    ps.maxEmitPower = 1.6;
    ps.updateSpeed = 1 / 60;

    ps.start();
    setTimeout(() => { try { ps.stop(); } catch (_) {} }, cfg.burstMs);
    trackSystem(ps, cfg.cleanupMs);
  };

  // ===================================================================== //
  // 3) sphere_impact — warm contact sparks at collision midpoint, with     //
  // a per-sphere cooldown so 60fps overlap doesn't stack 60 emitters/sec.  //
  // ===================================================================== //
  FS.onSphereImpact = function (sphere, player, scene) {
    const cfg = FS.vfxConfig.sphere_impact;
    if (!cfg || !cfg.enabled) return;
    if (!sphere || !sphere.mesh || !player) return;

    // Per-sphere debounce. We tag the sphere object directly — index.js
    // doesn't reuse sphere refs so this is safe.
    const now = performance.now();
    if (sphere._vfxLastImpactMs && now - sphere._vfxLastImpactMs < cfg.cooldownMs) return;
    sphere._vfxLastImpactMs = now;

    // Contact midpoint between sphere center and player center.
    const sx = sphere.mesh.position.x;
    const sy = sphere.mesh.position.y;
    const sz = sphere.mesh.position.z;
    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    const cx = (sx + px) * 0.5;
    const cy = (sy + py) * 0.5;
    const cz = (sz + pz) * 0.5;

    const ps = makeSystem(`vfx_si_${now | 0}`, scene, cfg.count);
    ps.emitter = new BABYLON.Vector3(cx, cy, cz);
    ps.minEmitBox = new BABYLON.Vector3(-0.15, -0.15, -0.15);
    ps.maxEmitBox = new BABYLON.Vector3( 0.15,  0.15,  0.15);

    ps.color1 = hexC4(cfg.colorStart, 1.0);
    ps.color2 = hexC4(cfg.colorEnd, 0.95);
    ps.colorDead = hexC4(cfg.colorEnd, 0);

    ps.minSize = cfg.sizeMin;
    ps.maxSize = cfg.sizeMax;
    ps.minLifeTime = cfg.lifeMin;
    ps.maxLifeTime = cfg.lifeMax;
    ps.emitRate = cfg.emitRate;

    ps.gravity = new BABYLON.Vector3(0, cfg.gravityY, 0);
    ps.direction1 = new BABYLON.Vector3(-cfg.spreadXZ,  cfg.velUp * 0.4, -cfg.spreadXZ);
    ps.direction2 = new BABYLON.Vector3( cfg.spreadXZ,  cfg.velUp,        cfg.spreadXZ);

    ps.minEmitPower = 1.4;
    ps.maxEmitPower = 3.0;
    ps.updateSpeed = 1 / 60;

    ps.start();
    setTimeout(() => { try { ps.stop(); } catch (_) {} }, cfg.burstMs);
    trackSystem(ps, cfg.cleanupMs);
  };

  // ===================================================================== //
  // 4) win — celebratory burst. Two paths:                                 //
  //   - staggered=true (default, wave-5 item 7): N smaller bursts spaced   //
  //     `burst_interval_ms` apart, each from a slightly randomized         //
  //     position above arena center. Reads as chained fireworks.           //
  //   - staggered=false: original sustained single-emitter at player pos. //
  // Both paths share the 3-color ramp.                                     //
  // ===================================================================== //
  function _winColorRamp(ps, cfg) {
    if (typeof ps.addColorGradient === 'function') {
      ps.addColorGradient(0.0, hexC4(cfg.color1, 1.0));
      ps.addColorGradient(0.5, hexC4(cfg.color2, 1.0));
      ps.addColorGradient(1.0, hexC4(cfg.color3, 0));
    } else {
      // Pick one of the three palette colors per emitter at random — over
      // 8 staggered bursts the palette mixes evenly.
      const palette = [cfg.color1, cfg.color2, cfg.color3];
      const pick = palette[Math.floor(Math.random() * palette.length)];
      ps.color1 = hexC4(pick, 1.0);
      ps.color2 = hexC4(palette[(palette.indexOf(pick) + 1) % palette.length], 1.0);
      ps.colorDead = hexC4(cfg.color3, 0);
    }
  }

  function _spawnWinBurst(scene, cfg, originX, originY, originZ, count, durationMs) {
    const ps = makeSystem(`vfx_win_${performance.now() | 0}_${Math.random() * 1e6 | 0}`, scene, count);
    ps.emitter = new BABYLON.Vector3(originX, originY, originZ);
    ps.minEmitBox = new BABYLON.Vector3(-0.4, -0.4, -0.4);
    ps.maxEmitBox = new BABYLON.Vector3( 0.4,  0.4,  0.4);

    _winColorRamp(ps, cfg);

    ps.minSize = cfg.sizeMin;
    ps.maxSize = cfg.sizeMax;
    ps.minLifeTime = cfg.lifeMin;
    ps.maxLifeTime = cfg.lifeMax;
    ps.emitRate = cfg.rate;

    ps.gravity = new BABYLON.Vector3(0, cfg.gravityY, 0);
    ps.direction1 = new BABYLON.Vector3(-cfg.spreadXZ,  cfg.velUp * 0.6, -cfg.spreadXZ);
    ps.direction2 = new BABYLON.Vector3( cfg.spreadXZ,  cfg.velUp,        cfg.spreadXZ);

    ps.minEmitPower = 2.0;
    ps.maxEmitPower = 5.0;
    ps.updateSpeed = 1 / 60;

    ps.start();
    setTimeout(() => { try { ps.stop(); } catch (_) {} }, durationMs);
    trackSystem(ps, cfg.cleanupMs);
    return ps;
  }

  FS.onWin = function (scene) {
    const cfg = FS.vfxConfig.win;
    if (!cfg || !cfg.enabled) return;

    // Snapshot the player position so the emitter doesn't follow if the
    // player drifts post-win. Defensive — if player isn't reachable from
    // the scene, fall back to origin.
    let px = 0, py = 2, pz = 0;
    const playerMesh = scene.getMeshByName && scene.getMeshByName('player');
    if (playerMesh) {
      px = playerMesh.position.x;
      py = playerMesh.position.y;
      pz = playerMesh.position.z;
    }

    if (cfg.staggered) {
      // Wave-5 item 7 — chained bursts from above the arena center.
      // Staggered with setTimeout; each burst is its own ParticleSystem.
      const cx = 0;       // arena center (platform is centered on origin)
      const cy = (cfg.burst_yOffset != null ? cfg.burst_yOffset : 9.0);
      const cz = 0;
      const bursts = Math.max(1, cfg.burst_count | 0);
      const interval = Math.max(0, cfg.burst_interval_ms | 0);
      const each = Math.max(1, cfg.burst_count_each | 0);
      const dur = Math.max(60, cfg.burst_durationMs | 0);
      for (let i = 0; i < bursts; i++) {
        const jitterX = (Math.random() - 0.5) * cfg.burst_xz_spread * 2;
        const jitterZ = (Math.random() - 0.5) * cfg.burst_xz_spread * 2;
        const jitterY = (Math.random() - 0.5) * 1.2;
        setTimeout(() => {
          // Defensive: scene might be torn down between scheduling and
          // firing if a fresh round started mid-confetti. Babylon throws
          // if you make a system on a disposed scene; swallow it.
          try {
            _spawnWinBurst(scene, cfg, cx + jitterX, cy + jitterY, cz + jitterZ, each, dur);
          } catch (_) {}
        }, i * interval);
      }
    } else {
      // Fallback: original sustained emitter at player position.
      _spawnWinBurst(scene, cfg, px, py + cfg.yOffset, pz, cfg.count, cfg.durationMs);
    }
  };

  // ===================================================================== //
  // 5) lose — short, sharp downward smear at last player position.         //
  // ===================================================================== //
  FS.onLose = function (scene) {
    const cfg = FS.vfxConfig.lose;
    if (!cfg || !cfg.enabled) return;

    let px = 0, py = 1, pz = 0;
    const playerMesh = scene.getMeshByName && scene.getMeshByName('player');
    if (playerMesh) {
      px = playerMesh.position.x;
      // Player is likely already below kill plane — clamp Y to a sensible
      // visible height so the smear actually shows on screen.
      py = Math.max(playerMesh.position.y, -2);
      pz = playerMesh.position.z;
    }

    const ps = makeSystem(`vfx_lose_${performance.now() | 0}`, scene, cfg.count);
    ps.emitter = new BABYLON.Vector3(px, py, pz);
    ps.minEmitBox = new BABYLON.Vector3(-0.25, -0.1, -0.25);
    ps.maxEmitBox = new BABYLON.Vector3( 0.25,  0.1,  0.25);

    ps.color1 = hexC4(cfg.color1, 0.95);
    ps.color2 = hexC4(cfg.color2, 0.85);
    ps.colorDead = hexC4(cfg.color2, 0);

    ps.minSize = cfg.sizeMin;
    ps.maxSize = cfg.sizeMax;
    ps.minLifeTime = cfg.lifeMin;
    ps.maxLifeTime = cfg.lifeMax;
    ps.emitRate = cfg.emitRate;

    ps.gravity = new BABYLON.Vector3(0, cfg.gravityY, 0);
    ps.direction1 = new BABYLON.Vector3(-cfg.spreadXZ, -cfg.velDown * 0.3, -cfg.spreadXZ);
    ps.direction2 = new BABYLON.Vector3( cfg.spreadXZ, -cfg.velDown,        cfg.spreadXZ);

    ps.minEmitPower = 0.6;
    ps.maxEmitPower = 1.6;
    ps.updateSpeed = 1 / 60;

    ps.start();
    setTimeout(() => { try { ps.stop(); } catch (_) {} }, cfg.burstMs);
    trackSystem(ps, cfg.cleanupMs);
  };

  // ===================================================================== //
  // Wave-5 item 8 — splat decal pool. Lazy-initialized on first spawn so   //
  // we have a real `scene` ref. Each splat is a flat plane laid horizontal //
  // with a soft circular alpha-gradient texture (re-using the particle    //
  // texture). Lifetime tick happens in updateVfx below.                    //
  //                                                                        //
  // Pool reuse: when the pool is exhausted, the oldest active splat is     //
  // recycled (variant uses a fixed pool of 16 — we follow that). 16 is     //
  // generous: the survival round has at most ~12-15 actors total.          //
  // ===================================================================== //
  let _splatPool = null;
  function _ensureSplatPool(scene) {
    const cfg = FS.splatsConfig;
    if (!cfg || !cfg.enabled) return null;
    if (_splatPool && _splatPool.length === cfg.pool_size) return _splatPool;
    // Build (or rebuild — pool_size knob may have been re-tuned).
    if (_splatPool) {
      // Tear down old pool before allocating a fresh one.
      for (const s of _splatPool) {
        try { if (s.mesh) s.mesh.dispose(); } catch (_) {}
        try { if (s.mat) s.mat.dispose(); } catch (_) {}
      }
    }
    _splatPool = [];
    const tex = getParticleTexture(scene);
    for (let i = 0; i < cfg.pool_size; i++) {
      // Plane laid flat — built XY by default, rotated to lie on XZ.
      const plane = BABYLON.MeshBuilder.CreatePlane(
        `vfx_splat_${i}`,
        { size: cfg.plane_size, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
        scene,
      );
      plane.rotation.x = Math.PI / 2;
      plane.isVisible = false;
      plane.isPickable = false;
      // A splat is a decal — don't cast shadows + don't receive lighting.
      // StandardMaterial with disableLighting=true reads as a flat colored
      // disc against whatever's underneath.
      const mat = new BABYLON.StandardMaterial(`vfx_splat_mat_${i}`, scene);
      mat.diffuseColor = BABYLON.Color3.FromHexString(cfg.color_bot);
      mat.emissiveColor = BABYLON.Color3.FromHexString(cfg.color_bot);
      mat.disableLighting = true;
      mat.opacityTexture = tex;       // alpha mask = soft disc
      mat.alpha = 0;
      mat.backFaceCulling = false;
      plane.material = mat;
      _splatPool.push({
        mesh:    plane,
        mat:     mat,
        active:  false,
        spawnAt: 0,
        baseSize: cfg.plane_size,
        bornAt:  0,            // performance.now() at spawn — used for LRU recycle
      });
    }
    return _splatPool;
  }

  function _pickSplatSlot(pool) {
    // Prefer an inactive slot. If none, recycle the oldest active one.
    let oldestIdx = 0;
    let oldestAge = Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) return pool[i];
      if (pool[i].bornAt < oldestAge) {
        oldestAge = pool[i].bornAt;
        oldestIdx = i;
      }
    }
    return pool[oldestIdx];
  }

  // Public spawn — announcements.js calls this from the death-diff loop.
  // Accepts an actor (we read mesh.position before disposeActor nulls it
  // out — but the diff loop in announcements.js fires AFTER index.js sets
  // alive=false, which happens INSIDE disposeActor... actor.mesh is null
  // by then). We work around this by also accepting a position-with-y
  // payload: the diff loop snapshots last-known position before the
  // alive transition is observed.
  //
  // Simpler implementation: snapshot in announcements.js by tracking
  // last-known mesh.position per actor each frame. We do that there.
  FS.spawnSplat = function (actor, scene) {
    const cfg = FS.splatsConfig;
    if (!cfg || !cfg.enabled || !actor || !scene) return;
    const pool = _ensureSplatPool(scene);
    if (!pool) return;

    // Position resolution priority:
    //   1) actor._lastPos    (snapshot kept by announcements.js diff loop)
    //   2) actor.mesh.position (rarely valid since dispose nulls mesh)
    //   3) actor._lastPosFallback or origin
    let px = 0, py = 0, pz = 0;
    if (actor._lastPos) {
      px = actor._lastPos.x;
      py = actor._lastPos.y;
      pz = actor._lastPos.z;
    } else if (actor.mesh && actor.mesh.position) {
      px = actor.mesh.position.x;
      py = actor.mesh.position.y;
      pz = actor.mesh.position.z;
    } else {
      return; // can't place — bail silently
    }

    // Snap Y to a reasonable ground level. The actor is likely below
    // kill_y by the time we observe death; clamp to a sensible height
    // above the arena floor so the splat actually shows on a tile.
    // Heuristic: tiles sit around y=0..5 in our arena; clamp to 0.05
    // above the actor's last y, but not below 0 (arena floor band).
    const splatY = Math.max(0.05, py + cfg.y_offset);

    const slot = _pickSplatSlot(pool);
    slot.mesh.position.set(px, splatY, pz);
    const isPlayer = (actor.control === 'input');
    const hex = isPlayer ? cfg.color_player : cfg.color_bot;
    const c3 = BABYLON.Color3.FromHexString(hex);
    slot.mat.diffuseColor = c3;
    slot.mat.emissiveColor = c3;
    slot.mat.alpha = 0.85;
    slot.mesh.scaling.set(1, 1, 1);
    slot.mesh.isVisible = true;
    slot.active = true;
    slot.spawnAt = performance.now();
    slot.bornAt = slot.spawnAt;
  };

  // ===================================================================== //
  // updateVfx — per-frame cleanup walk. Disposes systems whose expireAt    //
  // has passed; cheap O(N) where N is rarely above ~5. Wave-5: also ticks  //
  // the splat pool (alpha + scale fade-out).                               //
  // ===================================================================== //
  FS.updateVfx = function (dt, scene) {
    const now = performance.now();

    // Particle system cleanup.
    if (_active.length) {
      for (let i = _active.length - 1; i >= 0; i--) {
        if (now >= _active[i].expireAt) {
          try { _active[i].system.dispose(); } catch (_) {}
          _active.splice(i, 1);
        }
      }
    }

    // Splat tick — fade alpha to 0 over lifetime_ms, gently scale up so the
    // dust spreads as it dissipates.
    if (_splatPool && FS.splatsConfig && FS.splatsConfig.enabled) {
      const lifetime = Math.max(60, FS.splatsConfig.lifetime_ms | 0);
      const grow = FS.splatsConfig.grow_factor || 0.4;
      for (const s of _splatPool) {
        if (!s.active) continue;
        const t = (now - s.spawnAt) / lifetime; // 0..1
        if (t >= 1) {
          s.active = false;
          s.mat.alpha = 0;
          s.mesh.isVisible = false;
          continue;
        }
        s.mat.alpha = 0.85 * (1 - t);
        const scale = 1 + t * grow;
        s.mesh.scaling.set(scale, 1, scale);
      }
    }
  };

})();
