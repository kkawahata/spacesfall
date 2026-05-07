// engines/fall-survive/mechanic/panel.js
//
// Wave-3 runtime tune panel. Right-side drawer that auto-discovers every
// `window.FallSurvive.{name}Config` knob across the loaded modules + a
// preset switcher, lets the player A/B 30 settings in one play session.
//
// Discovery contract:
//   - At boot (after engine + all modules loaded) walk window.FallSurvive
//     for keys ending in 'Config' whose value is a plain object.
//   - Recurse one level for nested objects (vfxConfig.{tile_telegraph,...}).
//   - Infer control type from value:
//       boolean      -> checkbox
//       number       -> slider+number (range from panel_meta or heuristic)
//       hex string   -> color picker
//       enum string  -> dropdown if panel_meta lists `enum`
//       array of N   -> N inline numeric inputs
//       string       -> text input
//   - panel_meta map (this file) overrides labels/min/max/step/enum/hint.
//
// Re-application strategy per namespace (live writeback always; the trigger
// below is fired on every change so the engine reflects the new value):
//   skyboxConfig    -> dispose current skybox + Hooks.setupSkybox(scene, levelConfig)
//   lightingConfig  -> Hooks.setupTileLighting(Game.tiles, scene, levelConfig)
//   weatherConfig   -> Hooks.setupWeather(scene, levelConfig)        (effects.js)
//   cameraShakeConfig -> read fresh per shake call; no re-call
//   trailConfig     -> Hooks.setupTrail(scene, Game.player)          (effects.js)
//   vfxConfig       -> read fresh per emit; no re-call
//   botConfig       -> read fresh per AI tick; no re-call
//   presetsConfig   -> Hooks.applyPreset(name) on dropdown change
//
// Hard rules: no new deps, vanilla DOM/JS. Hidden when ?mechanic=1 OR when
// the select-screen is visible. Toggle: backtick (`event.code === 'Backquote'`).
// Note: index.js binds backtick to toggle the AUTOWIN button — we run
// SECOND (loaded after index.js) and BOTH listeners fire, so the autowin
// button visibility may flicker in step with the panel. That's fine for an
// iteration tool.

(function () {
  'use strict';

  // =====================================================================
  // Mechanic-mode hide. Bind nothing in that mode; host owns chrome.
  // =====================================================================
  const IS_MECHANIC_MODE = (() => {
    try { return new URLSearchParams(location.search).get('mechanic') === '1'; }
    catch (_) { return false; }
  })();
  if (IS_MECHANIC_MODE) {
    // Still expose a stub so other modules can probe presence.
    window.FallSurvive = window.FallSurvive || {};
    window.FallSurvive.tunePanel = { enabled: false, reason: 'mechanic-mode' };
    return;
  }

  window.FallSurvive = window.FallSurvive || {};
  const Hooks = window.FallSurvive;

  // =====================================================================
  // panel_meta — label/range/enum overrides for known knobs. Modules don't
  // ship their own meta today, so this is the central authority. New
  // knobs without entries here fall back to heuristic inference.
  // Iteration: add a row for any new knob that needs a better range/label.
  // =====================================================================
  const PANEL_META = {
    lightingConfig: {
      enabled:                  { label: 'Master enable' },
      bpm:                      { min: 30, max: 200, step: 1, label: 'BPM', hint: 'Sweep cadence (beats/min)' },
      wavelength:               { min: 1, max: 30, step: 0.5, label: 'Wavelength', hint: 'World units per band' },
      sweep_axis_rotation_rate: { min: 0, max: 2, step: 0.01, label: 'Sweep rotation', hint: 'rad/sec axis tumble' },
      base_intensity:           { min: 0, max: 1, step: 0.01, label: 'Base intensity' },
      peak_intensity:           { min: 0, max: 1, step: 0.01, label: 'Peak intensity' },
      wave_shape_exponent:      { min: 0.3, max: 3, step: 0.05, label: 'Wave exponent' },
      layer_falloff:            { min: 0, max: 1, step: 0.01, label: 'Layer fall-off' },
      color_a:                  { label: 'Color A (crest)' },
      color_b:                  { label: 'Color B (trough)' },
      parity_tint_strength:     { min: 0, max: 0.4, step: 0.01, label: 'Parity tint' },
      pause_emissive_on_telegraph: { label: 'Pause on telegraph' },
      telegraph_emissive_floor: { label: 'Telegraph floor color' },
    },
    skyboxConfig: {
      color_zenith:        { label: 'Zenith color' },
      color_horizon:       { label: 'Horizon color' },
      color_ground:        { label: 'Ground color' },
      sun_color:           { label: 'Sun color' },
      sun_direction:       { label: 'Sun direction', hint: 'Normalized [x,y,z]' },
      sun_size:            { min: 0, max: 0.2, step: 0.005, label: 'Sun size' },
      sun_halo:            { min: 0, max: 0.4, step: 0.01, label: 'Sun halo' },
      cloud_color:         { label: 'Cloud color' },
      cloud_density:       { min: 0, max: 1, step: 0.01, label: 'Cloud density' },
      cloud_softness:      { min: 0, max: 1, step: 0.01, label: 'Cloud softness' },
      cloud_speed:         { min: 0, max: 2, step: 0.01, label: 'Cloud speed' },
      cloud_height:        { min: 0, max: 1, step: 0.01, label: 'Cloud height' },
      haze_strength:       { min: 0, max: 1, step: 0.01, label: 'Haze strength' },
      night:               { label: 'Night mode' },
      star_density:        { min: 0, max: 1, step: 0.01, label: 'Star density' },
      skybox_equirect_url: { label: 'Equirect URL' },
      skybox_cubemap_url:  { label: 'Cubemap URL (.env)' },
    },
    weatherConfig: {
      enabled:   { label: 'Master enable' },
      mode:      { enum: ['none', 'rain', 'snow', 'fog', 'dust'], label: 'Mode' },
      intensity: { min: 0, max: 1, step: 0.01, label: 'Intensity' },
    },
    cameraShakeConfig: {
      enabled:            { label: 'Master enable' },
      frequency:          { min: 5, max: 80, step: 1, label: 'Frequency (Hz)' },
      impact_magnitude:   { min: 0, max: 1, step: 0.01, label: 'Sphere impact' },
      tilefall_magnitude: { min: 0, max: 0.4, step: 0.005, label: 'Tile fall' },
      lose_magnitude:     { min: 0, max: 1.5, step: 0.01, label: 'Lose' },
    },
    trailConfig: {
      enabled:     { label: 'Master enable' },
      lifetime_ms: { min: 100, max: 2000, step: 50, label: 'Lifetime (ms)' },
      width:       { min: 0.05, max: 1.5, step: 0.05, label: 'Width' },
      bot_trails:  { label: 'Bots get trails too' },
    },
    botConfig: {
      count:                 { min: 0, max: 8, step: 1, label: 'Bot count', restartHint: true },
      spawn_min_separation:  { min: 1, max: 12, step: 0.5, label: 'Spawn separation', restartHint: true },
      behavior_tick_hz:      { min: 1, max: 30, step: 1, label: 'AI tick Hz' },
      cautious_pull_mult:    { min: 0, max: 3, step: 0.05, label: 'Cautious pull' },
      reckless_seek_mult:    { min: 0, max: 3, step: 0.05, label: 'Reckless seek' },
      aggressive_seek_mult:  { min: 0, max: 3, step: 0.05, label: 'Aggressive seek' },
      hopper_jump_mult:      { min: 0, max: 3, step: 0.05, label: 'Hopper jump' },
      edge_walker_pull_mult: { min: 0, max: 3, step: 0.05, label: 'Edge-walker pull' },
      wander_jitter:         { min: 0, max: 1, step: 0.02, label: 'Wander jitter' },
    },
    // vfxConfig is nested {moment: {fields...}} — heuristic ranges below
    // catch most of it; per-moment overrides authored sparingly.
    vfxConfig: {
      // Top-level meta is empty; nested handled in inferControl below.
    },
  };

  // Per-knob inference fallback when not in panel_meta. Keyed on the
  // bare knob name (NOT namespace.knob) so common shapes share heuristics.
  const NAME_HEURISTICS = {
    enabled:    { kind: 'bool' },
    count:      { min: 0, max: 200, step: 1 },
    rate:       { min: 0, max: 500, step: 5 },
    emitRate:   { min: 0, max: 500, step: 5 },
    burstMs:    { min: 10, max: 2000, step: 10 },
    durationMs: { min: 100, max: 5000, step: 50 },
    cleanupMs:  { min: 100, max: 5000, step: 50 },
    cooldownMs: { min: 0, max: 1000, step: 10 },
    lifeMin:    { min: 0.05, max: 3, step: 0.05 },
    lifeMax:    { min: 0.05, max: 3, step: 0.05 },
    sizeMin:    { min: 0.01, max: 1, step: 0.01 },
    sizeMax:    { min: 0.01, max: 1, step: 0.01 },
    gravityY:   { min: -20, max: 20, step: 0.5 },
    spreadXZ:   { min: 0, max: 5, step: 0.05 },
    velUp:      { min: 0, max: 10, step: 0.05 },
    velDown:    { min: 0, max: 10, step: 0.05 },
    velUpBias:  { min: 0, max: 5, step: 0.05 },
    yOffset:    { min: -2, max: 5, step: 0.05 },
  };

  // Re-apply hooks per namespace — invoked AFTER live writeback when a knob
  // changes. Each entry is a function that takes no args, swallows errors.
  function reapply(namespace) {
    const eng = Hooks.engine;
    if (!eng) return;
    const { scene, Game } = eng;
    const cfg = (Game && Game.levelConfig) ? Game.levelConfig : {};
    try {
      switch (namespace) {
        case 'skyboxConfig': {
          if (Hooks.setupSkybox && scene) {
            // The engine's applyIPTextures disposes the prior skybox before
            // calling setupSkybox; we have to do the same dispose here, but
            // there's no public handle. Best-effort: scene.getMeshByName.
            const candidates = ['skybox_shader', 'skybox_equirect', 'skybox_cube', 'skybox_fallback', 'skybox'];
            for (const name of candidates) {
              const m = scene.getMeshByName(name);
              if (m) try { m.dispose(); } catch (_) {}
            }
            Hooks.setupSkybox(scene, cfg);
          }
          break;
        }
        case 'lightingConfig': {
          if (Hooks.setupTileLighting && Game && scene) {
            Hooks.setupTileLighting(Game.tiles, scene, cfg);
          }
          break;
        }
        case 'weatherConfig': {
          if (Hooks.setupWeather && scene) {
            Hooks.setupWeather(scene, cfg);
          }
          break;
        }
        case 'trailConfig': {
          if (Hooks.setupTrail && scene && Game && Game.player) {
            Hooks.setupTrail(scene, Game.player);
          }
          break;
        }
        // cameraShakeConfig / vfxConfig / botConfig — read-fresh-per-event,
        // no re-call needed. The writeback IS the apply.
        default: break;
      }
    } catch (e) {
      console.warn('[panel] reapply failed for', namespace, e);
    }
  }

  // =====================================================================
  // Styles — inline so panel.js is self-contained, no extra fetch.
  // Aesthetic match to index.html: dark plate, accent border, monospace
  // labels, system-ui values. Sliders + chips reuse the engine palette.
  // =====================================================================
  const STYLE_TAG_ID = 'fs-tune-panel-style';
  function injectStyles() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_TAG_ID;
    s.textContent = `
#fs-tune-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(340px, 92vw);
  background: rgba(14, 14, 20, 0.92);
  border-left: 2px solid var(--col-accent, #6a8aff);
  color: #f0f0f0;
  font-family: 'Azeret Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  z-index: 999;
  transform: translateX(100%);
  transition: transform 180ms ease;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 14px 32px;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}
#fs-tune-panel.visible { transform: translateX(0); }
#fs-tune-panel-toggle {
  position: fixed; top: 12px; right: 12px;
  width: 32px; height: 32px;
  background: rgba(14, 14, 20, 0.78);
  border: 1px solid rgba(106, 138, 255, 0.4);
  border-radius: 999px;
  color: #f0f0f0;
  font: 700 14px/1 system-ui;
  cursor: pointer; user-select: none;
  z-index: 998;
  pointer-events: auto;
}
#fs-tune-panel-toggle:hover { background: rgba(36, 36, 48, 0.9); border-color: var(--col-accent, #6a8aff); }
#fs-tune-panel h3 {
  font-size: 13px; font-weight: 900;
  color: var(--col-accent, #6a8aff);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
#fs-tune-panel .panel-subtitle {
  font-size: 9px;
  letter-spacing: 0.1em;
  color: rgba(240, 240, 240, 0.45);
  margin-bottom: 14px;
}
#fs-tune-panel .preset-row {
  display: flex; gap: 6px; align-items: center;
  padding: 8px 10px;
  background: rgba(36, 36, 48, 0.6);
  border: 1px solid var(--col-mid, #3a3a48);
  border-radius: 8px;
  margin-bottom: 14px;
}
#fs-tune-panel .preset-row label {
  font-size: 10px; letter-spacing: 0.08em;
  color: rgba(240, 240, 240, 0.6);
  text-transform: uppercase;
}
#fs-tune-panel .preset-row select {
  flex: 1;
  background: rgba(14, 14, 20, 0.7);
  border: 1px solid var(--col-mid, #3a3a48);
  color: #f0f0f0;
  padding: 4px 6px;
  border-radius: 6px;
  font-family: inherit;
  font-size: 11px;
}
#fs-tune-panel fieldset {
  border: 1px solid var(--col-mid, #3a3a48);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: rgba(26, 26, 34, 0.55);
}
#fs-tune-panel fieldset.collapsed > .ns-body { display: none; }
#fs-tune-panel legend {
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.14em;
  color: var(--col-accent, #6a8aff);
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}
#fs-tune-panel legend::before { content: '▼ '; opacity: 0.6; font-size: 9px; }
#fs-tune-panel fieldset.collapsed > legend::before { content: '▶ '; }
#fs-tune-panel .knob {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px;
  margin: 6px 0;
}
#fs-tune-panel .knob-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 6px;
}
#fs-tune-panel .knob label {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: rgba(240, 240, 240, 0.78);
  font-family: 'Azeret Mono', ui-monospace, monospace;
  overflow-wrap: anywhere;
}
#fs-tune-panel .knob .hint {
  display: block;
  font-size: 9px;
  letter-spacing: 0.04em;
  color: rgba(240, 240, 240, 0.4);
  font-style: italic;
  margin-top: 2px;
}
#fs-tune-panel .knob .restart-tag {
  font-size: 8px;
  letter-spacing: 0.10em;
  color: var(--col-warn, #e85d5d);
  background: rgba(232, 93, 93, 0.10);
  border: 1px solid rgba(232, 93, 93, 0.3);
  border-radius: 999px;
  padding: 1px 6px;
  margin-left: 4px;
  text-transform: uppercase;
}
#fs-tune-panel input[type="range"] {
  width: 100%;
  accent-color: var(--col-accent, #6a8aff);
}
#fs-tune-panel input[type="number"],
#fs-tune-panel input[type="text"] {
  width: 80px;
  background: rgba(14, 14, 20, 0.7);
  color: #f0f0f0;
  border: 1px solid var(--col-mid, #3a3a48);
  border-radius: 4px;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 10px;
  text-align: right;
}
#fs-tune-panel input[type="text"] { text-align: left; width: 100%; }
#fs-tune-panel input[type="color"] {
  width: 36px; height: 22px;
  background: transparent;
  border: 1px solid var(--col-mid, #3a3a48);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
}
#fs-tune-panel input[type="checkbox"] {
  accent-color: var(--col-accent, #6a8aff);
  transform: scale(1.1);
}
#fs-tune-panel select {
  background: rgba(14, 14, 20, 0.7);
  color: #f0f0f0;
  border: 1px solid var(--col-mid, #3a3a48);
  border-radius: 4px;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 10px;
}
#fs-tune-panel .vec-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
#fs-tune-panel .vec-row input { width: 100%; }
#fs-tune-panel .panel-actions {
  display: flex; gap: 8px;
  margin-top: 6px;
}
#fs-tune-panel .panel-btn {
  flex: 1;
  background: var(--col-accent, #6a8aff);
  color: var(--col-deep, #0e0e14);
  border: none;
  padding: 6px 8px;
  border-radius: 6px;
  font-family: inherit;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  cursor: pointer;
}
#fs-tune-panel .panel-btn:hover { background: #8aa8ff; }
#fs-tune-panel .panel-btn.secondary {
  background: rgba(36, 36, 48, 0.9);
  color: #f0f0f0;
  border: 1px solid var(--col-mid, #3a3a48);
}
#fs-tune-panel.hidden { display: none !important; }
`;
    document.head.appendChild(s);
  }

  // =====================================================================
  // Discovery: walk window.FallSurvive for *Config keys.
  // =====================================================================
  function discoverConfigs() {
    const out = [];
    for (const key of Object.keys(Hooks)) {
      if (!key.endsWith('Config')) continue;
      const ref = Hooks[key];
      if (!ref || typeof ref !== 'object') continue;
      if (Array.isArray(ref)) continue;
      // Skip presetsConfig — it's surfaced as a dropdown above the
      // namespaced fieldsets, not as a regular knob group.
      if (key === 'presetsConfig') continue;
      out.push({ namespace: key, ref });
    }
    return out.sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  // =====================================================================
  // Control inference: (namespace, path[], value) -> control descriptor
  // path is an array of key names from namespace root to this leaf.
  // =====================================================================
  function inferControl(namespace, path, value) {
    const knobName = path[path.length - 1];
    const meta = (PANEL_META[namespace] && PANEL_META[namespace][knobName]) || {};

    // Boolean
    if (typeof value === 'boolean' || meta.kind === 'bool') {
      return { kind: 'bool', label: meta.label || knobName, hint: meta.hint, restartHint: meta.restartHint };
    }
    // Enum dropdown (panel_meta-driven)
    if (Array.isArray(meta.enum) && typeof value === 'string') {
      return { kind: 'enum', label: meta.label || knobName, hint: meta.hint, options: meta.enum.slice() };
    }
    // Hex color string
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
      return { kind: 'color', label: meta.label || knobName, hint: meta.hint };
    }
    // Plain string (URL, path, freeform label)
    if (typeof value === 'string' || value === null) {
      return { kind: 'text', label: meta.label || knobName, hint: meta.hint };
    }
    // Vector — array of numbers (e.g. sun_direction [x,y,z])
    if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
      return { kind: 'vec', label: meta.label || knobName, hint: meta.hint, length: value.length };
    }
    // Number
    if (typeof value === 'number') {
      const heur = NAME_HEURISTICS[knobName] || {};
      let min = (meta.min != null) ? meta.min : (heur.min != null ? heur.min : null);
      let max = (meta.max != null) ? meta.max : (heur.max != null ? heur.max : null);
      let step = (meta.step != null) ? meta.step : (heur.step != null ? heur.step : null);
      // Final fallback heuristics — keep slider sane even with no meta.
      if (min == null || max == null) {
        // Note: `??` cannot be mixed with `||` without parens — keep each
        // line a single nullish fallback. Order matters: 0..1 before 0..10
        // before 0..100, so a value of 0.5 doesn't widen to a 0..100 slider.
        if (value >= 0 && value <= 1) {
          if (min == null) min = 0;
          if (max == null) max = 1;
          if (step == null) step = 0.01;
        } else if (value >= 0 && value <= 10) {
          if (min == null) min = 0;
          if (max == null) max = 10;
          if (step == null) step = 0.1;
        } else if (value >= 0 && value <= 100) {
          if (min == null) min = 0;
          if (max == null) max = 100;
          if (step == null) step = 1;
        } else if (value < 0) {
          if (min == null) min = value * 2;
          if (max == null) max = Math.max(0, -value);
          if (step == null) step = 0.5;
        } else {
          if (min == null) min = 0;
          if (max == null) max = (value * 4) || 1;
          if (step == null) step = 0.1;
        }
      }
      return {
        kind: 'number', label: meta.label || knobName, hint: meta.hint,
        min, max, step, restartHint: meta.restartHint,
      };
    }
    // Nested object — caller will recurse.
    if (value && typeof value === 'object') {
      return { kind: 'nested', label: meta.label || knobName };
    }
    return { kind: 'text', label: meta.label || knobName, hint: meta.hint };
  }

  // =====================================================================
  // Builders — return a DOM node; on change, mutate `holder[key]` and call
  // onChange() to re-apply.
  // =====================================================================
  function makeBoolKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const row = document.createElement('div');
    row.className = 'knob-row';
    const label = document.createElement('label');
    label.textContent = ctl.label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!holder[key];
    input.addEventListener('change', () => {
      holder[key] = input.checked;
      onChange();
    });
    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeNumberKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const row = document.createElement('div');
    row.className = 'knob-row';
    const label = document.createElement('label');
    label.textContent = ctl.label;
    if (ctl.restartHint) {
      const tag = document.createElement('span');
      tag.className = 'restart-tag';
      tag.textContent = 'restart';
      label.appendChild(tag);
    }
    const valueEl = document.createElement('input');
    valueEl.type = 'number';
    valueEl.min = ctl.min;
    valueEl.max = ctl.max;
    valueEl.step = ctl.step;
    valueEl.value = holder[key];
    row.appendChild(label);
    row.appendChild(valueEl);
    wrap.appendChild(row);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = ctl.min;
    slider.max = ctl.max;
    slider.step = ctl.step;
    slider.value = holder[key];
    wrap.appendChild(slider);
    function commit(raw) {
      let v = parseFloat(raw);
      if (!Number.isFinite(v)) return;
      // Clamp number-input writes to range (slider does it natively).
      if (v < ctl.min) v = ctl.min;
      if (v > ctl.max) v = ctl.max;
      holder[key] = v;
      slider.value = v;
      valueEl.value = v;
      onChange();
    }
    slider.addEventListener('input', () => commit(slider.value));
    valueEl.addEventListener('change', () => commit(valueEl.value));
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeColorKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const row = document.createElement('div');
    row.className = 'knob-row';
    const label = document.createElement('label');
    label.textContent = ctl.label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = holder[key];
    input.addEventListener('input', () => {
      holder[key] = input.value;
      onChange();
    });
    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeEnumKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const row = document.createElement('div');
    row.className = 'knob-row';
    const label = document.createElement('label');
    label.textContent = ctl.label;
    const sel = document.createElement('select');
    for (const opt of ctl.options) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (holder[key] === opt) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      holder[key] = sel.value;
      onChange();
    });
    row.appendChild(label);
    row.appendChild(sel);
    wrap.appendChild(row);
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeTextKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const labelEl = document.createElement('label');
    labelEl.textContent = ctl.label;
    wrap.appendChild(labelEl);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = holder[key] == null ? '' : String(holder[key]);
    input.placeholder = '(null)';
    input.addEventListener('change', () => {
      holder[key] = input.value === '' ? null : input.value;
      onChange();
    });
    wrap.appendChild(input);
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeVecKnob(holder, key, ctl, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const labelEl = document.createElement('label');
    labelEl.textContent = ctl.label;
    wrap.appendChild(labelEl);
    const row = document.createElement('div');
    row.className = 'vec-row';
    const arr = holder[key];
    const inputs = [];
    for (let i = 0; i < arr.length; i++) {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 0.01;
      input.value = arr[i];
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        // Mutate IN PLACE — preserves the array identity callers may have
        // captured. Important for Babylon material.setVector3 cycles.
        arr[i] = v;
        onChange();
      });
      inputs.push(input);
      row.appendChild(input);
    }
    wrap.appendChild(row);
    if (ctl.hint) {
      const h = document.createElement('span');
      h.className = 'hint'; h.textContent = ctl.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function makeKnob(holder, key, ctl, onChange) {
    switch (ctl.kind) {
      case 'bool':   return makeBoolKnob(holder, key, ctl, onChange);
      case 'number': return makeNumberKnob(holder, key, ctl, onChange);
      case 'color':  return makeColorKnob(holder, key, ctl, onChange);
      case 'enum':   return makeEnumKnob(holder, key, ctl, onChange);
      case 'vec':    return makeVecKnob(holder, key, ctl, onChange);
      case 'text':
      default:       return makeTextKnob(holder, key, ctl, onChange);
    }
  }

  // Recursive nested fieldset for {moment:{...}} shapes (vfxConfig).
  function buildNestedSection(parent, namespace, path, holder, onChange) {
    for (const key of Object.keys(holder)) {
      const value = holder[key];
      const ctl = inferControl(namespace, path.concat([key]), value);
      if (ctl.kind === 'nested') {
        const subFs = document.createElement('fieldset');
        const subLg = document.createElement('legend');
        subLg.textContent = ctl.label;
        subLg.addEventListener('click', () => subFs.classList.toggle('collapsed'));
        subFs.appendChild(subLg);
        // Nested sections collapsed by default — vfxConfig has 5 moments and
        // expanded-by-default makes the panel a wall of widgets.
        subFs.classList.add('collapsed');
        const body = document.createElement('div');
        body.className = 'ns-body';
        subFs.appendChild(body);
        buildNestedSection(body, namespace, path.concat([key]), value, onChange);
        parent.appendChild(subFs);
      } else {
        parent.appendChild(makeKnob(holder, key, ctl, onChange));
      }
    }
  }

  // =====================================================================
  // Build the whole panel from discovered configs.
  // =====================================================================
  function buildPanel() {
    injectStyles();

    // Toggle button (top-right gear).
    let toggleBtn = document.getElementById('fs-tune-panel-toggle');
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.id = 'fs-tune-panel-toggle';
      toggleBtn.title = 'Tune panel (`)';
      toggleBtn.textContent = '⚙'; // gear
      document.body.appendChild(toggleBtn);
    }

    // Drawer.
    let panel = document.getElementById('fs-tune-panel');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'fs-tune-panel';

    const title = document.createElement('h3');
    title.textContent = 'Tune Panel';
    panel.appendChild(title);
    const sub = document.createElement('div');
    sub.className = 'panel-subtitle';
    sub.textContent = 'auto-discovered · backtick toggles';
    panel.appendChild(sub);

    // Preset row.
    const presets = Hooks.presetsConfig;
    if (presets && typeof presets === 'object' && presets.available) {
      const row = document.createElement('div');
      row.className = 'preset-row';
      const label = document.createElement('label');
      label.textContent = 'Preset';
      const sel = document.createElement('select');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '-- pick --';
      sel.appendChild(placeholder);
      for (const name of Object.keys(presets.available)) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        if (presets.current === name) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        if (Hooks.applyPreset) {
          try { Hooks.applyPreset(sel.value); }
          catch (e) { console.warn('[panel] applyPreset failed', e); }
          // Re-render to pick up mutated config values across namespaces.
          buildPanel();
          // Re-show after rebuild — buildPanel() recreates a hidden drawer.
          const fresh = document.getElementById('fs-tune-panel');
          if (fresh) fresh.classList.add('visible');
        }
      });
      row.appendChild(label);
      row.appendChild(sel);
      panel.appendChild(row);
    }

    // Per-namespace sections.
    const configs = discoverConfigs();
    if (configs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:0.5;font-size:10px;padding:14px;text-align:center;';
      empty.textContent = 'no *Config namespaces discovered';
      panel.appendChild(empty);
    }

    for (const { namespace, ref } of configs) {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = namespace.replace(/Config$/, '');
      lg.addEventListener('click', () => fs.classList.toggle('collapsed'));
      fs.appendChild(lg);
      const body = document.createElement('div');
      body.className = 'ns-body';
      fs.appendChild(body);

      // Re-application closure scoped to this namespace.
      const onChange = () => reapply(namespace);
      buildNestedSection(body, namespace, [], ref, onChange);
      panel.appendChild(fs);
    }

    // Bottom action row.
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    const applyAll = document.createElement('button');
    applyAll.className = 'panel-btn';
    applyAll.textContent = 'Apply all';
    applyAll.title = 'Re-fire every setup hook';
    applyAll.addEventListener('click', () => {
      for (const { namespace } of configs) reapply(namespace);
    });
    const restart = document.createElement('button');
    restart.className = 'panel-btn secondary';
    restart.textContent = 'Restart round';
    restart.title = 'Re-run Game.startPlay with current levelConfig';
    restart.addEventListener('click', () => {
      const eng = Hooks.engine;
      if (eng && eng.Game && eng.Game.levelConfig) {
        try { eng.Game.startPlay(eng.Game.levelConfig); }
        catch (e) { console.warn('[panel] restart failed', e); }
      }
    });
    actions.appendChild(applyAll);
    actions.appendChild(restart);
    panel.appendChild(actions);

    document.body.appendChild(panel);

    // Wire toggle button.
    toggleBtn.onclick = () => panel.classList.toggle('visible');

    return panel;
  }

  // =====================================================================
  // Visibility gating — hide panel + toggle while the select-screen is up.
  // The select screen is non-display:none-d when visible (it has `inset:0`
  // and starts as the only interactive surface). We watch for class /
  // attribute changes on it OR poll computed display.
  // =====================================================================
  function selectScreenVisible() {
    const s = document.getElementById('select-screen');
    if (!s) return false;
    // select.js toggles `.hidden` class to hide; mechanic-mode style hides
    // it with display:none. Also check inline display:none for safety.
    const cs = window.getComputedStyle(s);
    return cs.display !== 'none' && !s.classList.contains('hidden');
  }

  function applyVisibilityGate() {
    const panel = document.getElementById('fs-tune-panel');
    const toggle = document.getElementById('fs-tune-panel-toggle');
    if (!panel || !toggle) return;
    if (selectScreenVisible()) {
      panel.classList.add('hidden');
      toggle.classList.add('hidden');
      // Force-close — don't let it bleed under the overlay.
      panel.classList.remove('visible');
    } else {
      panel.classList.remove('hidden');
      toggle.classList.remove('hidden');
    }
  }

  // =====================================================================
  // Boot — wait for engine + module IIFEs to register their *Config keys.
  // index.js publishes Hooks.engine on boot; we use that as a readiness
  // signal. Fall back to 1500 ms timeout.
  // =====================================================================
  function ready(then) {
    const start = performance.now();
    function tick() {
      if (Hooks.engine && Hooks.engine.scene) return then();
      if (performance.now() - start > 1500) return then();
      requestAnimationFrame(tick);
    }
    tick();
  }

  function init() {
    ready(() => {
      const panel = buildPanel();

      // Backtick toggle. NB: index.js binds the same key to toggle the
      // AUTOWIN debug button — both fire. We don't preventDefault since
      // the AUTOWIN behavior is intentional and harmless.
      window.addEventListener('keydown', (ev) => {
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA')) return;
        if (ev.code === 'Backquote') {
          if (selectScreenVisible()) return;
          panel.classList.toggle('visible');
        }
      });

      // Visibility gate: re-evaluate on a short interval AND when the
      // select-screen mutates. MutationObserver is cheap and fires on
      // both class-list changes and inline-style changes.
      applyVisibilityGate();
      const sel = document.getElementById('select-screen');
      if (sel && typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver(applyVisibilityGate);
        mo.observe(sel, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
      }
      // Also poll — covers the head-injected mechanic-mode <style> which
      // doesn't trigger the per-element MutationObserver.
      setInterval(applyVisibilityGate, 500);

      // Public surface for other modules / smoke tests.
      Hooks.tunePanel = {
        enabled: true,
        rebuild: buildPanel,
        toggle:  () => panel.classList.toggle('visible'),
        show:    () => panel.classList.add('visible'),
        hide:    () => panel.classList.remove('visible'),
        discoverConfigs,
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
