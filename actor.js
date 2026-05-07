// engines/fall-survive/mechanic/actor.js
//
// Wave-2 Actor refactor: turn the engine's hard-coded `player` into a generic
// Actor concept, then spawn 3 bot Actors per round driven by behavior tags
// from characters.json. The player is one Actor with control='input'; bots
// are Actors with control='ai'.
//
// Module surface (registered on window.FallSurvive):
//   FallSurvive.actorFactory.spawnPlayer(scene, characterId)   → Actor
//   FallSurvive.actorFactory.spawnBot(scene, characterId, id, x, z) → Actor
//   FallSurvive.actorFactory.disposeActor(actor)
//   FallSurvive.actorFactory.tickAi(actor, dt, gameApi)        → mutates actor.behavior._intent
//   FallSurvive.botConfig                                       → tunable knob bag
//   FallSurvive.characters                                      → resolved roster (id → character)
//
// AI cadence: behavior_tick_hz (default 4) — each bot picks a high-level
// XZ intent vector + jump bool every 1/hz seconds; physics integrates per
// frame. Intent decisions live in this module; physics/gravity/collision in
// index.js consume the per-actor stats and intent.
//
// Composition with sibling modules: this module owns Actor *meshes* only.
// Tile materials remain the lighting agent's territory; sphere materials
// remain index.js's territory.
//
// Design rationale for the split: the Actor schema + bot AI is ~250 LOC
// of self-contained logic; folding it into index.js would push that file
// past 1100 LOC and bury the game-loop integration. As a module, the
// behavior menu is a single-file lookup ("which tag does what?") and CLI
// iteration on a single behavior knob is scoped to one file.

(function () {
  'use strict';

  window.FallSurvive = window.FallSurvive || {};
  const FS = window.FallSurvive;

  // ===================================================================== //
  // Character roster — lazy-loaded from characters.json on first request.  //
  // Synchronous until the JSON is fetched; we bake the roster into a       //
  // hardcoded fallback so the engine still boots even if the fetch fails  //
  // (e.g. file:// origin). The fallback mirrors characters.json verbatim.  //
  // ===================================================================== //
  const FALLBACK_ROSTER = {
    characters: [
      {
        id: 'sprinter', name: 'Sprinter',
        stats: { move_speed_mult: 1.40, jump_velocity_mult: 1.00, gravity_mult: 1.00, player_radius_mult: 0.85, player_height_mult: 1.05 },
        visual: { color: '#ff5d8a', glow_color: '#ff9ec0', shape: 'capsule' },
        behavior: { tag: 'reckless', params: { edge_seek: 0.7, panic_threshold_ms: 6000 } },
      },
      {
        id: 'hopper', name: 'Hopper',
        stats: { move_speed_mult: 1.00, jump_velocity_mult: 1.40, gravity_mult: 0.85, player_radius_mult: 1.00, player_height_mult: 1.00 },
        visual: { color: '#5dc8d8', glow_color: '#a0e8f0', shape: 'sphere' },
        behavior: { tag: 'hopper', params: { jump_chance_per_sec: 0.8, wander_radius: 4 } },
      },
      {
        id: 'boulder', name: 'Boulder',
        stats: { move_speed_mult: 0.70, jump_velocity_mult: 0.85, gravity_mult: 1.30, player_radius_mult: 1.40, player_height_mult: 1.00 },
        visual: { color: '#8b6f3f', glow_color: '#c49a55', shape: 'cylinder' },
        behavior: { tag: 'cautious', params: { center_pull: 0.8, min_edge_distance: 5 } },
      },
      {
        id: 'dasher', name: 'Dasher',
        stats: { move_speed_mult: 1.20, jump_velocity_mult: 1.10, gravity_mult: 1.00, player_radius_mult: 1.00, player_height_mult: 1.00 },
        visual: { color: '#e85da8', glow_color: '#f8a0d0', shape: 'capsule' },
        behavior: { tag: 'aggressive', params: { sphere_seek: 0.6, panic_threshold_ms: 3000 } },
      },
      {
        id: 'glider', name: 'Glider',
        stats: { move_speed_mult: 1.00, jump_velocity_mult: 1.00, gravity_mult: 0.60, player_radius_mult: 0.95, player_height_mult: 1.10 },
        visual: { color: '#a070ff', glow_color: '#d0b0ff', shape: 'capsule' },
        behavior: { tag: 'edge_walker', params: { edge_pull: 0.5, ledge_recovery: 0.8 } },
      },
    ],
  };

  // Indexed by id for O(1) lookup. Populated synchronously from the
  // fallback; replaced if/when the async fetch resolves.
  const rosterById = {};
  for (const ch of FALLBACK_ROSTER.characters) rosterById[ch.id] = ch;
  FS.characters = rosterById;

  // Best-effort async fetch — overrides fallback when the JSON loads. Any
  // failure (file:// origin, missing file) is silently absorbed; fallback
  // already populated.
  try {
    fetch('./characters.json')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j || !Array.isArray(j.characters)) return;
        for (const ch of j.characters) rosterById[ch.id] = ch;
      })
      .catch(() => {});
  } catch (_) {}

  // ===================================================================== //
  // botConfig — public knob bag. CLI iteration: edit before level_config   //
  // arrives, or post a level_config with bot_count to override count       //
  // per-beat.                                                              //
  // ===================================================================== //
  FS.botConfig = FS.botConfig || {
    count:                  3,        // mirrors level_config.bot_count
    spawn_min_separation:   4.0,      // world units between bot spawn points
    behavior_tick_hz:       4,        // high-level decisions per second
    // Per-behavior multipliers — scale the intent magnitudes so iteration
    // can dial behaviors up/down without editing the per-character params
    // in characters.json. 1.0 = use the character.behavior.params values
    // as-is; 1.5 = exaggerate; 0.5 = soften.
    cautious_pull_mult:     1.0,
    reckless_seek_mult:     1.0,
    aggressive_seek_mult:   1.0,
    hopper_jump_mult:       1.0,
    edge_walker_pull_mult:  1.0,
    // Random-wander floor: even when a behavior's directional intent is
    // weak, layer on this much random jitter so bots don't park in place.
    wander_jitter:          0.2,
  };

  // ===================================================================== //
  // charactersConfig — visual knob bag exposed for the panel agent's       //
  // *Config auto-discovery. Knobs read fresh per spawnPlayer/spawnBot, so  //
  // changing them mid-run takes effect on the next round restart.          //
  // ===================================================================== //
  FS.charactersConfig = FS.charactersConfig || {
    eye_size_mult:        1.0,    // scales the white-eye sphere diameter
    pupil_size_mult:      1.0,    // scales the black pupil sphere diameter
    eye_glow:             false,  // emissive eye whites (night-register)
    accessory_visibility: true,   // hide antennae / horns / ribbons for clean prototype
  };

  // ===================================================================== //
  // Mesh + material builders. Per-character compound bodies built from     //
  // MeshBuilder primitives parented to a root body mesh. Each character's  //
  // tagline drives proportions / accessories so they read at a glance:    //
  //                                                                        //
  //   sprinter — slim tall capsule, narrow alert eyes, forward lean        //
  //   hopper   — round bouncy sphere, big surprised eyes, antennae         //
  //   boulder  — chunky wide cylinder, droopy half-closed eyes, brow ridge //
  //   dasher   — athletic capsule, narrowed determined eyes, forward horn  //
  //   glider   — tall floaty capsule, dreamy half-lids, scarf ribbons      //
  //                                                                        //
  // Materials are NOT shared — each actor gets its own clone so per-       //
  // instance tinting (e.g. lose-flash) is possible later without           //
  // disturbing siblings. The body's material is exposed as `actor.topMat`  //
  // so lighting/VFX hooks can apply the dance-floor emissive sweep         //
  // consistently with how they target tile.topMat.                         //
  // ===================================================================== //

  // Helper: build the body's primary material with diffuse + emissive rim.
  function buildBodyMaterial(scene, actorId, color, glowColor) {
    const mat = new BABYLON.StandardMaterial(`actor_mat_${actorId}`, scene);
    mat.diffuseColor = BABYLON.Color3.FromHexString(color || '#ff5d8a');
    mat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.12);
    if (glowColor) {
      const glow = BABYLON.Color3.FromHexString(glowColor);
      mat.emissiveColor = glow.scale(0.35);
    }
    return mat;
  }

  // Helper: build a flat-colored material for accessories / pupils.
  function buildAccentMaterial(scene, name, hex, opts) {
    opts = opts || {};
    const mat = new BABYLON.StandardMaterial(name, scene);
    mat.diffuseColor = BABYLON.Color3.FromHexString(hex);
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.06);
    if (opts.emissive) {
      mat.emissiveColor = BABYLON.Color3.FromHexString(opts.emissive).scale(opts.emissiveIntensity || 0.4);
    }
    if (opts.unlit) {
      mat.disableLighting = true;
      mat.emissiveColor = BABYLON.Color3.FromHexString(hex);
    }
    return mat;
  }

  // Helper: build the eye pair (white sphere + smaller black pupil), parent
  // them to bodyMesh, and position on the +Z (front) face. eyeYNorm 0..1 is
  // the height fraction from body center: 0=center, +0.5=top, -0.5=bottom.
  // eyeSpread is the X-distance between eye centers (world units).
  // eyeRadius is the white-eye radius. pupilScale shrinks the black pupil.
  // pupilTilt rotates the pupil offset so half-lid characters can have eyes
  // that read as "tired" / "determined" by pulling the pupil toward an edge.
  function attachEyes(scene, bodyMesh, actorId, opts) {
    const cfg = FS.charactersConfig || {};
    const eyeMult = cfg.eye_size_mult != null ? cfg.eye_size_mult : 1.0;
    const pupilMult = cfg.pupil_size_mult != null ? cfg.pupil_size_mult : 1.0;
    const eyeRadius = (opts.eyeRadius || 0.10) * eyeMult;
    const pupilRadius = eyeRadius * (opts.pupilScale != null ? opts.pupilScale : 0.55) * pupilMult;
    const spread = opts.eyeSpread != null ? opts.eyeSpread : 0.22;
    const yLocal = opts.eyeY != null ? opts.eyeY : 0.25;
    const zFront = opts.eyeZ != null ? opts.eyeZ : 0.20;
    const whiteHex = opts.whiteHex || '#ffffff';
    const pupilHex = opts.pupilHex || '#0a0a14';
    const glowHex = opts.glowHex || null;

    const whiteMat = buildAccentMaterial(scene, `actor_eye_white_${actorId}`, whiteHex, {
      emissive: cfg.eye_glow && glowHex ? glowHex : null,
      emissiveIntensity: 0.6,
    });
    const pupilMat = buildAccentMaterial(scene, `actor_eye_pupil_${actorId}`, pupilHex, { unlit: true });

    // Pupil offset within the white sphere — front-and-slightly-tilted.
    const pupilOffZ = eyeRadius * 0.55;
    const pupilOffY = (opts.pupilTiltY || 0) * eyeRadius * 0.5;
    const pupilOffX = (opts.pupilTiltX || 0) * eyeRadius * 0.5;

    const eyes = [];
    for (const sign of [-1, +1]) {
      const white = BABYLON.MeshBuilder.CreateSphere(
        `actor_${actorId}_eye_white_${sign > 0 ? 'r' : 'l'}`,
        { diameter: eyeRadius * 2, segments: 10 },
        scene
      );
      white.material = whiteMat;
      white.parent = bodyMesh;
      white.position.set(sign * spread / 2, yLocal, zFront);

      const pupil = BABYLON.MeshBuilder.CreateSphere(
        `actor_${actorId}_eye_pupil_${sign > 0 ? 'r' : 'l'}`,
        { diameter: pupilRadius * 2, segments: 8 },
        scene
      );
      pupil.material = pupilMat;
      pupil.parent = white;
      // Pupil sits on the front face of the white eye.
      pupil.position.set(pupilOffX * sign, pupilOffY, pupilOffZ);
      eyes.push(white, pupil);
    }

    // Optional eyelid disc — half-disc that obscures the top half of the
    // white eye so characters read as "tired" / "droopy" / "dreamy". Placed
    // very close to the white sphere; uses the body color so it feels like
    // the body wrapping over.
    if (opts.lidCoverage && opts.lidColorHex) {
      const lidMat = buildAccentMaterial(scene, `actor_lid_${actorId}`, opts.lidColorHex, {});
      for (const sign of [-1, +1]) {
        const lid = BABYLON.MeshBuilder.CreateBox(
          `actor_${actorId}_lid_${sign > 0 ? 'r' : 'l'}`,
          { width: eyeRadius * 2.4, height: eyeRadius * opts.lidCoverage * 2, depth: eyeRadius * 0.2 },
          scene
        );
        lid.material = lidMat;
        lid.parent = bodyMesh;
        // Lid sits in front of the eye, top-down for "droopy" or bottom-up
        // for "narrowed-determined".
        const lidYOffset = opts.lidFromBelow
          ? yLocal - eyeRadius * 0.5 + (eyeRadius * opts.lidCoverage) * 0.5 - eyeRadius
          : yLocal + eyeRadius * 0.5 - (eyeRadius * opts.lidCoverage) * 0.5 + eyeRadius * 0.2;
        lid.position.set(sign * spread / 2, lidYOffset, zFront + eyeRadius * 0.6);
        eyes.push(lid);
      }
    }

    return eyes;
  }

  // ===================================================================== //
  // Per-character body builders. Each returns the root body mesh; eyes +   //
  // accessories are parented to it.                                        //
  // ===================================================================== //
  function buildSprinterBody(scene, character, actorId, radius, height) {
    const cfg = FS.charactersConfig || {};
    const v = character.visual || {};
    // Slim, taller-than-default capsule. Forward lean reads as "overcommits."
    const body = BABYLON.MeshBuilder.CreateCapsule(
      `actor_${actorId}`,
      { radius: radius * 0.85, height: height * 1.05, tessellation: 12 },
      scene
    );
    body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);
    // Subtle forward tilt — caller can override if facing-direction is wired.
    body.rotation.x = -0.12;

    // Eyes: small + close-set + slightly raised → alert.
    attachEyes(scene, body, actorId, {
      eyeRadius:   radius * 0.20,
      eyeSpread:   radius * 0.55,
      eyeY:        height * 0.25,
      eyeZ:        radius * 0.85,
      pupilScale:  0.55,
      pupilTiltY:  0.3,   // pupils up = wide alert
      glowHex:     v.glow_color,
    });

    // Accessory: tiny pointed crest on top — "lean / sharp" silhouette.
    if (cfg.accessory_visibility) {
      const crest = BABYLON.MeshBuilder.CreateCylinder(
        `actor_${actorId}_crest`,
        { diameterTop: 0, diameterBottom: radius * 0.4, height: radius * 0.6, tessellation: 8 },
        scene
      );
      crest.material = buildAccentMaterial(scene, `actor_${actorId}_crest_mat`, v.glow_color || '#ff9ec0', {});
      crest.parent = body;
      crest.position.set(0, height * 0.42, -radius * 0.1);
      crest.rotation.x = -0.15;
    }
    return body;
  }

  function buildHopperBody(scene, character, actorId, radius, height) {
    const cfg = FS.charactersConfig || {};
    const v = character.visual || {};
    // Round bouncy body — sphere stretched to "height" for ground-sense parity.
    const body = BABYLON.MeshBuilder.CreateSphere(
      `actor_${actorId}`,
      { diameter: radius * 2, segments: 14 },
      scene
    );
    // Wider than tall = bouncy round. Y-stretch keeps height contract; x/z
    // stretch slightly wider so it reads as squashy.
    body.scaling.set(1.15, height / (radius * 2) * 0.95, 1.15);
    body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);

    // Eyes: BIG + wide-set + raised → surprised/excited.
    attachEyes(scene, body, actorId, {
      eyeRadius:   radius * 0.32,
      eyeSpread:   radius * 0.85,
      eyeY:        radius * 0.2,
      eyeZ:        radius * 0.82,
      pupilScale:  0.5,
      pupilTiltY:  0.4,    // pupils up
      glowHex:     v.glow_color,
    });

    // Accessory: two springy antennae — twin cylinders + tip spheres.
    if (cfg.accessory_visibility) {
      const antMat = buildAccentMaterial(scene, `actor_${actorId}_ant_mat`, v.glow_color || '#a0e8f0', {});
      for (const sign of [-1, +1]) {
        const stalk = BABYLON.MeshBuilder.CreateCylinder(
          `actor_${actorId}_ant_${sign > 0 ? 'r' : 'l'}`,
          { diameter: radius * 0.08, height: radius * 0.7, tessellation: 6 },
          scene
        );
        stalk.material = antMat;
        stalk.parent = body;
        stalk.position.set(sign * radius * 0.3, radius * 0.95, 0);
        stalk.rotation.z = sign * 0.25;
        const tip = BABYLON.MeshBuilder.CreateSphere(
          `actor_${actorId}_ant_tip_${sign > 0 ? 'r' : 'l'}`,
          { diameter: radius * 0.2, segments: 6 },
          scene
        );
        tip.material = antMat;
        tip.parent = stalk;
        tip.position.set(0, radius * 0.4, 0);
      }
    }
    return body;
  }

  function buildBoulderBody(scene, character, actorId, radius, height) {
    const cfg = FS.charactersConfig || {};
    const v = character.visual || {};
    // Chunky wide cylinder — wider radius mult is already in stats
    // (player_radius_mult: 1.4), this just emphasizes shorter aspect.
    const body = BABYLON.MeshBuilder.CreateCylinder(
      `actor_${actorId}`,
      { diameter: radius * 2, height: height * 0.95, tessellation: 12 },
      scene
    );
    body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);

    // Eyes: small, low, droopy half-lid → "slow, heavy."
    attachEyes(scene, body, actorId, {
      eyeRadius:   radius * 0.16,
      eyeSpread:   radius * 0.7,
      eyeY:        height * 0.15,
      eyeZ:        radius * 0.92,
      pupilScale:  0.6,
      pupilTiltY: -0.2,   // pupils down = droopy
      lidCoverage: 0.45,  // top eyelid covers ~45% of the eye
      lidColorHex: v.color,
      lidFromBelow: false,
      glowHex:     v.glow_color,
    });

    // Accessory: two bumpy "moss" / boulder lumps on top — small spheres.
    if (cfg.accessory_visibility) {
      const lumpMat = buildAccentMaterial(scene, `actor_${actorId}_lump_mat`, v.glow_color || '#c49a55', {});
      for (let i = 0; i < 3; i++) {
        const lump = BABYLON.MeshBuilder.CreateSphere(
          `actor_${actorId}_lump_${i}`,
          { diameter: radius * (0.35 + i * 0.05), segments: 6 },
          scene
        );
        lump.material = lumpMat;
        lump.parent = body;
        const ang = (i / 3) * Math.PI * 2 + 0.5;
        lump.position.set(Math.cos(ang) * radius * 0.4, height * 0.5, Math.sin(ang) * radius * 0.4);
      }
      // Heavy brow ridge — flat box across the front above the eyes.
      const brow = BABYLON.MeshBuilder.CreateBox(
        `actor_${actorId}_brow`,
        { width: radius * 1.4, height: radius * 0.18, depth: radius * 0.25 },
        scene
      );
      brow.material = lumpMat;
      brow.parent = body;
      brow.position.set(0, height * 0.28, radius * 0.85);
    }
    return body;
  }

  function buildDasherBody(scene, character, actorId, radius, height) {
    const cfg = FS.charactersConfig || {};
    const v = character.visual || {};
    // Athletic capsule — same proportions as default but with a forward
    // horn. Subtle forward lean reads as "charges on purpose."
    const body = BABYLON.MeshBuilder.CreateCapsule(
      `actor_${actorId}`,
      { radius, height, tessellation: 12 },
      scene
    );
    body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);
    body.rotation.x = -0.08;  // mild forward lean

    // Eyes: narrowed (lid from below) + close-set → determined / intense.
    attachEyes(scene, body, actorId, {
      eyeRadius:   radius * 0.22,
      eyeSpread:   radius * 0.6,
      eyeY:        height * 0.20,
      eyeZ:        radius * 0.88,
      pupilScale:  0.5,
      pupilTiltY:  0,
      lidCoverage: 0.35,
      lidColorHex: v.color,
      lidFromBelow: true,   // bottom lid raised → narrowed/determined
      glowHex:     v.glow_color,
    });

    // Accessory: forward horn / crest on the front of the head.
    if (cfg.accessory_visibility) {
      const horn = BABYLON.MeshBuilder.CreateCylinder(
        `actor_${actorId}_horn`,
        { diameterTop: 0, diameterBottom: radius * 0.35, height: radius * 0.7, tessellation: 8 },
        scene
      );
      horn.material = buildAccentMaterial(scene, `actor_${actorId}_horn_mat`, v.glow_color || '#f8a0d0', {});
      horn.parent = body;
      // Horn tilts forward, anchored above the eyes.
      horn.position.set(0, height * 0.42, radius * 0.5);
      horn.rotation.x = Math.PI / 2 - 0.3;  // points forward+up
    }
    return body;
  }

  function buildGliderBody(scene, character, actorId, radius, height) {
    const cfg = FS.charactersConfig || {};
    const v = character.visual || {};
    // Tall floaty capsule — slightly skinnier than default, tall.
    const body = BABYLON.MeshBuilder.CreateCapsule(
      `actor_${actorId}`,
      { radius: radius * 0.9, height: height * 1.1, tessellation: 12 },
      scene
    );
    body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);

    // Eyes: half-lidded (top lid) + slightly drifted → dreamy.
    attachEyes(scene, body, actorId, {
      eyeRadius:   radius * 0.22,
      eyeSpread:   radius * 0.7,
      eyeY:        height * 0.28,
      eyeZ:        radius * 0.85,
      pupilScale:  0.55,
      pupilTiltY:  0.1,
      pupilTiltX:  0.2,    // pupils slightly drift — dreamy
      lidCoverage: 0.40,
      lidColorHex: v.color,
      lidFromBelow: false,
      glowHex:     v.glow_color,
    });

    // Accessory: two trailing scarf ribbons — thin boxes at shoulder height.
    if (cfg.accessory_visibility) {
      const scarfMat = buildAccentMaterial(scene, `actor_${actorId}_scarf_mat`, v.glow_color || '#d0b0ff', {});
      // Make ribbons subtly emissive so the floaty register reads at night.
      scarfMat.emissiveColor = BABYLON.Color3.FromHexString(v.glow_color || '#d0b0ff').scale(0.25);
      for (const sign of [-1, +1]) {
        const ribbon = BABYLON.MeshBuilder.CreateBox(
          `actor_${actorId}_ribbon_${sign > 0 ? 'r' : 'l'}`,
          { width: radius * 0.15, height: radius * 1.2, depth: radius * 0.04 },
          scene
        );
        ribbon.material = scarfMat;
        ribbon.parent = body;
        ribbon.position.set(sign * radius * 0.5, height * 0.05, -radius * 0.7);
        ribbon.rotation.z = sign * -0.2;
        ribbon.rotation.x = 0.3;  // trail backward
      }
    }
    return body;
  }

  // Dispatch table — keyed on character id, falls back to shape, falls back
  // to a default capsule. The visual.shape field is still respected for any
  // future characters that don't have a per-id builder.
  const CHARACTER_BUILDERS = {
    sprinter: buildSprinterBody,
    hopper:   buildHopperBody,
    boulder:  buildBoulderBody,
    dasher:   buildDasherBody,
    glider:   buildGliderBody,
  };

  function buildActorMesh(scene, character, actorId) {
    const radius = TUNING_BASE.player_radius * (character.stats.player_radius_mult || 1.0);
    const height = TUNING_BASE.player_height * (character.stats.player_height_mult || 1.0);

    const builder = CHARACTER_BUILDERS[character.id];
    let body;
    if (builder) {
      body = builder(scene, character, actorId, radius, height);
    } else {
      // Fallback for characters added later without a custom builder —
      // honor visual.shape so the engine still boots with the new roster.
      const v = character.visual || {};
      const shape = v.shape || 'capsule';
      if (shape === 'sphere') {
        body = BABYLON.MeshBuilder.CreateSphere(`actor_${actorId}`, { diameter: radius * 2, segments: 14 }, scene);
        body.scaling.y = height / (radius * 2);
      } else if (shape === 'cylinder') {
        body = BABYLON.MeshBuilder.CreateCylinder(`actor_${actorId}`, { diameter: radius * 2, height, tessellation: 14 }, scene);
      } else {
        body = BABYLON.MeshBuilder.CreateCapsule(`actor_${actorId}`, { radius, height, tessellation: 12 }, scene);
      }
      body.material = buildBodyMaterial(scene, actorId, v.color, v.glow_color);
      attachEyes(scene, body, actorId, {
        eyeRadius: radius * 0.22,
        eyeSpread: radius * 0.65,
        eyeY:      height * 0.2,
        eyeZ:      radius * 0.85,
        glowHex:   v.glow_color,
      });
    }

    return body;
  }

  // We mirror a slim view of index.js's TUNING constants here so this
  // module can compute per-actor stats without crossing the IIFE boundary.
  // index.js publishes the full set on first call to setupActors() via
  // FS._tuning; we cache it here so subsequent spawns work consistently.
  let TUNING_BASE = {
    player_radius: 0.45,
    player_height: 1.6,
    move_speed:    6.0,
    jump_velocity: 7.5,
    gravity:       20.0,
  };
  FS.actorFactory = FS.actorFactory || {};
  FS.actorFactory.setTuningBase = function (t) {
    TUNING_BASE = Object.assign({}, TUNING_BASE, t || {});
  };

  // ===================================================================== //
  // Stat resolution: apply character multipliers over base TUNING.         //
  // ===================================================================== //
  function resolveStats(character) {
    const s = character.stats || {};
    return {
      move_speed:    TUNING_BASE.move_speed    * (s.move_speed_mult    || 1.0),
      jump_velocity: TUNING_BASE.jump_velocity * (s.jump_velocity_mult || 1.0),
      gravity:       TUNING_BASE.gravity       * (s.gravity_mult       || 1.0),
      radius:        TUNING_BASE.player_radius * (s.player_radius_mult || 1.0),
      height:        TUNING_BASE.player_height * (s.player_height_mult || 1.0),
    };
  }

  // ===================================================================== //
  // Public spawn API.                                                      //
  // ===================================================================== //
  FS.actorFactory.spawnPlayer = function (scene, characterId) {
    const character = rosterById[characterId] || rosterById['sprinter'];
    const mesh = buildActorMesh(scene, character, 'player');
    mesh.position.set(0, 4, 0);
    return {
      id:        'player',
      character: character.id,
      control:   'input',
      stats:     resolveStats(character),
      mesh,
      // topMat — the body material. Lighting / VFX hooks may target this for
      // emissive sweeps (mirrors tile.topMat convention). Children (eyes /
      // accessories) keep their own materials so the sweep doesn't bleed.
      topMat:    mesh.material,
      vy:        0,
      grounded:  false,
      alive:     true,
      survivedMs: 0,  // bot AI looks at this on the player ref too (for camera)
      // Player has no behavior; AI tick is a no-op for control='input'.
      behavior:  null,
    };
  };

  FS.actorFactory.spawnBot = function (scene, characterId, id, spawnX, spawnZ) {
    const character = rosterById[characterId] || rosterById['hopper'];
    const mesh = buildActorMesh(scene, character, id);
    mesh.position.set(spawnX, 4, spawnZ);
    const beh = character.behavior || { tag: 'hopper', params: {} };
    return {
      id,
      character: character.id,
      control:   'ai',
      stats:     resolveStats(character),
      mesh,
      // See spawnPlayer — body material exposed for hooks. Children keep
      // their own materials so eyes / accessories don't pulse with the body.
      topMat:    mesh.material,
      vy:        0,
      grounded:  false,
      alive:     true,
      survivedMs: 0,
      behavior: {
        tag:    beh.tag,
        params: Object.assign({}, beh.params || {}),
        // _internalState — per-tag bookkeeping. Filled lazily by tickAi.
        _internalState: {
          intentX:       0,    // current AI XZ intent (unit-ish)
          intentZ:       0,
          jumpQueued:    false,
          tickCooldown:  0,
          wanderTargetX: spawnX,
          wanderTargetZ: spawnZ,
        },
      },
    };
  };

  FS.actorFactory.disposeActor = function (actor) {
    if (!actor) return;
    if (actor.mesh) {
      // Compound bodies have eye / accessory child meshes parented to the
      // body root. Babylon's default mesh.dispose() does not recurse, so we
      // walk children first and tear down their materials + meshes before
      // killing the root. getDescendants(false) returns ALL descendants,
      // including grandchildren (pupils parented to white-eye spheres).
      try {
        const kids = actor.mesh.getDescendants ? actor.mesh.getDescendants(false) : [];
        for (const k of kids) {
          try { if (k.material) k.material.dispose(); } catch (_) {}
          try { k.dispose(); } catch (_) {}
        }
      } catch (_) {}
      try { if (actor.mesh.material) actor.mesh.material.dispose(); } catch (_) {}
      try { actor.mesh.dispose(); } catch (_) {}
    }
    actor.mesh = null;
    actor.topMat = null;
    actor.alive = false;
  };

  // ===================================================================== //
  // Bot AI — tickAi(actor, dt, gameApi).                                   //
  // gameApi shape (provided by index.js each frame):                       //
  //   tiles:           Array of tile objects (with x/z + .fallen + .mesh)  //
  //   spheres:         Array of sphere refs (mesh.position + vx/vz)        //
  //   platformRadius:  approx XZ radius of the platform (for edge bias)    //
  //   activeLayerY:    Y of the top layer (for ledge-recovery)             //
  //                                                                        //
  // Each bot calls this every frame; the cooldown gates expensive          //
  // decision logic to behavior_tick_hz. Between ticks we keep the same     //
  // intent vector so the bot moves coherently rather than jittering at     //
  // 60fps off raw RNG.                                                     //
  // ===================================================================== //
  FS.actorFactory.tickAi = function (actor, dt, gameApi) {
    if (!actor || actor.control !== 'ai' || !actor.alive || !actor.mesh) return;
    const beh = actor.behavior;
    if (!beh) return;
    const st = beh._internalState;

    // Track per-actor survival time (used by reckless / aggressive panic).
    actor.survivedMs += dt * 1000;

    // Decision tick — gate per behavior_tick_hz.
    st.tickCooldown -= dt;
    if (st.tickCooldown <= 0) {
      st.tickCooldown = 1 / Math.max(1, FS.botConfig.behavior_tick_hz || 4);
      decideIntent(actor, gameApi);
    }
  };

  // The decision step: writes intentX/intentZ/jumpQueued into _internalState.
  function decideIntent(actor, gameApi) {
    const beh = actor.behavior;
    const st = beh._internalState;
    const tag = beh.tag;
    const params = beh.params || {};
    const x = actor.mesh.position.x;
    const z = actor.mesh.position.z;
    const jitter = FS.botConfig.wander_jitter || 0;

    let ix = 0, iz = 0;
    let jump = false;

    if (tag === 'cautious') {
      // Bias toward platform center. If outside min_edge_distance from the
      // edge, head inward. center is (0,0).
      const distFromCenter = Math.hypot(x, z);
      const platR = gameApi.platformRadius || 6;
      const edgeDist = platR - distFromCenter;
      const pull = (params.center_pull != null ? params.center_pull : 0.8) * (FS.botConfig.cautious_pull_mult || 1.0);
      if (edgeDist < (params.min_edge_distance || 5)) {
        // Head inward (toward origin).
        const len = distFromCenter || 1;
        ix = -x / len * pull;
        iz = -z / len * pull;
      } else {
        // Inside the safe zone — gentle nudge toward center to stay parked.
        const len = distFromCenter || 1;
        ix = -x / len * pull * 0.3;
        iz = -z / len * pull * 0.3;
      }
    } else if (tag === 'reckless') {
      // Bias outward toward edges; the longer alive, the more aggressive
      // the overcommit. survivedMs > panic_threshold doubles the seek.
      const platR = gameApi.platformRadius || 6;
      const distFromCenter = Math.hypot(x, z);
      const seek = (params.edge_seek != null ? params.edge_seek : 0.7) * (FS.botConfig.reckless_seek_mult || 1.0);
      const panicMult = actor.survivedMs > (params.panic_threshold_ms || 6000) ? 1.6 : 1.0;
      if (distFromCenter < 0.1) {
        // At center — pick a random direction outward.
        const ang = Math.random() * Math.PI * 2;
        ix = Math.cos(ang) * seek * panicMult;
        iz = Math.sin(ang) * seek * panicMult;
      } else {
        // Already off-center — reinforce the outward bearing.
        ix = (x / distFromCenter) * seek * panicMult;
        iz = (z / distFromCenter) * seek * panicMult;
      }
    } else if (tag === 'aggressive') {
      // Charge nearest sphere. Jump when one is closing fast.
      const seek = (params.sphere_seek != null ? params.sphere_seek : 0.6) * (FS.botConfig.aggressive_seek_mult || 1.0);
      let nearest = null;
      let nearestD2 = Infinity;
      const spheres = gameApi.spheres || [];
      for (const s of spheres) {
        if (!s.mesh) continue;
        const dx = s.mesh.position.x - x;
        const dz = s.mesh.position.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearestD2) { nearestD2 = d2; nearest = s; }
      }
      if (nearest) {
        const dx = nearest.mesh.position.x - x;
        const dz = nearest.mesh.position.z - z;
        const d = Math.sqrt(nearestD2) || 1;
        ix = (dx / d) * seek;
        iz = (dz / d) * seek;
        // Closing-velocity check: if sphere is moving toward us (dot of its
        // velocity with the displacement TO us is positive), jump to dodge.
        const dotVel = (-dx) * (nearest.vx || 0) + (-dz) * (nearest.vz || 0);
        if (dotVel > 0 && d < 4) jump = true;
      } else {
        // No spheres — wander outward like reckless but milder.
        const ang = Math.random() * Math.PI * 2;
        ix = Math.cos(ang) * seek * 0.4;
        iz = Math.sin(ang) * seek * 0.4;
      }
    } else if (tag === 'hopper') {
      // Random wander to a target inside wander_radius of current pos;
      // jump on per-tick chance (jump_chance_per_sec scaled by tick period).
      const wanderR = params.wander_radius || 4;
      const dxT = st.wanderTargetX - x;
      const dzT = st.wanderTargetZ - z;
      const dT  = Math.hypot(dxT, dzT);
      if (dT < 0.6) {
        // Pick a new wander target nearby.
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * wanderR;
        st.wanderTargetX = x + Math.cos(ang) * r;
        st.wanderTargetZ = z + Math.sin(ang) * r;
      }
      const len = dT || 1;
      ix = dxT / len * 0.7;
      iz = dzT / len * 0.7;
      // Jump roll — chance is per-second, so multiply by tick period (1/hz).
      const tickPeriod = 1 / Math.max(1, FS.botConfig.behavior_tick_hz || 4);
      const chance = (params.jump_chance_per_sec || 0.8) * tickPeriod * (FS.botConfig.hopper_jump_mult || 1.0);
      if (Math.random() < chance) jump = true;
    } else if (tag === 'edge_walker') {
      // Bias toward the edge band — sit in a ring at ~80% of platform radius.
      // If foot Y is below the active layer top by some margin, perform
      // ledge-recovery: bias toward the nearest non-fallen tile.
      const platR = gameApi.platformRadius || 6;
      const distFromCenter = Math.hypot(x, z);
      const edgePull = (params.edge_pull != null ? params.edge_pull : 0.5) * (FS.botConfig.edge_walker_pull_mult || 1.0);
      const targetRing = platR * 0.8;
      const radialDelta = targetRing - distFromCenter;
      // Move radially toward target ring; tangentially walk the rim.
      const len = distFromCenter || 1;
      const radX = x / len, radZ = z / len;
      // Tangent (90° rotation) — gives perimeter walk direction.
      const tanX = -radZ, tanZ = radX;
      ix = radX * Math.sign(radialDelta) * Math.min(1, Math.abs(radialDelta) * 0.5) * edgePull
         + tanX * 0.4 * edgePull;
      iz = radZ * Math.sign(radialDelta) * Math.min(1, Math.abs(radialDelta) * 0.5) * edgePull
         + tanZ * 0.4 * edgePull;

      // Ledge-recovery — if currently below the active layer Y by a margin,
      // urgently bias toward the nearest non-fallen tile XZ.
      const activeLayerY = gameApi.activeLayerY != null ? gameApi.activeLayerY : 0;
      const footY = actor.mesh.position.y - actor.stats.height / 2;
      if (footY < activeLayerY - 1.5) {
        let nearestTile = null;
        let nearestD2 = Infinity;
        const tiles = gameApi.tiles || [];
        for (const t of tiles) {
          if (t.fallen) continue;
          const tx = t.mesh ? t.mesh.position.x : t.x;
          const tz = t.mesh ? t.mesh.position.z : t.z;
          const dxT = tx - x;
          const dzT = tz - z;
          const d2 = dxT * dxT + dzT * dzT;
          if (d2 < nearestD2) { nearestD2 = d2; nearestTile = t; }
        }
        if (nearestTile) {
          const tx = nearestTile.mesh ? nearestTile.mesh.position.x : nearestTile.x;
          const tz = nearestTile.mesh ? nearestTile.mesh.position.z : nearestTile.z;
          const dxT = tx - x, dzT = tz - z;
          const dT = Math.hypot(dxT, dzT) || 1;
          const recovery = params.ledge_recovery || 0.8;
          // Override prior intent — survival comes first.
          ix = (dxT / dT) * recovery;
          iz = (dzT / dT) * recovery;
          jump = true;  // try to hop back onto the tile
        }
      }
    }

    // Jitter — small random noise so bots don't lock into perfect lines.
    if (jitter > 0) {
      ix += (Math.random() - 0.5) * jitter;
      iz += (Math.random() - 0.5) * jitter;
    }

    // Clamp magnitude to 1.0 so bots don't move faster than their stat.move_speed.
    const m = Math.hypot(ix, iz);
    if (m > 1.0) { ix /= m; iz /= m; }

    st.intentX = ix;
    st.intentZ = iz;
    st.jumpQueued = jump;
  }

  // Read the current intent vector for an AI actor (consumed per-frame in
  // index.js's motion integration). Returns {x, z, jump}.
  FS.actorFactory.getIntent = function (actor) {
    if (!actor || actor.control !== 'ai' || !actor.behavior) return { x: 0, z: 0, jump: false };
    const st = actor.behavior._internalState;
    return { x: st.intentX || 0, z: st.intentZ || 0, jump: !!st.jumpQueued };
  };

  // Consume the jump intent — call this when the bot actually jumps so the
  // next tick has to re-decide. Prevents holding-jump-on lock.
  FS.actorFactory.consumeJump = function (actor) {
    if (!actor || !actor.behavior) return;
    actor.behavior._internalState.jumpQueued = false;
  };

  // ===================================================================== //
  // Bot spawn helper — picks N non-player characters, finds non-center     //
  // tile XZ positions spaced apart, returns an array of Actors.            //
  // ===================================================================== //
  FS.actorFactory.spawnBots = function (scene, count, playerCharacterId, tiles) {
    const bots = [];
    const allIds = Object.keys(rosterById);
    const pool = allIds.filter(id => id !== playerCharacterId);
    if (pool.length === 0) return bots;

    // Without-replacement until exhausted, then with-replacement.
    const remaining = pool.slice();
    function pickCharacter() {
      if (remaining.length === 0) return pool[Math.floor(Math.random() * pool.length)];
      const i = Math.floor(Math.random() * remaining.length);
      return remaining.splice(i, 1)[0];
    }

    // Candidate spawn tiles: layer 0, not the center (q==0 && s==0).
    const layer0Tiles = (tiles || []).filter(t => t.layer === 0 && !(t.q === 0 && t.s === 0));
    const minSep = FS.botConfig.spawn_min_separation || 4.0;
    const used = [];

    for (let i = 0; i < count; i++) {
      const charId = pickCharacter();
      // Pick a tile that's at least minSep from previously-used spawns.
      let tile = null;
      const shuffled = layer0Tiles.slice().sort(() => Math.random() - 0.5);
      for (const t of shuffled) {
        let ok = true;
        for (const u of used) {
          if (Math.hypot(t.x - u.x, t.z - u.z) < minSep) { ok = false; break; }
        }
        if (ok) { tile = t; break; }
      }
      // Fallback — first tile from shuffled if separation can't be met.
      if (!tile && shuffled.length > 0) tile = shuffled[0];
      // Ultimate fallback — random ring offset around origin.
      const sx = tile ? tile.x : (Math.cos(i / count * Math.PI * 2) * 4);
      const sz = tile ? tile.z : (Math.sin(i / count * Math.PI * 2) * 4);
      used.push({ x: sx, z: sz });
      const id = `bot_${i}`;
      bots.push(FS.actorFactory.spawnBot(scene, charId, id, sx, sz));
    }
    return bots;
  };

})();
