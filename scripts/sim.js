/* ============================================================
   RunRoute — Street View run preview (sim.js)
   One StreetViewPanorama per page lifetime (billing-safe §5.2):
   all lookups via StreetViewService.getPanorama (free), all
   stepping via setPano (not billed), close = setVisible(false).
   Builds on app.js globals: RR, $, toast().
   ============================================================ */

"use strict";

(function () {

  var SAMPLE_STEP_M = 50;
  var PANO_RADIUS_M = 50;
  var STOP_RADIUS_M = 40;
  var JUMP_SAMPLES = 10;
  var PREFETCH_AHEAD = 6;
  var MAX_CONCURRENT = 4;
  var GAP_RUN = 3;          // consecutive nulls before the gap chip
  var GAP_CHIP_MS = 2500;
  var STOP_PAUSE_MS = 2000;

  var SPEEDS = [
    { label: "0.5×", aria: "Playback speed: 0.5x", ms: 2000 },
    { label: "1×",   aria: "Playback speed: 1x",   ms: 1000 },
    { label: "2×",   aria: "Playback speed: 2x",   ms: 500 }
  ];

  /* §5.2 panorama options — verbatim. */
  var PANO_OPTIONS = {
    disableDefaultUI: true, clickToGo: false, motionTracking: false, motionTrackingControl: false,
    linksControl: false, addressControl: false, enableCloseButton: false, showRoadLabels: true,
    zoomControl: false, fullscreenControl: false
  };

  /* Static SVG strings only — never user content. */
  var ICON_PLAY =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  var ICON_PAUSE =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 5h3.5v14H6.5zM14 5h3.5v14H14z"/></svg>';
  var ICON_REPLAY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.75 12a7.25 7.25 0 1 1 2.12 5.13"/><path d="M4.75 16.75V12h4.75"/></svg>';

  var els = null;   // bound lazily on first open (scripts load before <body>)

  var state = {
    pano: null,         // the ONE StreetViewPanorama — created once, reused forever
    svc: null,          // StreetViewService (metadata lookups, free)
    open: false,
    session: 0,         // bumped per open/close to invalidate stale async work
    seekToken: 0,
    seeking: false,     // the current seekToken's chain has not landed or ended yet
    gapHold: false,     // gap chip stays up past GAP_CHIP_MS until the walk lands
    samples: [],        // [{ latLng, cumM }]
    totalM: 0,
    cache: [],          // sample index -> panoId string | null; undefined = unknown
    waiters: {},        // sample index -> [cb] while a lookup is in flight/queued
    queue: [],
    inflight: 0,
    idx: 0,
    lastPanoId: null,
    playing: false,
    atEnd: false,
    speedIdx: 1,        // default 1x (matches scaffold label/aria)
    timer: null,
    chipTimer: null,
    stops: []           // [{ name, latLng, k, fired }]
  };

  /* ---------------- Small helpers ---------------- */

  function sph() { return google.maps.geometry.spherical; }

  function toLatLng(loc) {
    if (!loc) return null;
    if (typeof loc.lat === "function") return loc;
    if (typeof loc.lat === "number" && typeof loc.lng === "number") {
      return new google.maps.LatLng(loc.lat, loc.lng);
    }
    return null;
  }

  function say(msg) {
    if (typeof toast === "function") toast(msg);
  }

  /* ---------------- Lazy DOM binding ---------------- */

  function bindOnce() {
    if (els) return true;
    if (typeof $ !== "function") return false;
    var overlay = $("svOverlay"), pano = $("svPano"), gap = $("svGap"),
        pos = $("svPos"), scrub = $("svScrub"), play = $("svPlay"),
        prev = $("svPrev"), next = $("svNext"), speed = $("svSpeed"),
        closeBtn = $("svClose");
    if (!overlay || !pano || !gap || !pos || !scrub || !play ||
        !prev || !next || !speed || !closeBtn) return false;

    els = {
      overlay: overlay, pano: pano, gap: gap, pos: pos, scrub: scrub,
      play: play, prev: prev, next: next, speed: speed, close: closeBtn
    };

    play.addEventListener("click", togglePlay);
    prev.addEventListener("click", function () { jumpBy(-JUMP_SAMPLES); });
    next.addEventListener("click", function () { jumpBy(JUMP_SAMPLES); });
    speed.addEventListener("click", cycleSpeed);
    closeBtn.addEventListener("click", closeSim);

    scrub.addEventListener("input", function () {
      if (!state.open) return;
      setPlaying(false);
      var v = parseInt(scrub.value, 10);
      if (!isNaN(v)) seekNearest(v);
    });

    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && state.open && state.playing) setPlaying(false);
    });

    applySpeedLabel();
    return true;
  }

  /* ---------------- Open / close ---------------- */

  function openSim() {
    if (state.open) return;
    if (!window.RR || !window.google || !google.maps ||
        !google.maps.geometry || !google.maps.geometry.spherical) return;

    var dir = (RR.directionsRenderer && RR.directionsRenderer.getDirections)
      ? RR.directionsRenderer.getDirections() : null;
    var route = dir && dir.routes && dir.routes[0];
    if (!route || !route.overview_path || !route.overview_path.length) {
      say("Build a route first.");
      return;
    }

    if (!bindOnce()) return;

    if (!state.pano) {
      /* The one panorama per page lifetime. Never destroyed, never recreated. */
      try {
        state.pano = new google.maps.StreetViewPanorama(els.pano, PANO_OPTIONS);
        state.svc = new google.maps.StreetViewService();
      } catch (e) {
        state.pano = null;
        state.svc = null;
        return;
      }
    }

    var built = buildSamples(route.overview_path);
    if (!built.samples.length) {
      say("Build a route first.");
      return;
    }

    state.session++;
    state.seekToken++;
    state.samples = built.samples;
    state.totalM = built.totalM;
    state.cache = [];
    state.waiters = {};
    state.queue = [];
    state.idx = 0;
    state.lastPanoId = null;
    state.playing = false;
    state.atEnd = false;
    state.stops = buildStops(route);
    state.seeking = false;
    state.gapHold = false;
    cancelTick();
    clearTimeout(state.chipTimer);
    state.chipTimer = null;

    els.scrub.max = String(state.samples.length - 1);
    els.scrub.value = "0";
    updatePos();
    setPlayIcon("play");
    applySpeedLabel();

    document.body.classList.add("sv-open");
    els.overlay.hidden = false;
    showChip("Finding imagery…", 0);   // untimed: stays until the first pano lands
    try { els.close.focus(); } catch (e) { /* ignore */ }

    state.open = true;
    /* Start paused on the first resolvable pano. */
    seekForward(0, {
      suppressGap: true,
      onExhausted: function () {
        say("No Street View coverage along this route.");
        closeSim();
      }
    });
  }

  function closeSim() {
    if (!state.open) return;
    state.open = false;
    state.session++;
    state.seekToken++;
    state.playing = false;
    state.atEnd = false;
    state.seeking = false;
    state.gapHold = false;
    cancelTick();
    clearTimeout(state.chipTimer);
    state.chipTimer = null;
    if (els) {
      if (els.gap) els.gap.hidden = true;
      if (els.overlay) els.overlay.hidden = true;
    }
    if (state.pano) {
      try { state.pano.setVisible(false); } catch (e) { /* ignore */ }
    }
    document.body.classList.remove("sv-open");
    if (typeof $ === "function") {
      var pb = $("previewBtn");
      if (pb) { try { pb.focus(); } catch (e) { /* ignore */ } }
    }
  }

  /* ---------------- Sampling (§5.3.1) ---------------- */

  function buildSamples(path) {
    var samples = [];
    var cum = 0;
    if (!path || !path.length) return { samples: samples, totalM: 0 };
    samples.push({ latLng: path[0], cumM: 0 });
    var nextMark = SAMPLE_STEP_M;
    for (var i = 0; i < path.length - 1; i++) {
      var a = path[i], b = path[i + 1];
      var d = sph().computeDistanceBetween(a, b);
      if (!(d > 0)) continue;
      while (nextMark <= cum + d) {
        var f = (nextMark - cum) / d;
        samples.push({ latLng: sph().interpolate(a, b, f), cumM: nextMark });
        nextMark += SAMPLE_STEP_M;
      }
      cum += d;
    }
    if (cum - samples[samples.length - 1].cumM > 1) {
      samples.push({ latLng: path[path.length - 1], cumM: cum });
    }
    return { samples: samples, totalM: cum };
  }

  /* Stops in route visit order, from the snapshot calculateRoute() takes
     when the route is built (drag-safe; see app.js RR.visitStops). */
  function buildStops(route) {
    var out = [];
    var snap = (RR.visitStops && RR.visitStops.length) ? RR.visitStops : [];
    if (!snap.length) {
      try { RR.selected.forEach(function (s) { snap.push(s); }); } catch (e) { return out; }
    }
    for (var i = 0; i < snap.length; i++) {
      var s = snap[i];
      if (!s) continue;
      var ll = toLatLng(s.location);
      if (!ll) continue;
      out.push({ name: String(s.name || ""), latLng: ll, k: i + 1, fired: false });
    }
    return out;
  }

  /* ---------------- Pano metadata cache (§5.3.2, free lookups) ---------------- */

  function ensure(i, cb) {
    if (i < 0 || i >= state.samples.length) { if (cb) cb(null); return; }
    var v = state.cache[i];
    if (v !== undefined) { if (cb) cb(v); return; }
    if (state.waiters[i]) { if (cb) state.waiters[i].push(cb); return; }
    state.waiters[i] = cb ? [cb] : [];
    state.queue.push(i);
    pump();
  }

  function pump() {
    while (state.inflight < MAX_CONCURRENT && state.queue.length) {
      requestPano(state.queue.shift());
    }
  }

  function requestPano(i) {
    var cacheRef = state.cache;     // capture this session's stores: a late
    var waitersRef = state.waiters; // response never pollutes a newer session
    var s = state.samples[i];
    var done = false;

    function finishReq(id) {
      if (done) return;
      done = true;
      state.inflight--;
      cacheRef[i] = id;
      var w = waitersRef[i] || [];
      delete waitersRef[i];
      for (var k = 0; k < w.length; k++) {
        try { w[k](id); } catch (e) { /* ignore */ }
      }
      pump();
    }

    if (!s || !state.svc) {
      state.inflight++;
      finishReq(null);
      return;
    }

    state.inflight++;
    var okStatus = google.maps.StreetViewStatus ? google.maps.StreetViewStatus.OK : "OK";
    var pref = (google.maps.StreetViewPreference && google.maps.StreetViewPreference.NEAREST) || "nearest";
    var src = (google.maps.StreetViewSource && google.maps.StreetViewSource.OUTDOOR) || "outdoor";
    try {
      var ret = state.svc.getPanorama(
        { location: s.latLng, radius: PANO_RADIUS_M, preference: pref, source: src },
        function (data, status) {
          var id = null;
          if (status === okStatus && data && data.location && data.location.pano) {
            id = data.location.pano;
          }
          finishReq(id);   // ZERO_RESULTS (or anything non-OK) -> null
        }
      );
      /* Newer builds also return a promise that rejects on ZERO_RESULTS —
         swallow it so the callback path stays the single source of truth. */
      if (ret && typeof ret.catch === "function") ret.catch(function () { /* handled via callback */ });
    } catch (e) {
      finishReq(null);
    }
  }

  function prefetch(from) {
    for (var j = from + 1; j <= from + PREFETCH_AHEAD; j++) ensure(j);
  }

  /* ---------------- Chip (#svGap) ---------------- */

  function showChip(text, ms) {
    if (!els || !els.gap) return;
    els.gap.textContent = text;
    els.gap.hidden = false;
    clearTimeout(state.chipTimer);
    state.chipTimer = null;
    if (ms) {
      state.chipTimer = setTimeout(function () {
        state.chipTimer = null;
        if (els.gap && !state.gapHold) els.gap.hidden = true;
      }, ms);
    }
  }

  /* Ends the gap chip's hold; hides it now unless its minimum time is still running. */
  function releaseGapChip() {
    if (!state.gapHold) return;
    state.gapHold = false;
    if (!state.chipTimer && els && els.gap) els.gap.hidden = true;
  }

  /* Hides only an untimed chip (the loading state); a timed chip
     (gap-skip / stop) keeps its own 2–2.5 s on screen. */
  function clearLoadingChip() {
    if (!els || !els.gap) return;
    if (state.chipTimer) return;
    els.gap.hidden = true;
  }

  /* ---------------- Landing, POV, stops ---------------- */

  function headingAt(i) {
    var s = state.samples;
    if (s.length < 2) return 0;
    if (i < s.length - 1) return sph().computeHeading(s[i].latLng, s[i + 1].latLng);
    return sph().computeHeading(s[i - 1].latLng, s[i].latLng);
  }

  function updatePos() {
    if (!els || !els.pos || !state.samples.length) return;
    var i = Math.min(state.idx, state.samples.length - 1);
    var at = state.samples[i].cumM / 1000;
    els.pos.textContent = at.toFixed(1) + " of " + (state.totalM / 1000).toFixed(1) + " km";
  }

  /* Returns true when a stop chip fired (caller stretches the next tick). */
  function landAt(i, id) {
    state.idx = i;
    state.atEnd = false;
    if (id !== state.lastPanoId) {
      state.lastPanoId = id;
      try { state.pano.setPano(id); } catch (e) { /* ignore */ }
    }
    try { if (!state.pano.getVisible()) state.pano.setVisible(true); } catch (e) { /* ignore */ }
    try { state.pano.setPov({ heading: headingAt(i), pitch: 0 }); } catch (e) { /* ignore */ }
    if (els.scrub) els.scrub.value = String(i);
    updatePos();
    state.seeking = false;
    releaseGapChip();
    clearLoadingChip();
    prefetch(i);
    return checkStops(i);
  }

  function checkStops(i) {
    var pt = state.samples[i].latLng;
    for (var k = 0; k < state.stops.length; k++) {
      var st = state.stops[k];
      if (st.fired) continue;
      var d;
      try { d = sph().computeDistanceBetween(pt, st.latLng); } catch (e) { continue; }
      if (d <= STOP_RADIUS_M) {
        st.fired = true;   // once per playback
        showChip("Stop " + st.k + " · " + st.name, STOP_PAUSE_MS);
        return true;
      }
    }
    return false;
  }

  /* ---------------- Playback ---------------- */

  function setPlayIcon(kind) {
    if (!els || !els.play) return;
    if (kind === "pause") {
      els.play.innerHTML = ICON_PAUSE;
      els.play.setAttribute("aria-label", "Pause");
    } else if (kind === "replay") {
      els.play.innerHTML = ICON_REPLAY;
      els.play.setAttribute("aria-label", "Replay");
    } else {
      els.play.innerHTML = ICON_PLAY;
      els.play.setAttribute("aria-label", "Play");
    }
  }

  function setPlaying(on) {
    cancelTick();
    state.playing = !!on;
    if (on) {
      state.atEnd = false;
      setPlayIcon("pause");
      /* A seek still walking schedules the next tick when it lands. */
      if (!state.seeking) scheduleTick(SPEEDS[state.speedIdx].ms);
    } else if (!state.atEnd) {
      setPlayIcon("play");
    }
  }

  function scheduleTick(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, ms);
  }

  function cancelTick() {
    clearTimeout(state.timer);
    state.timer = null;
  }

  /* For a seek that ended without landing: keep playback moving. */
  function resumeTicking() {
    state.seeking = false;
    if (state.playing) scheduleTick(SPEEDS[state.speedIdx].ms);
  }

  function tick() {
    state.timer = null;
    if (!state.open || !state.playing) return;
    seekForward(state.idx + 1);
  }

  function togglePlay() {
    if (!state.open) return;
    if (state.atEnd) { replay(); return; }
    setPlaying(!state.playing);
  }

  function replay() {
    state.atEnd = false;
    state.lastPanoId = null;
    for (var i = 0; i < state.stops.length; i++) state.stops[i].fired = false;
    state.playing = true;
    setPlayIcon("pause");
    cancelTick();
    seekForward(0);
  }

  function reachEnd() {
    state.idx = state.samples.length ? state.samples.length - 1 : 0;
    if (els && els.scrub) els.scrub.value = String(state.idx);
    updatePos();
    cancelTick();
    state.seeking = false;
    releaseGapChip();
    state.playing = false;
    state.atEnd = true;
    setPlayIcon("replay");
  }

  function cycleSpeed() {
    state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
    applySpeedLabel();
    if (state.playing && state.timer) scheduleTick(SPEEDS[state.speedIdx].ms);
  }

  function applySpeedLabel() {
    if (!els || !els.speed) return;
    var sp = SPEEDS[state.speedIdx];
    els.speed.textContent = sp.label;
    els.speed.setAttribute("aria-label", sp.aria);
  }

  /* Walk forward from `start` to the next landable sample.
     - null samples count toward the gap chip (3 consecutive -> chip 2.5 s,
       keep skipping to the next resolvable sample)
     - a sample resolving to the current panoId is skipped silently (dedupe)
     - running off the end -> reachEnd() (or opts.onExhausted on first open) */
  function seekForward(start, opts) {
    opts = opts || {};
    var sess = state.session;
    var token = ++state.seekToken;
    var nulls = 0;
    state.seeking = true;
    releaseGapChip();

    function tryIdx(i) {
      if (sess !== state.session || token !== state.seekToken || !state.open) return;
      if (i >= state.samples.length) {
        if (opts.onExhausted) opts.onExhausted();
        else reachEnd();
        return;
      }
      ensure(i, function (id) {
        if (sess !== state.session || token !== state.seekToken || !state.open) return;
        if (id === null) {
          nulls++;
          if (nulls === GAP_RUN && !opts.suppressGap) {
            state.gapHold = true;
            showChip("No Street View along this stretch — skipping ahead…", GAP_CHIP_MS);
          }
          prefetch(i);   // landAt's prefetch stops at idx+6; keep the gap walk 4-wide
          tryIdx(i + 1);
          return;
        }
        if (id === state.lastPanoId) { tryIdx(i + 1); return; }
        var stopHit = landAt(i, id);
        if (state.playing) scheduleTick(stopHit ? STOP_PAUSE_MS : SPEEDS[state.speedIdx].ms);
      });
    }
    tryIdx(start);
  }

  /* Seek to the resolvable sample nearest to `target` (scrub, ±10 jumps). */
  function seekNearest(target) {
    var n = state.samples.length;
    if (!n) return;
    if (target < 0) target = 0;
    if (target > n - 1) target = n - 1;
    var sess = state.session;
    var token = ++state.seekToken;
    state.seeking = true;
    cancelTick();   // a pending tick would start a forward walk that supersedes this seek
    releaseGapChip();

    var cand = [target];
    for (var d = 1; d < n; d++) {
      if (target + d <= n - 1) cand.push(target + d);
      if (target - d >= 0) cand.push(target - d);
    }
    var p = 0;

    function tryNext() {
      if (sess !== state.session || token !== state.seekToken || !state.open) return;
      if (p >= cand.length) { resumeTicking(); return; }   // nothing resolvable anywhere: stay put
      var i = cand[p++];
      ensure(i, function (id) {
        if (sess !== state.session || token !== state.seekToken || !state.open) return;
        if (id === null) { tryNext(); return; }
        var stopHit = landAt(i, id);
        if (state.playing) scheduleTick(stopHit ? STOP_PAUSE_MS : SPEEDS[state.speedIdx].ms);
      });
    }
    tryNext();
  }

  function jumpBy(n) {
    if (!state.open) return;
    seekNearest(state.idx + n);
  }

  /* Single-sample step for ArrowLeft/Right: next distinct pano in that direction. */
  function stepDir(dir) {
    var sess = state.session;
    var token = ++state.seekToken;
    state.seeking = true;
    cancelTick();
    releaseGapChip();

    function tryIdx(i) {
      if (sess !== state.session || token !== state.seekToken || !state.open) return;
      if (i < 0 || i >= state.samples.length) { resumeTicking(); return; }
      ensure(i, function (id) {
        if (sess !== state.session || token !== state.seekToken || !state.open) return;
        if (id === null || id === state.lastPanoId) { tryIdx(i + dir); return; }
        var stopHit = landAt(i, id);
        if (state.playing) scheduleTick(stopHit ? STOP_PAUSE_MS : SPEEDS[state.speedIdx].ms);
      });
    }
    tryIdx(state.idx + dir);
  }

  /* ---------------- Keyboard ---------------- */

  function onKey(e) {
    if (!state.open) return;
    var key = e.key;
    if (key === "Escape" || key === "Esc") {
      e.preventDefault();
      closeSim();
      return;
    }
    if (key === " " || key === "Spacebar") {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (els && document.activeElement === els.scrub) return; // range handles arrows itself
    if (key === "ArrowRight") {
      e.preventDefault();
      stepDir(1);
    } else if (key === "ArrowLeft") {
      e.preventDefault();
      stepDir(-1);
    }
  }

  /* ---------------- Public API ---------------- */

  window.RRSim = { open: openSim };

})();
