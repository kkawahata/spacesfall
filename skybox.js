// engines/fall-survive/mechanic/skybox.js
//
// Wave-1 skybox pipeline-spike — registers `window.FallSurvive.setupSkybox`,
// which the host calls from index.js's `applyIPTextures` after disposing the
// engine's default gradient skybox.
//
// PIPELINE-SPIKE WINNER: Approach A — procedural shader skybox.
// (Approaches B/C/D evaluated and deferred — see SKYBOX_NOTES.md.)
//
// Why A: cheapest IP iteration loop. Every knob is a config field → tweak hex
// codes / floats in level_config (or in skyboxConfig defaults) and reload. No
// gen-pipeline call per IP, no seam-cohesion problem, no API integration. The
// procedural shader registers genre mood (sunset / void / storm / midday) via
// 4 colors + 3 floats + a bool. That covers ~70% of "atmospheric register"
// work. The other 30% (painted distant cityscape, hand-drawn sky character,
// IP-specific landmarks on the horizon) is what an equirect/cubemap would
// buy — but those workflows have unsolved seam problems that would block
// iteration. Saved for a Round-2 upgrade path (see SKYBOX_NOTES.md§deferred).
//
// IP register surface (all overridable via level_config / skyboxConfig):
//   - color_zenith, color_horizon, color_ground   — 3-band gradient
//   - sun_color, sun_direction (Vec3), sun_size   — sun disc
//   - cloud_color, cloud_density, cloud_softness  — fbm clouds
//   - star_density (when night-mode bool set)     — twinkling stars
//   - haze_strength                               — horizon haze band

(function () {
  'use strict';
  window.FallSurvive = window.FallSurvive || {};

  // =====================================================================
  // skyboxConfig — every tunable knob lives here with a docstring.
  // IP-level overrides come from `cfg` (passed via level_config) and merge
  // OVER these defaults.  CLI iteration: tweak any field, reload, see it.
  // =====================================================================
  const DEFAULT_CONFIG = {
    // 3-band vertical gradient. Painted top → horizon → ground (the lower
    // hemisphere is mostly hidden by the platform but bleeds into the
    // horizon region). Hex strings; the shader linearly blends between them
    // along the world-Y axis.
    //
    // WAVE-5: defaults shift to a warm sunset register (deep blue-purple
    // zenith → peach horizon → cream ground). Inspired by the falling-clean
    // variant's sunset palette but slightly desaturated so the candy preset
    // still has somewhere to push more vivid. Reads as "atmospheric / warm"
    // even at neutral, regardless of which IP later overrides.
    color_zenith:   '#2c3a78',  // deep blue-purple (slightly desat from #1b2a6b)
    color_horizon:  '#ff9a78',  // warm peach (slightly desat from #ff8a6b)
    color_ground:   '#ffd9b3',  // cream — bleeds up into the horizon band

    // Sun disc. Single directional sphere painted in screen space along
    // sun_direction. Set sun_size to 0 to disable.
    // WAVE-5: warmer disc + lower in the sky for the sunset register.
    sun_color:      '#ffc488',  // golden-peach disc + halo
    sun_direction:  [0.4, 0.25, 0.6],  // NORMALIZED direction TO sun (lower → sunset feel)
    sun_size:       0.08,        // angular half-size — 0..0.2 sane range
    sun_halo:       0.18,        // soft halo radius — 0..0.3

    // Volumetric clouds via fbm noise. Sampled along view-direction in the
    // upper hemisphere. cloud_density 0 hides clouds entirely.
    // WAVE-5: in-shader fbm clouds are subtle distance-haze backing the
    // mesh-based candy clouds (effects.js#cloudsConfig). Density dialed
    // down so the two cloud channels don't fight each other.
    cloud_color:     '#fff2dc',
    cloud_density:   0.20,       // 0 = clear sky; 0.8 = overcast
    cloud_softness:  0.85,       // 0 = hard noise edges; 1 = wispy
    cloud_speed:     0.0,        // animation speed; 0 = static (cheaper)
    cloud_height:    0.30,       // 0 = clouds start at horizon; 1 = only zenith

    // Horizon haze. Soft gradient band where the sky meets the horizon.
    haze_strength:   0.45,       // sunset reads warmer with stronger horizon band

    // Night mode. When true, switches to a darker base palette and adds
    // procedural twinkling stars in the upper hemisphere.
    night:           false,
    star_density:    0.4,        // (only used when night=true) 0 = clear; 1 = milky way

    // External-asset escape hatches. Future-proof for Approach B/C wins.
    // skybox_equirect_url: when set, mounts a 2:1 equirect PNG/JPG as an
    // emissive panoramic texture. Bypasses the procedural shader entirely.
    skybox_equirect_url: null,
    // skybox_cubemap_url: when set, mounts a Babylon CubeTexture (.env, .dds,
    // or _px/_py/...png convention). Same bypass.
    skybox_cubemap_url:  null,
  };

  // Public knob-bag: hosts and CLI iteration agents may mutate this between
  // levels to override defaults. cfg from level_config still wins per call.
  window.FallSurvive.skyboxConfig = Object.assign({}, DEFAULT_CONFIG);

  // =====================================================================
  // Helpers — hex / vec / config merging.
  // =====================================================================
  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return [1, 1, 1];
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }
  function normalize3(v) {
    const x = v[0] || 0, y = v[1] || 0, z = v[2] || 0;
    const n = Math.hypot(x, y, z) || 1;
    return [x / n, y / n, z / n];
  }
  // Pulls each tunable from cfg (level_config payload) → falls back to
  // window.FallSurvive.skyboxConfig → falls back to DEFAULT_CONFIG.
  function resolve(cfg) {
    const c = window.FallSurvive.skyboxConfig || {};
    const out = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (cfg && cfg[k] != null) out[k] = cfg[k];
      else if (c[k] != null) out[k] = c[k];
      else out[k] = DEFAULT_CONFIG[k];
    }
    // Back-compat: legacy cfg.skybox_color (already documented in mechanic.json)
    // overrides the zenith color and shifts the horizon toward it. Keeps the
    // "give me one hex and call it a day" path working.
    if (cfg && cfg.skybox_color && !cfg.color_zenith) {
      out.color_zenith = cfg.skybox_color;
    }
    // Back-compat: cfg.skybox_url routes to the equirect or cubemap branch
    // depending on extension. Existing index.js already handles .env directly,
    // but the hook-based path is now canonical.
    if (cfg && cfg.skybox_url && !cfg.skybox_equirect_url && !cfg.skybox_cubemap_url) {
      if (/\.env$|\.dds$/i.test(cfg.skybox_url)) out.skybox_cubemap_url = cfg.skybox_url;
      else if (/\.(png|jpg|jpeg|webp|hdr)$/i.test(cfg.skybox_url)) out.skybox_equirect_url = cfg.skybox_url;
    }
    return out;
  }

  // =====================================================================
  // GLSL — shipped inline so the engine has no extra fetches at boot.
  // Vertex: standard skybox passthrough; we ship view-direction to the
  // fragment for sky math.
  //
  // Fragment: 3-band gradient + sun disc + cloud fbm + horizon haze + stars.
  // Math is straightforward; comments inline. ~120 LOC of GLSL.
  // =====================================================================
  const VERTEX_SRC = `
    precision highp float;
    attribute vec3 position;
    uniform mat4 worldViewProjection;
    uniform mat4 world;
    varying vec3 vPos;
    void main(void) {
      vPos = position;  // local position works — skybox is centered at origin
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;
  const FRAGMENT_SRC = `
    precision highp float;
    varying vec3 vPos;

    uniform vec3  uZenith;       // gradient top
    uniform vec3  uHorizon;      // gradient mid
    uniform vec3  uGround;       // gradient bottom
    uniform vec3  uSunColor;
    uniform vec3  uSunDir;       // normalized — direction TO sun
    uniform float uSunSize;
    uniform float uSunHalo;
    uniform vec3  uCloudColor;
    uniform float uCloudDensity;
    uniform float uCloudSoftness;
    uniform float uCloudSpeed;
    uniform float uCloudHeight;
    uniform float uHaze;
    uniform float uTime;
    uniform float uNight;        // 0/1 flag from JS
    uniform float uStarDensity;

    // Hash + value-noise + fbm. Cheap procedural cloud field.
    float hash(vec3 p) {
      return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
    }
    float vnoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);  // smoothstep
      float n000 = hash(i);
      float n100 = hash(i + vec3(1, 0, 0));
      float n010 = hash(i + vec3(0, 1, 0));
      float n110 = hash(i + vec3(1, 1, 0));
      float n001 = hash(i + vec3(0, 0, 1));
      float n101 = hash(i + vec3(1, 0, 1));
      float n011 = hash(i + vec3(0, 1, 1));
      float n111 = hash(i + vec3(1, 1, 1));
      return mix(
        mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
        mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
        f.z
      );
    }
    float fbm(vec3 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * vnoise(p);
        p *= 2.0;
        a *= 0.5;
      }
      return v;
    }

    void main(void) {
      vec3 dir = normalize(vPos);
      float t = clamp(dir.y, -1.0, 1.0);

      // ---- 3-band gradient ----
      // Above horizon: blend horizon → zenith.
      // Below horizon: blend horizon → ground.
      vec3 sky;
      if (t > 0.0) {
        sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, t));
      } else {
        sky = mix(uHorizon, uGround, smoothstep(0.0, 0.5, -t));
      }

      // ---- Horizon haze band ----
      // Slightly brighten + warm-shift the horizon band, falling off in both
      // directions. Cheap "atmosphere depth" cue.
      float hazeBand = exp(-pow(t * 8.0, 2.0));
      sky = mix(sky, uHorizon * 1.15, hazeBand * uHaze);

      // ---- Clouds ----
      // Sample fbm at the intersection of the view ray with a virtual cloud
      // plane at y = uCloudHeight (clamped). Below uCloudHeight, no clouds.
      if (uCloudDensity > 0.001 && t > uCloudHeight) {
        float cy = (1.0 - uCloudHeight);
        // project ray to cloud plane (cheap horizontal mapping)
        vec2 uv = dir.xz / max(t, 0.05);
        vec3 cloudP = vec3(uv * 1.5, uTime * uCloudSpeed * 0.3);
        float n = fbm(cloudP);
        // Soft threshold: cloud_density shifts the threshold; cloud_softness
        // controls smoothstep width.
        float thresh = mix(0.65, 0.25, uCloudDensity);
        float width  = mix(0.05, 0.4, uCloudSoftness);
        float cloud  = smoothstep(thresh, thresh + width, n);
        // Fade clouds toward the zenith for a domed feel.
        float fade   = smoothstep(uCloudHeight, uCloudHeight + 0.1, t) *
                       (1.0 - smoothstep(0.7, 1.0, t) * 0.5);
        sky = mix(sky, uCloudColor, cloud * fade);
      }

      // ---- Stars (night only) ----
      if (uNight > 0.5 && t > 0.0) {
        float starField = hash(floor(dir * 200.0));
        float starThresh = 1.0 - uStarDensity * 0.04;
        float star = smoothstep(starThresh, 1.0, starField);
        // Twinkle via uTime
        float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + starField * 100.0);
        sky += vec3(1.0) * star * twinkle * 0.8 * t;  // fade into horizon
      }

      // ---- Sun disc ----
      if (uSunSize > 0.001) {
        float dotSun = dot(dir, normalize(uSunDir));
        float disc   = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.6, dotSun);
        float halo   = smoothstep(1.0 - uSunSize - uSunHalo, 1.0 - uSunSize, dotSun);
        sky = mix(sky, uSunColor, disc);
        sky += uSunColor * halo * 0.4;
      }

      gl_FragColor = vec4(sky, 1.0);
    }
  `;

  // =====================================================================
  // Shader-skybox builder — Approach A.
  // =====================================================================
  function buildShaderSkybox(scene, resolved) {
    // Register shader sources in Babylon's ShaderStore.
    const SHADER_NAME = 'fallSurviveSky';
    BABYLON.Effect.ShadersStore[SHADER_NAME + 'VertexShader']   = VERTEX_SRC;
    BABYLON.Effect.ShadersStore[SHADER_NAME + 'FragmentShader'] = FRAGMENT_SRC;

    const skybox = BABYLON.MeshBuilder.CreateBox('skybox_shader', { size: 2000 }, scene);
    const mat = new BABYLON.ShaderMaterial(
      'skyboxShaderMat',
      scene,
      SHADER_NAME,
      {
        attributes: ['position'],
        uniforms: [
          'world', 'worldView', 'worldViewProjection', 'view', 'projection',
          'uZenith', 'uHorizon', 'uGround',
          'uSunColor', 'uSunDir', 'uSunSize', 'uSunHalo',
          'uCloudColor', 'uCloudDensity', 'uCloudSoftness',
          'uCloudSpeed', 'uCloudHeight',
          'uHaze', 'uTime', 'uNight', 'uStarDensity',
        ],
      }
    );
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    skybox.material = mat;
    skybox.infiniteDistance = true;

    // Push uniforms.
    const zen = hexToRgb(resolved.color_zenith);
    const hor = hexToRgb(resolved.color_horizon);
    const grd = hexToRgb(resolved.color_ground);
    const sun = hexToRgb(resolved.sun_color);
    const cld = hexToRgb(resolved.cloud_color);
    const sunDir = normalize3(resolved.sun_direction);

    mat.setVector3('uZenith',     new BABYLON.Vector3(zen[0], zen[1], zen[2]));
    mat.setVector3('uHorizon',    new BABYLON.Vector3(hor[0], hor[1], hor[2]));
    mat.setVector3('uGround',     new BABYLON.Vector3(grd[0], grd[1], grd[2]));
    mat.setVector3('uSunColor',   new BABYLON.Vector3(sun[0], sun[1], sun[2]));
    mat.setVector3('uSunDir',     new BABYLON.Vector3(sunDir[0], sunDir[1], sunDir[2]));
    mat.setFloat('uSunSize',      resolved.sun_size);
    mat.setFloat('uSunHalo',      resolved.sun_halo);
    mat.setVector3('uCloudColor', new BABYLON.Vector3(cld[0], cld[1], cld[2]));
    mat.setFloat('uCloudDensity', resolved.cloud_density);
    mat.setFloat('uCloudSoftness', resolved.cloud_softness);
    mat.setFloat('uCloudSpeed',   resolved.cloud_speed);
    mat.setFloat('uCloudHeight',  resolved.cloud_height);
    mat.setFloat('uHaze',         resolved.haze_strength);
    mat.setFloat('uNight',        resolved.night ? 1.0 : 0.0);
    mat.setFloat('uStarDensity',  resolved.star_density);

    // Animate uTime each frame for cloud drift / star twinkle. We register a
    // beforeRender observer scoped to this material so it dies with the mesh.
    let elapsed = 0;
    const observer = scene.onBeforeRenderObservable.add(() => {
      elapsed += scene.getEngine().getDeltaTime() / 1000;
      mat.setFloat('uTime', elapsed);
    });
    skybox.onDisposeObservable.add(() => {
      try { scene.onBeforeRenderObservable.remove(observer); } catch (_) {}
    });

    return skybox;
  }

  // =====================================================================
  // Equirect-texture builder — Approach B (deferred, but the seam is the
  // implementation's only blocker, so the wiring is here for when a
  // seam-coherent painter / API lands).
  // =====================================================================
  function buildEquirectSkybox(scene, url) {
    const skybox = BABYLON.MeshBuilder.CreateSphere(
      'skybox_equirect',
      { diameter: 2000, segments: 32, sideOrientation: BABYLON.Mesh.BACKSIDE },
      scene
    );
    const mat = new BABYLON.StandardMaterial('skyboxEquirectMat', scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    const tex = new BABYLON.Texture(url, scene);
    tex.coordinatesMode = BABYLON.Texture.SPHERICAL_MODE;
    mat.emissiveTexture = tex;
    skybox.material = mat;
    skybox.infiniteDistance = true;
    return skybox;
  }

  // =====================================================================
  // Cubemap builder — Approach C (deferred, but plumbed for .env / .dds).
  // =====================================================================
  function buildCubemapSkybox(scene, url) {
    const skybox = BABYLON.MeshBuilder.CreateBox('skybox_cube', { size: 2000 }, scene);
    const mat = new BABYLON.StandardMaterial('skyboxCubeMat', scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.reflectionTexture = new BABYLON.CubeTexture(url, scene);
    mat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
    skybox.material = mat;
    skybox.infiniteDistance = true;
    return skybox;
  }

  // =====================================================================
  // The hook itself — index.js calls this AFTER disposing whatever skybox
  // it built. We pick a build path based on resolved config + return the
  // mesh. Any failure falls back to the procedural shader (free + reliable).
  // =====================================================================
  window.FallSurvive.setupSkybox = function setupSkybox(scene, cfg) {
    const resolved = resolve(cfg || {});

    // Bypass to cubemap if URL provided (Approach C escape hatch).
    if (resolved.skybox_cubemap_url) {
      try { return buildCubemapSkybox(scene, resolved.skybox_cubemap_url); }
      catch (e) { console.warn('[skybox] cubemap failed, falling back to shader:', e); }
    }
    // Bypass to equirect if URL provided (Approach B escape hatch).
    if (resolved.skybox_equirect_url) {
      try { return buildEquirectSkybox(scene, resolved.skybox_equirect_url); }
      catch (e) { console.warn('[skybox] equirect failed, falling back to shader:', e); }
    }
    // Canonical path — procedural shader (Approach A, the winner).
    try { return buildShaderSkybox(scene, resolved); }
    catch (e) {
      console.warn('[skybox] shader failed, falling back to gradient box:', e);
      // Last-ditch fallback: vertical-gradient box matching the engine's
      // pre-hook default, so a complete shader compile failure is still
      // playable.
      const skybox = BABYLON.MeshBuilder.CreateBox('skybox_fallback', { size: 2000 }, scene);
      const mat = new BABYLON.StandardMaterial('skyboxFallbackMat', scene);
      mat.backFaceCulling = false;
      mat.disableLighting = true;
      mat.emissiveColor = BABYLON.Color3.FromHexString(resolved.color_zenith);
      skybox.material = mat;
      skybox.infiniteDistance = true;
      return skybox;
    }
  };
})();
