// engines/fall-survive/mechanic/select.js
//
// Wave-3 character-select overlay. Renders 5 character cards on top of the
// running engine; on Start, persists the chosen character id to
// localStorage and posts a level_config message that triggers
// Game.startPlay() inside index.js's IIFE. The player Actor (built via
// actor.js's spawnPlayer) reads localStorage.fallSurvive.playerCharacter
// each spawn — so a fresh startPlay re-spawns the player as the chosen
// character with the right stats + visuals.
//
// Lifecycle: ALWAYS-ON-LOAD + after-each-round.
//   - Page load → overlay visible. Engine still auto-boots in the
//     background after 800 ms with the default character (sprinter); the
//     overlay covers the canvas so the player never sees the wrong-skin
//     run. When Start is clicked, postMessage triggers a fresh
//     Game.startPlay which tears down the auto-boot round and rebuilds
//     actors from the now-correct localStorage value.
//   - Round end (win or lose) → on retry / play-again, the overlay
//     re-shows so the player can swap characters. The end-banner's
//     existing "Play again" button is reused; we intercept its click,
//     hide the banner, and re-show the select screen instead of letting
//     index.js call Game.startPlay(Game.levelConfig) immediately.
//
// Mechanic-mode: the index.html `#mechanic-mode-shell-hide` block already
// hides #select-screen entirely when ?mechanic=1 is in the URL — host
// chrome owns character selection in that mode. This module still
// initializes (idempotent), but the overlay is display:none-d so its
// click handlers never fire.
//
// No new dependencies. Vanilla DOM, vanilla JS. Reads characters.json via
// fetch with a baked-in fallback roster mirroring actor.js's so the engine
// still works on file:// origins.

(function () {
  'use strict';

  // Mechanic-mode: stay quiet. The CSS already hides our overlay; we still
  // initialize so future host-driven re-shows would work, but we skip the
  // round-start interception since the host runs that pipeline.
  const IS_MECHANIC_MODE = (() => {
    try { return new URLSearchParams(location.search).get('mechanic') === '1'; }
    catch (_) { return false; }
  })();

  // ===================================================================== //
  // Roster — fetched async from characters.json with a baked fallback so   //
  // file:// origins (or a missing JSON) still render the overlay. The       //
  // fallback mirrors characters.json verbatim — keep in sync if the roster //
  // changes shape. (actor.js carries the same fallback for the same        //
  // reason; the two are independent reads of the same source-of-truth.)    //
  // ===================================================================== //
  const FALLBACK_CHARACTERS = [
    {
      id: 'sprinter', name: 'Sprinter',
      tagline: 'Fast and frail. Overcommits to the edge.',
      stats: { move_speed_mult: 1.40, jump_velocity_mult: 1.00, gravity_mult: 1.00 },
      visual: { color: '#ff5d8a', glow_color: '#ff9ec0', shape: 'capsule' },
    },
    {
      id: 'hopper', name: 'Hopper',
      tagline: 'Always jumping. Lighter than anything else.',
      stats: { move_speed_mult: 1.00, jump_velocity_mult: 1.40, gravity_mult: 0.85 },
      visual: { color: '#5dc8d8', glow_color: '#a0e8f0', shape: 'sphere' },
    },
    {
      id: 'boulder', name: 'Boulder',
      tagline: 'Slow, heavy, parks in the middle.',
      stats: { move_speed_mult: 0.70, jump_velocity_mult: 0.85, gravity_mult: 1.30 },
      visual: { color: '#8b6f3f', glow_color: '#c49a55', shape: 'cylinder' },
    },
    {
      id: 'dasher', name: 'Dasher',
      tagline: 'Charges spheres on purpose.',
      stats: { move_speed_mult: 1.20, jump_velocity_mult: 1.10, gravity_mult: 1.00 },
      visual: { color: '#e85da8', glow_color: '#f8a0d0', shape: 'capsule' },
    },
    {
      id: 'glider', name: 'Glider',
      tagline: 'Floaty. Lingers near the edge somehow surviving.',
      stats: { move_speed_mult: 1.00, jump_velocity_mult: 1.00, gravity_mult: 0.60 },
      visual: { color: '#a070ff', glow_color: '#d0b0ff', shape: 'capsule' },
    },
  ];

  // The canonical standalone level config — mirrors the 800ms-fallback
  // payload at the bottom of index.js. We hand this to the engine via
  // postMessage when the player clicks Start.
  const STANDALONE_LEVEL_CONFIG = {
    level: 1,
    target_duration_ms: 25000,
    wave_count: 4,
    wave_interval_ms: 5000,
    spheres_per_wave: 3,
    tile_fall_delay_ms: 800,
    ring_count: 4,
    objective_text: 'Survive 25 seconds',
  };

  // Stat preview is normalized to a 0..1 bar where 0.5 = 1.0× (baseline),
  // 0.0 = 0.5× (clamped slow), 1.0 = 1.5× (clamped fast). Engine
  // constants in characters.json sit between 0.6× and 1.4×, so this maps
  // well visually without overflowing.
  const STAT_BAR_RANGE = { lo: 0.5, hi: 1.5 };

  // The three stats we surface in the card preview. Some are higher-is-good
  // (move_speed, jump), one is inverted-display (gravity — heavy on the
  // right reads "stuck", but Boulder owns it; we just label it honestly).
  const STAT_DEFS = [
    { key: 'move_speed_mult', label: 'speed' },
    { key: 'jump_velocity_mult', label: 'jump' },
    { key: 'gravity_mult', label: 'gravity' },
  ];

  // ===================================================================== //
  // DOM rendering.                                                         //
  // ===================================================================== //
  const grid = document.getElementById('select-grid');
  const startBtn = document.getElementById('select-start');
  const screen = document.getElementById('select-screen');
  const hintEl = document.getElementById('select-hint');

  if (!grid || !startBtn || !screen) {
    // Defensive — index.html owns the scaffold; if it's missing we just
    // bail and let the engine boot to the default character.
    return;
  }

  let chosenId = null;

  function renderCards(characters) {
    grid.innerHTML = '';
    for (const ch of characters) {
      grid.appendChild(buildCard(ch));
    }
  }

  function buildCard(ch) {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.dataset.charId = ch.id;

    // Swatch row: colored shape disc + shape label pill.
    const swatchRow = document.createElement('div');
    swatchRow.className = 'char-swatch';
    const disc = document.createElement('div');
    disc.className = `char-swatch-disc shape-${(ch.visual && ch.visual.shape) || 'capsule'}`;
    const color = (ch.visual && ch.visual.color) || '#888';
    const glow = (ch.visual && ch.visual.glow_color) || color;
    disc.style.background = color;
    disc.style.border = `2px solid ${glow}`;
    disc.style.boxShadow = `0 0 12px ${hexAlpha(glow, 0.4)}, inset 0 -3px 6px rgba(0,0,0,0.25)`;
    swatchRow.appendChild(disc);
    const shapeTag = document.createElement('span');
    shapeTag.className = 'char-shape-tag';
    shapeTag.textContent = (ch.visual && ch.visual.shape) || 'capsule';
    swatchRow.appendChild(shapeTag);
    card.appendChild(swatchRow);

    // Name + tagline.
    const name = document.createElement('div');
    name.className = 'char-name';
    name.textContent = ch.name || ch.id;
    card.appendChild(name);

    const tag = document.createElement('div');
    tag.className = 'char-tagline';
    tag.textContent = ch.tagline || '';
    card.appendChild(tag);

    // Stats preview.
    const stats = document.createElement('div');
    stats.className = 'char-stats';
    for (const def of STAT_DEFS) {
      const v = (ch.stats && ch.stats[def.key] != null) ? ch.stats[def.key] : 1.0;
      stats.appendChild(buildStatRow(def.label, v));
    }
    card.appendChild(stats);

    // Selection handlers. Click works reliably on desktop; on Android some
    // browsers don't fire click consistently on div[role=radio], so we also
    // bind touchend (with a small drag-tolerance check so a swipe-to-scroll
    // attempt doesn't accidentally select). preventDefault on the touch
    // path stops the synthesized click that would otherwise double-fire.
    card.addEventListener('click', () => selectCard(ch.id));
    let _ts = null;
    card.addEventListener('touchstart', (ev) => {
      const t = ev.touches[0];
      if (!t) return;
      _ts = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    card.addEventListener('touchend', (ev) => {
      if (!_ts) return;
      const t = ev.changedTouches[0];
      const dragged = t ? Math.hypot(t.clientX - _ts.x, t.clientY - _ts.y) : 0;
      _ts = null;
      if (dragged > 20) return;
      ev.preventDefault();
      selectCard(ch.id);
    }, { passive: false });
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        selectCard(ch.id);
      }
    });

    return card;
  }

  function buildStatRow(label, value) {
    const row = document.createElement('div');
    row.className = 'char-stat-row';

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const bar = document.createElement('div');
    bar.className = 'char-stat-bar';
    const fill = document.createElement('div');
    fill.className = 'char-stat-fill';
    // Map value into 0..1 around the 0.5 baseline.
    const t = clamp((value - STAT_BAR_RANGE.lo) / (STAT_BAR_RANGE.hi - STAT_BAR_RANGE.lo), 0, 1);
    if (value >= 1.0) {
      // Fill to the right of the baseline tick.
      fill.style.left = '50%';
      fill.style.right = `${(1 - t) * 100}%`;
      fill.classList.add('over');
    } else {
      // Fill to the left of the baseline tick.
      fill.style.left = `${t * 100}%`;
      fill.style.right = '50%';
      fill.classList.add('under');
    }
    bar.appendChild(fill);
    row.appendChild(bar);

    const valEl = document.createElement('span');
    valEl.className = 'char-stat-val';
    valEl.textContent = `${value.toFixed(2)}×`;
    row.appendChild(valEl);

    return row;
  }

  function selectCard(id) {
    chosenId = id;
    const cards = grid.querySelectorAll('.char-card');
    cards.forEach((c) => {
      const isMe = c.dataset.charId === id;
      c.classList.toggle('selected', isMe);
      c.setAttribute('aria-checked', isMe ? 'true' : 'false');
    });
    startBtn.disabled = false;
    if (hintEl) hintEl.textContent = 'Press Start to drop in';
    // No-confirm UX: a card click immediately drops the player into the
    // round. The Start button stays as a fallback if anything intercepts
    // the card click, but the primary path is one-tap.
    startRound();
  }

  function showSelect() {
    screen.classList.remove('hidden');
    screen.setAttribute('aria-hidden', 'false');
    chosenId = null;
    startBtn.disabled = true;
    if (hintEl) hintEl.textContent = 'Click a card, then Start';
    const cards = grid.querySelectorAll('.char-card');
    cards.forEach((c) => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
    });
  }

  function hideSelect() {
    screen.classList.add('hidden');
    screen.setAttribute('aria-hidden', 'true');
  }

  // ===================================================================== //
  // Round-start trigger.                                                   //
  //                                                                        //
  // index.js's Game is IIFE-scoped — we can't call Game.startPlay()        //
  // directly. Instead we use the existing postMessage contract: the        //
  // engine's `window.addEventListener('message', ...)` handler accepts     //
  // {type: 'level_config', payload: {...}} and routes it through           //
  // Game.startPlay(payload), which calls resolvePlayerCharacterId() →      //
  // localStorage.getItem('fallSurvive.playerCharacter') for the player     //
  // Actor's character. Since we set localStorage just before posting,      //
  // the spawn picks up our choice.                                         //
  //                                                                        //
  // This is the same contract a host page would use; we just dispatch it   //
  // from same-window. window.parent === window in standalone, so the       //
  // engine's outbound postState/postEvent calls are no-ops (they early-    //
  // return on parent-is-self) — no infinite-loop risk.                     //
  // ===================================================================== //
  function startRound() {
    if (!chosenId) return;
    try {
      window.localStorage.setItem('fallSurvive.playerCharacter', chosenId);
    } catch (_) { /* private-mode / disabled storage — engine still has fallback */ }

    hideSelect();

    // Re-trigger Game.startPlay via postMessage. We post against `window`
    // (same-origin same-frame); the engine's `window.addEventListener`
    // catches it. Cloning the config so the engine can mutate it freely.
    try {
      window.postMessage({
        type: 'level_config',
        payload: Object.assign({}, STANDALONE_LEVEL_CONFIG),
      }, '*');
    } catch (_) {}
  }

  startBtn.addEventListener('click', startRound);

  // ===================================================================== //
  // Re-show on round end. The end-banner already has a "Play again" button //
  // wired in index.js — we don't want to break that path, but we DO want   //
  // to give the player a chance to swap characters. We intercept the       //
  // retry button via capture-phase listener: we re-show the select screen //
  // and stop propagation so index.js's handler doesn't fire startPlay      //
  // immediately. (We can't unbind the existing handler — that would touch  //
  // index.js territory.)                                                   //
  //                                                                        //
  // The end-banner stays visible behind the select overlay; we hide it     //
  // explicitly here so the visual hierarchy stays clean.                   //
  // ===================================================================== //
  const retryBtn = document.getElementById('end-retry');
  const endBanner = document.getElementById('end-banner');
  if (retryBtn) {
    retryBtn.addEventListener('click', (ev) => {
      // Capture-phase: intercept BEFORE index.js's bubble-phase listener.
      ev.stopPropagation();
      if (endBanner) endBanner.classList.remove('visible', 'lose');
      showSelect();
    }, /* capture */ true);
  }

  // ===================================================================== //
  // Boot — fetch the roster, render cards, show the screen (in standalone //
  // mode). Mechanic-mode keeps the screen display:none-d via the existing //
  // shellHide stylesheet; we still render the cards so a host that wants  //
  // to peek at them later sees a populated DOM.                            //
  // ===================================================================== //
  function boot() {
    // Try the JSON; fall back to the baked roster on any failure.
    fetch('./characters.json')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        const list = (j && Array.isArray(j.characters)) ? j.characters : FALLBACK_CHARACTERS;
        renderCards(list);
      })
      .catch(() => renderCards(FALLBACK_CHARACTERS));

    if (!IS_MECHANIC_MODE) {
      showSelect();
    }
  }
  boot();

  // ===================================================================== //
  // Helpers.                                                               //
  // ===================================================================== //
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexAlpha(hex, alpha) {
    // "#rrggbb" → "rgba(r, g, b, a)"; defensive for malformed input.
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) {
      return `rgba(255, 255, 255, ${alpha})`;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

})();
