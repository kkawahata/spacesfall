// engines/fall-survive/mechanic/announcements.js
//
// Wave-5 items 5 + 6 — popup announcements + bottom-right toasts.
//
// Two surfaces:
//   1) Popup overlay      — full-screen centered message ("FINAL 5",
//                           "FINAL 3", "FINAL TWO", "ELIMINATED!"). Bouncy
//                           cubic-bezier overshoot entrance, ~1.5s visible.
//                           Queued so back-to-back milestones don't stomp.
//   2) Toast notification — bottom-right pill ("Boulder eliminated • 3
//                           left") for non-player bot deaths. Single-slot:
//                           a fresh death replaces whatever's currently
//                           visible. Fades out after ~1.8s.
//
// Trigger sources:
//   - We poll Hooks.engine.Game.actors each frame from updateAnnouncements()
//     (called via a private rAF — keeps coupling to index.js zero). On
//     each frame we diff the alive bot count: if a bot just died, fire a
//     toast. Player + bots compete for the "alive total" counter; we fire
//     milestones at total-alive 5/3/2 (matching falling-clean).
//   - We chain-wrap Hooks.onLose so when the engine fires it (player kill_y
//     in play mode, all-actors-dead in observer mode) we queue the
//     ELIMINATED! popup. The original handler still runs — vfx.js's lose
//     particle burst is preserved.
//
// Mechanic-mode: index.html injects a stylesheet that hides
// #announcements-popup + #announcements-toast (host owns chrome). We still
// build the DOM + run the diff loop so the engine's wave-3 character
// select round-end semantics keep working — they don't depend on us, but
// it's cheaper to no-op via display:none than to add an IS_MECHANIC_MODE
// branch on every event path.
//
// No dependencies. Vanilla DOM. Reads from window.FallSurvive.engine.

(function () {
  'use strict';

  window.FallSurvive = window.FallSurvive || {};
  const FS = window.FallSurvive;

  // ===================================================================== //
  // Tunable knobs. Surfaces in panel.js's auto-walk under                  //
  // window.FallSurvive.announcementsConfig + splatsConfig. The splat       //
  // config lives here too — it's logically per-actor-death, so co-locating //
  // with the toast (per-actor-death too) keeps the per-actor-death surface //
  // in one bag. vfx.js consumes splatsConfig at spawn time.                //
  // ===================================================================== //
  FS.announcementsConfig = FS.announcementsConfig || {
    enabled:     true,
    popup_ms:    1500,    // popup visible duration
    popup_fade_ms: 240,   // exit fade-out — pre-pull from queue gap
    toast_ms:    1800,    // toast visible duration
    font_size:   60,      // popup font size in px (display class)
    bounce_curve: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    color_default: '#ffffff',
    color_eliminated: '#ff5577',
    milestones:  [5, 3, 2],   // alive counts that trigger "FINAL N" popups
  };

  // splatsConfig lives in vfx.js (item 8 territory). We just call
  // FS.spawnSplat(actor, scene) from the death-diff loop below.

  // ===================================================================== //
  // DOM bootstrap — built lazily on first popup or toast call so the page  //
  // doesn't have orphan elements if the engine never fires.                //
  // ===================================================================== //
  let _popupEl = null;
  let _toastEl = null;
  function ensurePopupEl() {
    if (_popupEl) return _popupEl;
    const cfg = FS.announcementsConfig;
    const el = document.createElement('div');
    el.id = 'announcements-popup';
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed',
      'top:30%',
      'left:50%',
      'transform:translate(-50%,-50%) scale(0.5)',
      `font:900 ${cfg.font_size}px/1 system-ui,-apple-system,"Segoe UI",sans-serif`,
      'letter-spacing:6px',
      'color:#fff',
      'text-shadow:0 4px 0 #2c4ec2,0 8px 30px rgba(0,0,0,0.6)',
      'pointer-events:none',
      'opacity:0',
      'z-index:15',
      `transition:transform 220ms ${cfg.bounce_curve},opacity 220ms`,
      'text-transform:uppercase',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
    _popupEl = el;
    return el;
  }
  function ensureToastEl() {
    if (_toastEl) return _toastEl;
    const el = document.createElement('div');
    el.id = 'announcements-toast';
    el.style.cssText = [
      'position:fixed',
      'right:22px',
      'bottom:22px',
      'padding:10px 18px',
      'background:rgba(14,14,20,0.78)',
      'border:2px solid rgba(106,138,255,0.5)',
      'border-radius:999px',
      'font:700 13px/1 system-ui,-apple-system,sans-serif',
      'letter-spacing:0.06em',
      'color:#f0f0f0',
      'pointer-events:none',
      'z-index:14',
      'opacity:0',
      'transform:translateY(8px)',
      'transition:opacity 180ms ease,transform 180ms ease',
    ].join(';');
    document.body.appendChild(el);
    _toastEl = el;
    return el;
  }

  // ===================================================================== //
  // Popup queue — back-to-back milestones (alive: 5 → 3 → 2 in quick       //
  // succession) play sequentially instead of stomping each other.          //
  // ===================================================================== //
  const _popupQueue = [];
  let _popupActive = false;
  let _popupTimer = 0;

  function announceOnce(text, color) {
    if (!FS.announcementsConfig.enabled) return;
    _popupQueue.push({ text: String(text), color: color || null });
    if (!_popupActive) drainPopup();
  }

  function drainPopup() {
    const next = _popupQueue.shift();
    if (!next) {
      _popupActive = false;
      return;
    }
    _popupActive = true;
    const el = ensurePopupEl();
    const cfg = FS.announcementsConfig;
    el.textContent = next.text;
    el.style.color = next.color || cfg.color_default;
    // Force reflow so the transition replays even on back-to-back popups.
    void el.offsetWidth;
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%,-50%) scale(1)';
    clearTimeout(_popupTimer);
    _popupTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-50%) scale(0.5)';
      setTimeout(drainPopup, cfg.popup_fade_ms);
    }, cfg.popup_ms);
  }

  // ===================================================================== //
  // Toast — single-slot. New toasts replace whatever's currently shown.    //
  // Per-bot-death recurrence; volume scales with surviving bot count, so   //
  // bunching is fine — at FINAL 2 there are at most 2 toasts left to fire. //
  // ===================================================================== //
  let _toastTimer = 0;
  function toast(text) {
    if (!FS.announcementsConfig.enabled) return;
    const el = ensureToastEl();
    const cfg = FS.announcementsConfig;
    el.textContent = String(text);
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    }, cfg.toast_ms);
  }

  // Public surface — both functions are also wired by the diff loop below.
  FS.announceOnce = announceOnce;
  FS.toast = toast;

  // ===================================================================== //
  // Death diff loop — polls Hooks.engine.Game.actors each frame and        //
  // detects newly-dead bots (alive flipped true → false). For each, fires  //
  // a toast with the bot's character name. Tracks a milestone set so each  //
  // FINAL N popup fires once per round; resets on round-start (which we    //
  // detect via Game.stateIndex === States.PLAYING with a fresh actor       //
  // roster — we cache the actor array reference and clear milestones if    //
  // it changes).                                                           //
  // ===================================================================== //
  const _alivePrev = new Map();          // actor → was-alive
  const _shownMilestones = new Set();    // milestone Ns shown this round
  let _lastAliveTotal = -1;              // for round-restart detection (count goes UP)
  let _playerWasAlive = true;

  function getEngine() {
    return FS.engine || null;
  }

  function actorDisplayName(actor) {
    if (!actor) return 'someone';
    // Actor.character on the actor record carries the chosen character id.
    // Capitalize for display ("boulder" → "Boulder"). Fall back to a
    // neutral noun if the field is missing.
    const id = actor.character || actor.characterId || (actor.character_data && actor.character_data.id);
    if (typeof id === 'string' && id.length > 0) {
      return id.charAt(0).toUpperCase() + id.slice(1);
    }
    if (actor.control === 'input') return 'You';
    return 'Bot';
  }

  function totalAliveCount(actors) {
    let n = 0;
    for (const a of actors) {
      if (a && a.alive) n++;
    }
    return n;
  }

  function checkMilestones(aliveTotal) {
    const cfg = FS.announcementsConfig;
    if (!Array.isArray(cfg.milestones)) return;
    for (const N of cfg.milestones) {
      if (aliveTotal === N && !_shownMilestones.has(N)) {
        _shownMilestones.add(N);
        // "FINAL 2" → "FINAL TWO" matches the variant's spelled-out
        // last-pair branding. Other milestones use digits.
        const text = N === 2 ? 'FINAL TWO' : `FINAL ${N}`;
        announceOnce(text);
      }
    }
  }

  function tickDeathDiff() {
    const eng = getEngine();
    if (!eng || !eng.Game || !Array.isArray(eng.Game.actors)) return;
    const actors = eng.Game.actors;

    // Round detection — Game.actors is the SAME array reference across
    // rounds (index.js does `Game.actors.length = 0` then re-push), so we
    // can't trust reference identity. Instead, watch the alive count: a
    // round restart re-spawns N actors fresh, so totalAlive jumps UP from
    // a low number to a high one. We detect ascending transitions and
    // reset the milestone set + per-actor memory of stale dead bots.
    const aliveNow = totalAliveCount(actors);
    if (_lastAliveTotal >= 0 && aliveNow > _lastAliveTotal + 1) {
      // Ascending jump (>=2 alive at once that weren't there last frame)
      // — round restart. Wipe stale per-actor entries: the prior round's
      // dead bots are about to be re-replaced with fresh actor objects,
      // so the Map keys (object identity) become orphaned.
      _alivePrev.clear();
      _shownMilestones.clear();
      _playerWasAlive = true;
    }
    _lastAliveTotal = aliveNow;
    // Drop stale Map keys that aren't in the current actors array. Cheap
    // O(N*M) but N+M is small (<=15 actors). Without this the Map grows
    // unbounded across many rounds.
    if (_alivePrev.size > actors.length * 2) {
      const liveSet = new Set(actors);
      for (const k of Array.from(_alivePrev.keys())) {
        if (!liveSet.has(k)) _alivePrev.delete(k);
      }
    }

    // Diff: for each actor, fire toast + splat on the alive→dead transition.
    // We also snapshot last-known mesh.position EVERY frame the actor's
    // mesh is intact — by the time we observe alive=false, index.js has
    // already disposed the mesh (disposeActor sets actor.mesh = null
    // before flipping actor.alive). So actor._lastPos is the only way to
    // recover where the splat should land.
    for (const actor of actors) {
      if (!actor) continue;
      // Position snapshot — only when actor is still alive AND mesh exists.
      if (actor.alive && actor.mesh && actor.mesh.position) {
        const p = actor.mesh.position;
        if (!actor._lastPos) {
          actor._lastPos = { x: 0, y: 0, z: 0 };
        }
        actor._lastPos.x = p.x;
        actor._lastPos.y = p.y;
        actor._lastPos.z = p.z;
      }
      const wasAlive = _alivePrev.has(actor) ? _alivePrev.get(actor) : true;
      const isAlive = !!actor.alive;
      if (wasAlive && !isAlive) {
        // Newly dead. Spawn splat + fire toast (player gets the popup
        // path via the onLose wrap below — toast is bot-only).
        if (typeof FS.spawnSplat === 'function' && eng.scene) {
          try { FS.spawnSplat(actor, eng.scene); } catch (_) {}
        }
        if (actor.control === 'ai') {
          const aliveAfter = totalAliveCount(actors);
          const tail = aliveAfter > 0 ? ` • ${aliveAfter} left` : '';
          toast(`${actorDisplayName(actor)} eliminated${tail}`);
        }
      }
      _alivePrev.set(actor, isAlive);
    }

    // Milestone check — FINAL 5 / 3 / 2 fires only while player is still
    // alive (matches falling-clean behavior — once you're out, the
    // big-screen messaging shifts to ELIMINATED).
    const playerAlive = _isPlayerAlive(actors);
    if (playerAlive) {
      checkMilestones(totalAliveCount(actors));
    }
    _playerWasAlive = playerAlive;
  }

  function _isPlayerAlive(actors) {
    for (const a of actors) {
      if (a && a.control === 'input') return !!a.alive;
    }
    // Observer mode has no player — milestones still fire as long as some
    // bot is alive. We treat "no player exists" as alive=true for
    // milestone gating so observer-mode rounds get the FINAL N popups.
    return true;
  }

  // ===================================================================== //
  // onLose chain — wrap the existing FS.onLose (vfx.js's lose burst) so    //
  // we don't replace it. We capture it lazily on first frame so we don't   //
  // race vfx.js IIFE registration order (vfx.js loads BEFORE this file in  //
  // index.html, so it should be set already, but the lazy capture is      //
  // defensive against future re-ordering). We only wrap once — guarded by  //
  // _onLoseWrapped.                                                        //
  // ===================================================================== //
  let _onLoseWrapped = false;
  function maybeWrapOnLose() {
    if (_onLoseWrapped) return;
    const orig = FS.onLose;
    FS.onLose = function (scene) {
      // Only fire ELIMINATED! if there was actually a player in the round.
      // Observer mode has only AI actors — the lose path fires when all
      // bots are gone, but there's no "you" to be eliminated. The toasts
      // already covered each bot's death; the popup would be confusing.
      try {
        const eng = getEngine();
        const hadPlayer = !!(eng && eng.Game && eng.Game.player);
        if (hadPlayer) {
          announceOnce('ELIMINATED!', FS.announcementsConfig.color_eliminated);
        }
      } catch (_) {}
      if (typeof orig === 'function') {
        try { orig(scene); } catch (_) {}
      }
    };
    _onLoseWrapped = true;
  }

  // ===================================================================== //
  // Self-driven rAF tick. We don't piggy-back on Hooks.updateVfx because   //
  // updateVfx only runs in PLAYING state (per index.js HOOK_VFX_UPDATE     //
  // gate); we want the death diff to keep running into the lose-fired     //
  // frame so the player's mesh-removal triggers the popup. Cheap — just   //
  // a Map walk per frame.                                                  //
  // ===================================================================== //
  function loop() {
    try {
      maybeWrapOnLose();
      tickDeathDiff();
    } catch (_) { /* never let a stray error nuke the loop */ }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

})();
