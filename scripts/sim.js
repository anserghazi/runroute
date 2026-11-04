/* ============================================================
   RunRoute — Street View run preview (sim.js, sv2)
   Moves DOWN the street: pano -> linked pano (~10 m) with Google's own
   animated transition, direction of travel preserved, turn arrows while
   approaching and taking turns. Desktop (>= 861 px): Street View in a side
   dock, a map marker tracing the traversal. Mobile: full screen.

   Billing / terms invariants (spec §19):
   - exactly ONE google.maps.StreetViewPanorama per page lifetime (S.pano);
   - movement via setPano only, and only from the Lock (§8);
   - lookups only via StreetViewService.getPanorama (free), sources:[GOOGLE];
   - no tile fetching: tile URLs are only READ from Resource Timing entries;
   - pano ids live in memory only; this file makes no storage calls.
   Depends on: app.js globals (RR, $, toast, fmtShortDist, isMobile, CAT_FILL,
   fitRouteBounds, refreshMarkers), theme.js (RRTheme), streetwalk.js (rrStreetWalk).
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- Constants (spec §21) ---------------- */

  var SIM = {
    minGapMs: 500, linkMinMs: 380, cutMinMs: 350, quietMinMs: 40, quietMaxMs: 120, quietMul: 1.5,
    linkFallbackMs: 900, cutFallbackMs: 1100, primeVisibleFallbackMs: 1500,
    autoplayMs: 700, revealCapMs: 1500, revealFallbackMs: 700, cutRevealCapMs: 450, dimInMs: 140, dimOutMs: 200,
    speeds: [{ key: "0.5", label: "0.5×", aria: "Playback speed: 0.5x", mps: 9, mul: 1.3 },
             { key: "1",   label: "1×",   aria: "Playback speed: 1x",   mps: 0, mul: 1.0 }],
    /* creepZoom 1.10 on a linear ramp (spec D29: 1.06, ease-out). Feel r1: at 0.5x the ease-out creep ended
       every dwell in a dead stop, so the hop rhythm read as move-then-pause; a steady creep keeps it moving. */
    creepZoom: 1.10, creepMinMs: 150,
    /* steerMidMs 200 (spec: 250). Measured settle ~563 ms + 250 ms = ~815 ms broke M2's p90 <= 800 ms on plain
       hops (smoke r3 mobile 814); 200 ms keeps a 12-35 deg correction under it and shortens the stall. */
    deadBandDeg: 4, steerSmallMs: 150, steerMidMs: 200, steerTurnBaseMs: 250, steerTurnPerDeg: 5.5, steerMaxMs: 900,
    turnHoldBeforeMs: 200, turnHoldAfterMs: 120, uturnMs: 900, uturnHoldMs: 300, lookBackMs: 400,
    chordAheadM: 20, motionClampDeg: 45, divergeDeg: 35, turnWindowM: 25, turnPanoDeg: 35,
    preTurnFrac: 0.25, preTurnMinDeg: 45, exitOkDeg: 35, pitch: 0, zoomMin: 1, zoomMax: 2.2,
    /* Not in spec §21 (fix r1): the exit of a turn faces its exit move unless the route's exit bearing is within
       exitLegDeg of it; a leg shorter than legMinM is an alias (no visible motion); an alias is closer than aliasM.
       Fix r2: the exit move is trusted only within exitAimMaxDeg of the exit street (r2-10); a leg of legLongM or
       more is entered at most legSideDeg sideways, and between repair legs the camera turns only for a long leg
       more than legSteerDeg off the view (r2-05); a turn's own aim never swings more than turnAgainstDeg against
       the turn. */
    exitLegDeg: 15, exitAimMaxDeg: 60, legMinM: 3, legLongM: 8, legSideDeg: 60, legSteerDeg: 75, turnAgainstDeg: 20,
    aliasM: 2.5, relookMaxMs: 4000,
    /* Fix r3 (not in spec §21): a link-heading bend is a turn pano only if the hop positions bend at least
       turnPanoPosDeg there too (moves of turnPosMinM or more; r3-01: R-A k6/k8 linkHeading "bends" the hops never
       make). DONE accepts the turn pano's own aim only within doneAimDeg of the exit street (r3-01); a "Now" card
       stays up at least takingMinMs (r3-05); a 0.5x dwell is at most dwellMaxMs (r3-17). */
    turnPanoPosDeg: 18, turnPosMinM: 6, doneAimDeg: 25, takingMinMs: 850, dwellMaxMs: 900,
    /* Final fixer (not in spec §21). Ruling R4: no turn card ("Now", the approach card, "On {street}") is up less
       than 800 ms; the floors are 850 because the screen shows a card ~15 ms (one frame) less than the log says
       (k7: 803 ms logged, 788 on screen). T4: "On {street}" clears by the exit go + doneClearMs (spec: <= 3 s).
       Ruling R3: the second of two turns at most foldM apart may skip its own approach card. A turn whose exit is a
       repair path turns in stages along it, at most stageOverDeg past the exit street (stagedAims). */
    cardMinMs: 850, doneClearMs: 2900, foldM: 50, stageOverDeg: 25,
    noticeSec: 8, noticeMinM: 80, noticeMaxM: 160, approachSec: 3.5, approachMinM: 40, approachMaxM: 90,
    nowM: 15, doneDeg: 10, doneShowMs: 1200, doneFallbackM: 25, thenWithinM: 40, chevApproachMin: 0.7,
    /* beacon false: T6 failed (test r1). Google places pano Markers itself and snaps them 90-3400 px in one frame
       during link transitions (and drops them mid-transition); spec §12.2/§22.3 T6 say switch it off. The turn
       card and the ground arrow carry the cue (T3: 100% of samples within 5 deg). */
    beacon: false, beaconMaxM: 90, beaconMinM: 4, saySpacingMs: 1500, sayQueueMax: 4,
    stopLeadM: 8, stopHoldMs: 1600, stopHoldSlowMs: 2400, stopLookMaxM: 60, stopLookMinDeg: 30,
    gapChipM: 60, gapChipDistM: 40, gapChipMs: 2200, gapHoldMs: 600, startChipM: 30, startChipMs: 2500,
    budgetPerKm: 160, budgetBase: 300, cacheMax: 25000, chainChipMs: 600, chainStallMs: 10000,
    repairMaxLegs: 3, repairMaxM: 60, repairDetour: 1.6, repairSlackM: 10, repairMaxLookups: 12,
    repairGhostLatM: 32, repairJumpMaxM: 40, repairWaitMs: 1500, repairConcurrency: 2,
    slowZ0Ms: 400, fastZ0Ms: 250, fastRun: 8, gateQuietMs: 120, gateCapMs: 3000, gateChipMs: 700,
    /* netMissMaxMs (fix r1): on a slow link the health window stretches to 1.5x the slowest recent zoom-0
       latency, capped here; a fixed 2 s window called Fast-3G (z0 1.3-3.8 s) broken while tiles still arrived. */
    netMissHops: 3, netMissWindowMs: 2000, netMissMaxMs: 6000, slowFallbackDwellMs: 300,
    /* followZoom (fix r2-20; spec §15.4 says never change the zoom): at the whole-route fit (zoom 15 on R-A) the
       marker crept ~2 px per second and looked parked, against the owner's "a marker shows the traversal". Follow
       zooms in to this once when it engages (first imagery, or the pill turned back on); after that it only pans,
       so a zoom the user picks is kept. The view from before the preview is restored on close. */
    markerDelayMs: 40, markerTweenMs: 470, markerCutMs: 600, followInset: 0.2, coneThrottleMs: 50, followZoom: 17,
    seekDragCommitMs: 800, rangeKeyDebounceMs: 250, poiLeadM: 60, poiSkipM: 200, poiMinGapM: 15,
    logMax: 2000, mkMax: 4000
  };

  /* §9.2 panorama options. visible:false — the cover is up until the first imagery lands. */
  var PANO_OPTIONS = {
    disableDefaultUI: true, clickToGo: false, motionTracking: false, motionTrackingControl: false,
    linksControl: false, addressControl: false, enableCloseButton: false, showRoadLabels: true,
    zoomControl: false, fullscreenControl: false, visible: false
  };

  /* Static SVG strings only — never user content. */
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 5h3.5v14H6.5zM14 5h3.5v14H14z"/></svg>';
  var ICON_REPLAY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.75 12a7.25 7.25 0 1 1 2.12 5.13"/><path d="M4.75 16.75V12h4.75"/></svg>';

  var BRAND = "#4353f0";
  var COLORS = { light: { fill: "#4353f0", trail: "#1f2bb8" }, dark: { fill: "#8e99ff", trail: "#c3c9ff" } };

  var KIND_PHRASE = {
    "left": "Turn left", "right": "Turn right", "slight-left": "Bear left", "slight-right": "Bear right",
    "sharp-left": "Sharp left", "sharp-right": "Sharp right", "uturn": "Turn around", "straight": "Continue"
  };

  var PH = { HIDDEN: 0, NOTICE: 1, APPROACH: 2, TAKING: 3, DONE: 4 };

  /* ---------------- State (spec §7.1) ---------------- */

  var els = null;
  var Svc = null;

  var S = {
    // page lifetime
    pano: null, panoCreates: 0, svcReady: false, listenersOn: false, keysOn: false,
    mapObjs: { dot: null, cone: null, trail: null, hit: null, ghost: null, beacon: null, followEl: null },
    // session (reset on open)
    open: false, epoch: 0, phase: "CLOSED", playing: false, speedIdx: 1, reduced: false, mobile: false,
    route: null, routeKey: "", walker: null, R: null, info: null,
    hops: [], byPano: {}, walkDone: null, frontierS0: 0,
    turns: [], stops: [], plan: {},
    cur: -1, curPanoId: null, shown: {}, pending: null, userLook: false,
    cam: { raf: 0, anim: null }, zoom: 1,
    hud: { k: -1, phase: "HIDDEN", said: {} }, chips: {}, endShown: false,
    landT: [], landS0: [],
    saved: null, follow: true, mkS0: 0,
    m: null
  };

  function newMetrics() {
    return { moves: 0, linked: 0, repaired: 0, ghostLegs: 0, cuts: 0, cutsIntoBigJumps: 0, mismatch: 0, badStatus: 0,
      setPanoCalls: 0, povSetBusy: 0, zoomSetBusy: 0, fallbackSettles: 0 };
  }
  S.m = newMetrics();

  /* Session fields that are not part of the §7.1 listing (implementation detail). */
  var X = {};
  function resetSession() {
    S.phase = "CLOSED"; S.playing = false; S.userLook = false;
    S.route = null; S.routeKey = ""; S.walker = null; S.R = null; S.info = null;
    S.hops = []; S.byPano = {}; S.walkDone = null; S.frontierS0 = 0;
    S.turns = []; S.stops = []; S.plan = {};
    S.cur = -1; S.curPanoId = null; S.shown = {}; S.pending = null;
    S.cam = { raf: 0, anim: null }; S.zoom = 1;
    S.hud = { k: -1, phase: "HIDDEN", said: {} }; S.chips = {}; S.endShown = false;
    S.landT = []; S.landS0 = []; S.saved = null; S.follow = true; S.mkS0 = 0;
    S.m = newMetrics();
    X = {
      byPanoAll: {}, pois: [], budget: 0, budgetHit: false, flow: 0, runTok: 0, stepT: 0,
      moveT0: 0, moveDist: 0, moveFrom: -1, mvTry: null, badRun: 0, stopHoldFor: -1, gapHoldFor: -1,
      seekCtx: null, waitT: 0, waitSince: 0, chainChipT: 0, stallT: 0, autoT: 0, primeRetried: false,
      repairQ: [], repairRunning: 0, dragging: false, dragResume: false, lastDragCommit: -1e9, dragT: 0, keyT: 0,
      chev: { visible: false, mode: "", worldBrg: 0, rel: 0, k: -1 }, beaconK: -1, beaconOn: false,
      sayT: 0, sayQ: [], lastSayT: -1e9, chipText: "", chipT: 0, stopCardT: 0, turnFadeT: 0,
      card: null, zoomDirty: false, creep: false, creepRaf: 0, tween: null, retried: 0, offlineRetry: false,
      onlineRetried: false, offlineHeld: false, offlineWait: false, resumeOnline: false, midMove: false, scrubPtr: false,
      fzPending: false, keyV: null, chipGate: 0, doneDueT: 0, hudWaitT: 0, doneShowT: 0, avoid: {},
      lookPtr: null, layoutMobile: null, routeLL: null, lastConeT: 0
    };
  }
  resetSession();

  /* ---------------- Small helpers ---------------- */

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function norm360(h) { h = h % 360; return h < 0 ? h + 360 : h; }
  function angDiff(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }   // signed a-b in [-180,180)
  function num(a, b) { return a - b; }
  function sgn(v) { return v < 0 ? -1 : 1; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function okStatus() { return (google.maps.StreetViewStatus && google.maps.StreetViewStatus.OK) || "OK"; }
  function zeroStatus() { return (google.maps.StreetViewStatus && google.maps.StreetViewStatus.ZERO_RESULTS) || "ZERO_RESULTS"; }
  function srcGoogle() { return (google.maps.StreetViewSource && google.maps.StreetViewSource.GOOGLE) || "google"; }
  function prefNearest() { return (google.maps.StreetViewPreference && google.maps.StreetViewPreference.NEAREST) || "nearest"; }

  function toastMsg(msg) { if (typeof window.toast === "function") window.toast(msg); }
  function shortDist(m) {
    if (typeof window.fmtShortDist === "function") return window.fmtShortDist(m);
    return m < 950 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1) + " km";
  }
  function km1(m) { return (Math.max(0, m) / 1000).toFixed(1); }
  function sayDist(m) { return m < 950 ? Math.round(m / 10) * 10 + " metres" : (m / 1000).toFixed(1) + " kilometres"; }
  function mobileNow() {
    if (typeof window.isMobile === "function") return !!window.isMobile();
    return !!(window.matchMedia && window.matchMedia("(max-width: 860px)").matches);
  }
  function llOf(p) {
    if (!p) return null;
    if (typeof p.lat === "function") return { lat: p.lat(), lng: p.lng() };
    if (typeof p.lat === "number" && typeof p.lng === "number") return { lat: p.lat, lng: p.lng };
    return null;
  }
  function lcFirst(s) { s = String(s || ""); return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  /* Planar geometry in the walker's local plane (R.fwd), metres / degrees. */
  function xyOf(p) { return S.R.fwd(p.lat, p.lng); }
  function distLL(a, b) {
    var A = xyOf(a), B = xyOf(b), dx = B.x - A.x, dy = B.y - A.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function brgLL(a, b) {
    var A = xyOf(a), B = xyOf(b);
    return norm360(Math.atan2(B.x - A.x, B.y - A.y) * 180 / Math.PI);
  }
  function lineLL(s0) { var p = S.R.line0.pointAt(s0); return S.R.inv(p.x, p.y); }
  /* Positions a legacy Marker (map dot/cone/ghost, in-pano beacon). Through setOptions so this file has
     no setPosition calls at all: the panorama only ever moves by setPano (B2). */
  function placeMarker(m, ll) { m.setOptions({ position: ll }); }

  /* Verbatim copy of run.js stripStepHtml (run.js lines 105-119). */
  function stripStepHtml(html) {
    var s = String(html == null ? "" : html);
    // ". " before block openings FIRST, so "Elm St<div>Destination…" keeps its break
    s = s.replace(/<div/gi, ". <div").replace(/<br/gi, ". <br");
    try {
      var doc = new DOMParser().parseFromString(s, "text/html");
      s = (doc && doc.body) ? (doc.body.textContent || "") : s;
    } catch (e) {
      s = s.replace(/<[^>]*>/g, " ");
    }
    s = s.replace(/\s+/g, " ");
    while (/\.\s*\./.test(s)) s = s.replace(/\.\s*\./g, ".");
    s = s.replace(/^[\s.]+/, "").replace(/\s+$/, "");
    return s;
  }

  /* Surfaces an exception as a page error without breaking the caller's state machine. */
  function rethrow(e) { setTimeout(function () { throw e; }, 0); }

  /* ---------------- Debug rings (§7.4) — page lifetime ---------------- */

  var LOG = [], MK = [];
  function log(ev, o) {
    var e = { t: now(), ev: ev }, k;
    if (o) for (k in o) if (has(o, k)) e[k] = o[k];
    LOG.push(e);
    if (LOG.length > SIM.logMax) LOG.shift();
  }
  function mkPush(s0, ll) {
    MK.push({ t: now(), s0: r1(s0), lat: ll.lat, lng: ll.lng });
    if (MK.length > SIM.mkMax) MK.shift();
  }

  /* ---------------- Session timers (§9.1): epoch-guarded, cleared on close ---------------- */

  var Timers = (function () {
    var to = {}, rf = {}, nTo = 0, nRf = 0;
    function set(fn, ms) {
      var e = S.epoch, id = 0;
      id = setTimeout(function () {
        if (to[id]) { delete to[id]; nTo--; }
        if (e !== S.epoch || !S.open) return;
        fn();
      }, ms > 0 ? ms : 0);
      to[id] = 1; nTo++;
      return id;
    }
    function clear(id) { if (id && to[id]) { clearTimeout(id); delete to[id]; nTo--; } }
    function raf(fn) {
      var e = S.epoch, id = 0;
      id = requestAnimationFrame(function (ts) {
        if (rf[id]) { delete rf[id]; nRf--; }
        if (e !== S.epoch || !S.open) return;
        fn(ts);
      });
      rf[id] = 1; nRf++;
      return id;
    }
    function cancelRaf(id) { if (id && rf[id]) { cancelAnimationFrame(id); delete rf[id]; nRf--; } }
    function raf2(fn) { return raf(function () { raf(fn); }); }
    function clearAll() {
      var k;
      for (k in to) if (has(to, k)) clearTimeout(+k);
      for (k in rf) if (has(rf, k)) cancelAnimationFrame(+k);
      to = {}; rf = {}; nTo = 0; nRf = 0;
    }
    function count() { return nTo + nRf; }
    return { set: set, clear: clear, raf: raf, cancelRaf: cancelRaf, raf2: raf2, clearAll: clearAll, count: count };
  })();

  /* Epoch guard for async continuations; fl() also dies when the play flow is interrupted. */
  function ep(fn) {
    var e = S.epoch;
    return function () { if (e !== S.epoch || !S.open) return; return fn.apply(null, arguments); };
  }
  function fl(fn) {
    var e = S.epoch, f = X.flow;
    return function () { if (e !== S.epoch || !S.open || f !== X.flow) return; return fn.apply(null, arguments); };
  }

  /* ---------------- Metadata service proxy (§6) ---------------- */

  function toMin(d) {
    var loc = d && d.location;
    if (!loc || !loc.pano) return null;
    var ll = llOf(loc.latLng);
    if (!ll) return null;
    var links = [], raw = d.links || [], j;
    for (j = 0; j < raw.length; j++) {
      var l = raw[j];
      if (l && l.pano) links.push({ pano: String(l.pano), heading: norm360(+l.heading || 0) });
    }
    return { location: { pano: String(loc.pano), latLng: { lat: ll.lat, lng: ll.lng } }, links: links,
      imageDate: String(d.imageDate || ""), copyright: String(d.copyright || "") };
  }
  function reqKey(req) {
    if (req.pano) return "p:" + req.pano;
    var ll = llOf(req.location);
    if (!ll) return null;
    return "l:" + ll.lat.toFixed(6) + "," + ll.lng.toFixed(6) + ":" + req.radius + ":" + req.preference + ":" + String(req.sources);
  }
  function makeSvc() {
    var real = new google.maps.StreetViewService();
    var OK = okStatus(), ZERO = zeroStatus();
    var svc = { real: real, cache: {}, n: 0, netCalls: 0, sessionCalls: 0, hits: 0, reqLog: [] };
    function put(key, v) {
      if (!key) return;
      if (!has(svc.cache, key)) svc.n++;
      svc.cache[key] = v;
    }
    function shape(req) {
      svc.reqLog.push({ kind: req.pano ? "pano" : "loc", hasSources: has(req, "sources"),
        srcs: req.sources ? String(req.sources) : "", hasSource: has(req, "source") });
      if (svc.reqLog.length > 300) svc.reqLog.shift();
    }
    svc.getPanorama = function (req, cb) {
      shape(req);
      var key = reqKey(req);
      if (key && has(svc.cache, key)) {
        var c = svc.cache[key];
        svc.hits++;
        setTimeout(function () { cb(c.data, c.status); }, 0);
        return undefined;
      }
      if (svc.n > SIM.cacheMax) { svc.cache = {}; svc.n = 0; }
      svc.netCalls++;
      svc.sessionCalls++;
      var ret;
      function wrapped(data, status) {
        if (status === OK) {
          var m = toMin(data);
          if (m) { put(key, { status: OK, data: m }); put("p:" + m.location.pano, { status: OK, data: m }); }
        } else if (status === ZERO) {
          put(key, { status: ZERO, data: null });
        }
        cb(data, status);
      }
      try { ret = real.getPanorama(req, wrapped); }
      catch (e) { setTimeout(function () { cb(null, "UNKNOWN_ERROR"); }, 0); return undefined; }
      if (ret && typeof ret.catch === "function") ret.catch(function () { /* the callback carries the status */ });
      if (S.open && X.budget && svc.sessionCalls > X.budget) budgetHit();
      return ret;
    };
    svc.peek = function (id) { var c = svc.cache["p:" + id]; return c && c.data ? c.data : undefined; };
    svc.byId = function (id, cb) {
      svc.getPanorama({ pano: id }, function (d, st) { cb(st === OK && d ? toMin(d) : null); });
    };
    return svc;
  }
  function metaLL(m) { return m.location.latLng; }

  /* ---------------- The Lock: the only caller of setPano (§8) ---------------- */

  var Lock = { busy: false, seq: 0, id: null, mode: null, t0: 0, lastGoT: -1e9, povT: [], seenLate: false,
               statusSeen: false, quietT: 0, fbT: 0, polls: [], cb: null, waiter: null };

  function povHeading() {
    try { var p = S.pano.getPov(); return p ? norm360(p.heading) : 0; } catch (e) { return 0; }
  }
  function safePano() { try { return S.pano.getPano(); } catch (e) { return null; } }
  function safeStatus() { try { return S.pano.getStatus(); } catch (e) { return null; } }

  function lockGo(id, mode, opts, cb) {           // the Player guarantees !Lock.busy
    if (Lock.busy) {
      /* Safety net only (D4: the Lock holds no queue). The re-issue dies with its epoch or play flow, and
         lockSettle drops it when the settling move's own continuation takes the Lock again (fix r1-08). */
      log("err", { what: "lock-busy", id: id });
      lockWhenFree(ep(fl(function () { lockGo(id, mode, opts, cb); })));
      return;
    }
    Lock.busy = true; Lock.seq++; Lock.id = id; Lock.mode = mode; Lock.cb = cb; Lock.t0 = 0;
    lockIssueAfterFloor(opts || {});
  }
  /* Hard floor: 500 ms between setPano calls. r2-08: setTimeout truncates a fractional wait and can fire a
     fraction of a millisecond early against performance.now() (a 499.4 ms gap was measured), so the wait is
     rounded up and re-checked when the timer fires. */
  function lockIssueAfterFloor(o) {
    var wait = Lock.lastGoT + SIM.minGapMs - now();
    setTimeout(function () {
      if (now() - Lock.lastGoT < SIM.minGapMs) return lockIssueAfterFloor(o);
      lockIssue(o);
    }, wait > 0 ? Math.ceil(wait) : 0);
  }
  function lockIssue(o) {
    Lock.t0 = Lock.lastGoT = now(); Lock.povT = []; Lock.seenLate = false; Lock.statusSeen = false;
    var pv = povHeading();
    log("go", { seq: Lock.seq, id: Lock.id, mode: Lock.mode, idx: o.idx, ghost: !!o.ghost, pov: Math.round(pv * 10) / 10,
      zoom: o.zoom == null ? null : o.zoom });
    Net.issued(Lock.id);
    if (typeof o.onIssue === "function") { try { o.onIssue(Lock.t0, pv); } catch (e) { rethrow(e); } }
    try {
      if (o.zoom != null) S.pano.setZoom(o.zoom);   // same tick as setPano: absorbed (probe §13)
      S.pano.setPano(Lock.id);
      S.m.setPanoCalls++;
    } catch (e2) { log("err", { what: "setPano" }); }
    Lock.fbT = setTimeout(function () { lockSettle("fallback"); },
                          Lock.mode === "cut" ? SIM.cutFallbackMs : SIM.linkFallbackMs);
    if (Lock.mode === "cut") Lock.polls = [setTimeout(lockCheck, SIM.cutMinMs), setTimeout(lockCheck, 600)];
  }
  function minMs() { return Lock.mode === "cut" ? SIM.cutMinMs : SIM.linkMinMs; }
  function quietMs() {                           // adaptive debounce: 1.5x median frame interval, 40..120
    var p = Lock.povT, n = p.length, iv = [];
    for (var i = Math.max(1, n - 8); i < n; i++) iv.push(p[i] - p[i - 1]);
    if (iv.length < 2) return SIM.quietMinMs;
    iv.sort(num);
    return clamp(SIM.quietMul * iv[iv.length >> 1], SIM.quietMinMs, SIM.quietMaxMs);
  }
  function lockCheck() {
    if (!Lock.busy || !Lock.t0) return;
    var t = now(), last = Lock.povT.length ? Lock.povT[Lock.povT.length - 1] : -1e9;
    if (t - last < quietMs() - 1) return;
    if (Lock.mode === "link" && Lock.seenLate) return lockSettle("pov");
    if (Lock.mode === "cut" && Lock.statusSeen && t - Lock.t0 >= SIM.cutMinMs) return lockSettle("pov");
  }
  function lockSettle(reason) {
    if (!Lock.busy || !Lock.t0) return;
    clearTimeout(Lock.quietT); clearTimeout(Lock.fbT);
    for (var i = 0; i < Lock.polls.length; i++) clearTimeout(Lock.polls[i]);
    Lock.polls = [];
    var r = { seq: Lock.seq, expected: Lock.id, landed: safePano(), status: safeStatus(), reason: reason,
      dt: Math.round(now() - Lock.t0) };
    if (reason === "fallback") S.m.fallbackSettles++;
    Lock.busy = false; Lock.t0 = 0;
    log("settle", r);
    var cb = Lock.cb;
    Lock.cb = null;
    if (cb) { try { cb(r); } catch (e) { log("err", { what: "settle-cb" }); rethrow(e); } }
    var w = Lock.waiter;                           // one-shot: runs on THIS free, or never (fix r1-08)
    Lock.waiter = null;
    if (w) { if (!Lock.busy) w(); else log("err", { what: "waiter-dropped" }); }
  }
  function lockWhenFree(fn) { if (!Lock.busy) fn(); else Lock.waiter = fn; }   // one slot, latest wins

  /* ---------------- Page-lifetime panorama listeners (§8, §9.7) ---------------- */

  var povRaf = 0;
  function onPovChanged() {
    if (Lock.busy && Lock.t0) {
      var t = now();
      Lock.povT.push(t);
      if (t - Lock.t0 >= minMs()) Lock.seenLate = true;
      clearTimeout(Lock.quietT);
      Lock.quietT = setTimeout(lockCheck, quietMs());
    }
    if (!povRaf) povRaf = requestAnimationFrame(function () { povRaf = 0; onPovFrame(); });
  }
  function onStatusChanged() { if (Lock.busy && Lock.t0) Lock.statusSeen = true; }
  function onPanoChanged() {
    var id = safePano();
    log("pano", { id: id, expected: Lock.busy ? Lock.id : S.curPanoId, busy: Lock.busy });
    if (!S.open || Lock.busy || !id || S.curPanoId == null) return;
    if (id === S.curPanoId) return;
    log("offchain", { id: id });
    var a = adoptIdx(id, S.cur);
    if (a != null) { S.curPanoId = id; land(a, "adopt"); return; }
    pause();
    chip("Tap play to rejoin the route");
    S.pending = { type: "rejoin" };
  }
  /* r3-14: each listener is added once and marked only once it is on, so a throw part-way never double-adds one
     on the retry, and S.listenersOn means all three are on. */
  var LSN = { pov: false, status: false, pano: false };
  function installPanoListeners() {
    if (S.listenersOn) return;
    if (!LSN.pov) { S.pano.addListener("pov_changed", onPovChanged); LSN.pov = true; }
    if (!LSN.status) { S.pano.addListener("status_changed", onStatusChanged); LSN.status = true; }
    if (!LSN.pano) { S.pano.addListener("pano_changed", onPanoChanged); LSN.pano = true; }
    S.listenersOn = true;
  }
  /* rAF-throttled: ground arrow, map cone, DONE detection (the camera may be the user's). */
  function onPovFrame() {
    if (!S.open) return;
    var h = povHeading();
    chevApply(h);
    MapView.cone(h, false);
    hudPovCheck(h);
  }

  /* ---------------- Network adaptation (§14) ---------------- */

  var Net = {
    supported: false, ok: true, slow: false, installed: false, tiles: {}, issuedAt: {}, firstIssued: {},
    tilesSeen: 0, lastTileEnd: 0, z0Lat: [], fastRunN: 0, missStreak: 0,
    connSlow: function () {
      var c = navigator.connection;
      if (!c) return false;
      return c.saveData === true || /^(slow-2g|2g|3g)$/.test(String(c.effectiveType || ""));
    },
    install: function () {
      if (Net.installed) return;
      Net.installed = true;
      if (typeof PerformanceObserver !== "function") { Net.supported = false; return; }
      var po = null;
      try {
        po = new PerformanceObserver(function (list) {
          var es = list.getEntries();
          for (var i = 0; i < es.length; i++) Net.onEntry(es[i]);
        });
      } catch (e) { Net.supported = false; return; }
      try { po.observe({ type: "resource" }); Net.supported = true; }
      catch (e2) {
        try { po.observe({ entryTypes: ["resource"] }); Net.supported = true; } catch (e3) { Net.supported = false; }
      }
    },
    onEntry: function (e) {                      // URL strings and timings only; nothing is fetched
      var name = String(e.name || "");
      if (!/streetviewpixels/.test(name)) return;
      var m = /[?&]panoid=([^&]+)/.exec(name);
      if (!m) return;
      var id;
      try { id = decodeURIComponent(m[1]); } catch (x) { id = m[1]; }
      var rec = Net.tiles[id] || (Net.tiles[id] = { n: 0, z0: null });
      rec.n++;
      Net.tilesSeen++;
      if (e.responseEnd > Net.lastTileEnd) Net.lastTileEnd = e.responseEnd;
      if (/[?&]zoom=0(&|$)/.test(name) && rec.z0 == null) {
        rec.z0 = e.responseEnd;
        if (Net.issuedAt[id] != null) Net.onZ0(rec.z0 - Net.issuedAt[id]);
      }
    },
    onZ0: function (lat) {
      Net.z0Lat.push(Math.round(lat));
      if (Net.z0Lat.length > 4) Net.z0Lat.shift();
      Net.fastRunN = lat <= SIM.fastZ0Ms ? Net.fastRunN + 1 : 0;
      var cs = Net.connSlow(), slowN = 0;
      for (var i = 0; i < Net.z0Lat.length; i++) if (Net.z0Lat[i] > SIM.slowZ0Ms) slowN++;
      if (!Net.slow) { if (slowN >= 2 || cs) Net.slow = true; }
      else if (Net.fastRunN >= SIM.fastRun && !cs) Net.slow = false;   // hysteresis: 8 fast z0 in a row
    },
    missWindow: function () {                    // health window; slow links wait for their measured z0 latency
      if (!Net.slow || !Net.z0Lat.length) return SIM.netMissWindowMs;
      var mx = 0;
      for (var i = 0; i < Net.z0Lat.length; i++) if (Net.z0Lat[i] > mx) mx = Net.z0Lat[i];
      return clamp(Math.round(1.5 * mx), SIM.netMissWindowMs, SIM.netMissMaxMs);
    },
    issued: function (id) {                      // called by lockIssue
      Net.issuedAt[id] = now();
      if (Net.firstIssued[id]) return;
      Net.firstIssued[id] = 1;
      if (!Net.supported || !S.open) return;
      var e = S.epoch;
      setTimeout(function () {                   // health: first visits only (cached tiles have no entries)
        if (e !== S.epoch || !S.open) return;
        var rec = Net.tiles[id];
        if (!rec || rec.n === 0) {
          Net.missStreak++;
          if (Net.missStreak >= SIM.netMissHops) Net.ok = false;
        } else {
          Net.missStreak = 0;
          Net.ok = true;
        }
      }, Net.missWindow());
    },
    quiet: function (id) {
      var rec = Net.tiles[id];
      return !!(rec && rec.n > 0 && now() - Net.lastTileEnd >= SIM.gateQuietMs);
    },
    gateTok: 0,
    /* slow mode only (D15). r3-11: the poll belongs to the play flow that started it (callers pass fl() callbacks):
       once Pause, a hidden tab, looking around or a new intent ends that flow, the poll stops too, so it never chips
       "Loading imagery…" over a paused preview. It clears only the chip it put up itself (X.chipGate). */
    gate: function (id, cb) {
      if (!Net.slow) return cb();
      if (!Net.ok || !Net.supported) { Timers.set(cb, SIM.slowFallbackDwellMs); return; }
      var t0 = now(), chipOn = false, f = X.flow, tok = ++Net.gateTok;
      function unchip() { if (chipOn && X.chipGate === tok) chipClear("Loading imagery…"); }
      (function poll() {
        if (f !== X.flow) return unchip();
        var t = now();
        if (Net.quiet(id) || t - t0 >= SIM.gateCapMs) {
          log("gate", { ms: Math.round(t - t0) });
          unchip();
          return cb();
        }
        if (!chipOn && t - t0 > SIM.gateChipMs) { chipOn = true; chip("Loading imagery…"); X.chipGate = tok; }
        Timers.set(poll, 40);
      })();
    },
    firstTile: function (id, cap, cb) {
      if (!Net.ok || !Net.supported) { Timers.set(cb, Math.min(cap, 700)); return; }
      var t0 = now();
      (function poll() {
        if (Net.quiet(id) || now() - t0 >= cap) return cb();
        Timers.set(poll, 40);
      })();
    }
  };

  /* ---------------- DOM binding (lazy: scripts load before <body>) ---------------- */

  var IDS = {
    overlay: "svOverlay", pano: "svPano", stage: "svStage", dim: "svDim", dimText: "svDimText",
    chev: "svChevron", chevBodyO: "svChevBodyO", chevHeadO: "svChevHeadO", chevBody: "svChevBody", chevHead: "svChevHead",
    hudcol: "svHudCol", turn: "svTurn", turnArrow: "svTurnArrow", turnDist: "svTurnDist", turnInstr: "svTurnInstr",
    turnThen: "svTurnThen", gap: "svGap", stopCard: "svStopCard", stopDot: "svStopDot", stopText: "svStopText",
    card: "svCard", cardText: "svCardText", cardSub: "svCardSub", cardAlt: "svCardAlt", cardMain: "svCardMain",
    prev: "svPrev", play: "svPlay", next: "svNext", ticks: "svTicks", scrub: "svScrub", buf: "svBuf",
    speed: "svSpeed", live: "svLive", pos: "svPos", close: "svClose"
  };

  function bindOnce() {
    if (els) return true;
    var e = {}, k;
    for (k in IDS) {
      if (!has(IDS, k)) continue;
      e[k] = document.getElementById(IDS[k]);
      if (!e[k]) return false;
    }
    e.topbar = e.overlay.querySelector(".sv-topbar");
    e.controls = e.overlay.querySelector(".sv-controls");
    if (!e.topbar || !e.controls) return false;
    els = e;

    els.play.addEventListener("click", function () { if (S.open) togglePlay(); });
    els.prev.addEventListener("click", function () { if (S.open) poiJump(-1); });
    els.next.addEventListener("click", function () { if (S.open) poiJump(1); });
    els.speed.addEventListener("click", function () { if (S.open) cycleSpeed(); });
    els.close.addEventListener("click", function () { close(); });
    els.cardAlt.addEventListener("click", function () { if (S.open && X.card && X.card.alt) X.card.alt(); });
    els.cardMain.addEventListener("click", function () { if (S.open && X.card && X.card.main) X.card.main(); });

    els.scrub.addEventListener("pointerdown", function () { X.scrubPtr = true; });
    els.scrub.addEventListener("input", onScrubInput);
    els.scrub.addEventListener("change", onScrubChange);
    /* The release can land outside the range: listen on the window (capture) while a drag is live (r1-09). */
    window.addEventListener("pointerup", function () { if (X.scrubPtr || X.dragging) endScrubDrag(); }, true);
    window.addEventListener("pointercancel", function () { if (X.scrubPtr || X.dragging) endScrubDrag(); }, true);

    els.stage.addEventListener("pointerdown", onStageDown, true);
    els.stage.addEventListener("pointermove", onStageMove, true);
    els.stage.addEventListener("pointerup", onStageUp, true);
    els.stage.addEventListener("pointercancel", onStageUp, true);
    els.stage.addEventListener("wheel", onStageWheel, { capture: true, passive: true });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (window.matchMedia) {
      var mq = window.matchMedia("(max-width: 860px)"), rq = window.matchMedia("(prefers-reduced-motion: reduce)");
      var onMq = function () { if (S.open) applyLayout(); };
      var onRq = function () { S.reduced = rq.matches; };
      if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
      if (rq.addEventListener) rq.addEventListener("change", onRq); else if (rq.addListener) rq.addListener(onRq);
    }
    return true;
  }

  /* ---------------- Opening and closing (§9.2, §9.10) ---------------- */

  function routeMeters(route) {
    var m = 0, legs = (route && route.legs) || [];
    for (var i = 0; i < legs.length; i++) if (legs[i] && legs[i].distance) m += legs[i].distance.value || 0;
    return m;
  }
  function routeKeyOf(route) {
    var op = route.overview_polyline;
    if (op && typeof op === "object") op = op.points || "";
    return String(op || "") + "|" + route.legs.length + "|" + routeMeters(route);
  }
  function triggerResize(obj) { try { if (obj) google.maps.event.trigger(obj, "resize"); } catch (e) { /* ignore */ } }
  function fitRoute() {
    try {
      if (typeof window.fitRouteBounds === "function") window.fitRouteBounds();
      else if (S.route && S.route.bounds) RR.map.fitBounds(S.route.bounds, 48);
    } catch (e) { /* ignore */ }
  }
  /* D17: the route cannot be dragged while the preview plays it; same-result re-render (no requests). */
  function freezeRoute(on) {
    try {
      RR.directionsRenderer.setOptions({ draggable: !on });
      var d = RR.directionsRenderer.getDirections();
      if (d) RR.directionsRenderer.setDirections(d);
    } catch (e) { /* ignore */ }
  }
  function applyRoles() {
    if (S.mobile) { els.overlay.setAttribute("role", "dialog"); els.overlay.setAttribute("aria-modal", "true"); }
    else { els.overlay.setAttribute("role", "region"); els.overlay.removeAttribute("aria-modal"); }
  }
  function phase(p) {
    if (S.phase === p) return;
    S.phase = p;
    log("phase", { phase: p });
  }

  function installOnce() {
    if (S.keysOn) return;
    S.keysOn = true;
    window.addEventListener("keydown", onKey, true);
    try { google.maps.event.addListener(RR.directionsRenderer, "directions_changed", onDirChanged); } catch (e) { /* ignore */ }
    if (window.RRTheme && RRTheme.onChange) RRTheme.onChange(function () { if (S.open) MapView.recolor(); });
  }

  /* D16: a same-key re-render (theme, freeze) is ignored; a new route closes the preview. */
  function onDirChanged() {
    if (!S.open) return;
    var d = null;
    try { d = RR.directionsRenderer.getDirections(); } catch (e) { d = null; }
    var r = d && d.routes && d.routes[0];
    if (!r || !r.legs) return;
    if (routeKeyOf(r) === S.routeKey) return;
    toastMsg("Route changed — preview closed.");
    close();
  }

  function open() {
    if (S.open) return;
    if (!(window.google && google.maps && window.RR && RR.map && RR.directionsRenderer) || !RR.hasRoute) {
      toastMsg("Build a route first.");
      return;
    }
    if (RR.run && RR.run.active) { toastMsg("End the run to preview."); return; }
    var d = null;
    try { d = RR.directionsRenderer.getDirections(); } catch (e) { d = null; }
    var route = d && d.routes && d.routes[0];
    if (!route || !route.legs || !route.legs.length) { toastMsg("Build a route first."); return; }
    if (!bindOnce() || typeof window.rrStreetWalk !== "function") { toastMsg("Reload the page to open the preview."); return; }
    /* r3-14: only a throwing constructor leaves S.pano unset. A panorama that was built is kept even if a later
       step throws, so the next open retries that step on the same panorama instead of building (and billing) a
       second one (B1). */
    if (!S.pano) {
      var pn = null;
      try { pn = new google.maps.StreetViewPanorama(els.pano, PANO_OPTIONS); }   // the ONE panorama (B1)
      catch (e2) { toastMsg("Street View couldn't start."); return; }
      S.pano = pn;
      S.panoCreates++;
    }
    if (!S.listenersOn) {
      try { installPanoListeners(); } catch (e6) { toastMsg("Street View couldn't start."); return; }
    }
    try { Net.install(); } catch (e7) { Net.supported = false; }          // no tile timings: plain dwell fallbacks
    if (!Svc) {
      try { Svc = makeSvc(); } catch (e3) { toastMsg("Street View couldn't start."); return; }
    }
    installOnce();

    S.epoch++;
    resetSession();
    S.open = true;
    S.mobile = mobileNow();
    X.layoutMobile = S.mobile;
    S.reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    S.speedIdx = S.reduced ? 0 : 1;
    S.route = route;
    S.routeKey = routeKeyOf(route);
    if (Net.connSlow()) Net.slow = true;
    phase("OPENING");

    document.body.classList.add("sv-open");
    els.overlay.hidden = false;
    applyRoles();
    setPlayIcon("play");
    applySpeedLabel();
    hudResetDom();
    var totalM = routeMeters(route);
    els.scrub.max = String(Math.max(10, Math.round(totalM)));
    els.scrub.value = "0";
    els.scrub.setAttribute("aria-valuetext", "0.0 of " + km1(totalM) + " kilometres");
    els.pos.textContent = "0.0 of " + km1(totalM) + " km";
    els.ticks.textContent = "";
    els.buf.style.width = "0";
    els.live.textContent = "";
    dim("cover", "Finding Street View…");
    if (!S.mobile) S.saved = { center: RR.map.getCenter(), zoom: RR.map.getZoom(), autoFit: !!RR.autoFit };
    freezeRoute(true);
    if (typeof window.refreshMarkers === "function") { try { window.refreshMarkers(); } catch (e4) { /* ignore */ } }
    try { els.play.focus(); } catch (e5) { /* ignore */ }
    S.zoom = zoomForStage();
    Timers.raf2(function () {
      triggerResize(S.pano);
      S.zoom = zoomForStage();
      if (!S.mobile) { triggerResize(RR.map); fitRoute(); MapView.on(); }
    });
    startWalk();
  }

  function close() {
    if (!S.open) return;
    /* r1-14: restore from how the session opened, not the layout at close (S.saved exists iff the planner map
       was ever docked beside the preview; a desktop -> mobile resize before close kept its dock view). */
    var restore = !!S.saved, saved = S.saved;
    S.open = false;
    S.epoch++;
    Timers.clearAll();
    if (S.walker) { try { S.walker.cancel(); } catch (e) { /* ignore */ } }
    camCancel();
    phase("CLOSED");
    try { S.pano.setVisible(false); } catch (e2) { /* ignore */ }   // L3: an in-flight move settles in the Lock
    hudHideAll();
    els.overlay.hidden = true;
    document.body.classList.remove("sv-open");
    els.overlay.removeAttribute("role");
    els.overlay.removeAttribute("aria-modal");
    freezeRoute(false);
    MapView.off();
    if (typeof window.refreshMarkers === "function") { try { window.refreshMarkers(); } catch (e3) { /* ignore */ } }
    if (restore) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (S.open) return;
          triggerResize(RR.map);
          try {
            if (!saved || saved.autoFit) fitRoute();
            else { RR.map.setCenter(saved.center); RR.map.setZoom(saved.zoom); }
          } catch (e4) { /* ignore */ }
        });
      });
    }
    requestAnimationFrame(function () {
      if (S.open) return;
      var pb = document.getElementById("previewBtn");
      if (pb) { try { pb.focus(); } catch (e5) { /* ignore */ } }
    });
  }

  /* §15.1: breakpoint crossings and resizes never restart playback. */
  function applyLayout() {
    if (!S.open) return;
    var was = X.layoutMobile;
    S.mobile = mobileNow();
    X.layoutMobile = S.mobile;
    applyRoles();
    if (was !== S.mobile) {
      if (S.mobile) MapView.off();
      else if (!S.saved) S.saved = { center: RR.map.getCenter(), zoom: RR.map.getZoom(), autoFit: !!RR.autoFit };
    }
    Timers.raf2(function () {
      triggerResize(S.pano);
      if (!S.mobile) triggerResize(RR.map);
      var z = zoomForStage();
      if (Math.abs(z - S.zoom) > 0.005) {
        S.zoom = z;
        if (!S.playing && !Lock.busy && !S.cam.anim && S.curPanoId) zoomSet(z);
        else X.zoomDirty = true;
      }
      if (was && !S.mobile) { fitRoute(); MapView.on(); }
    });
  }
  function onResize() {
    if (!S.open || X.resizeT) return;
    X.resizeT = Timers.set(function () { X.resizeT = 0; applyLayout(); }, 150);
  }

  /* ---------------- The walker (§5) and chain callbacks (§9.3) ---------------- */

  function startWalk() {
    X.budget = Math.ceil(SIM.budgetPerKm * routeMeters(S.route) / 1000) + SIM.budgetBase;
    Svc.sessionCalls = 0;
    X.budgetHit = false;
    newWalker();
  }
  function newWalker() {
    var w = null;
    try {
      w = window.rrStreetWalk(Svc, S.route.legs, {
        sources: [srcGoogle()],
        onStart: ep(onWalkStart), onHop: ep(onWalkHop), onDone: ep(onWalkDone), onError: ep(onWalkError)
      });
    } catch (e) { w = null; }
    S.walker = w;
    if (!w) { Timers.set(function () { onWalkError(new Error("walker")); }, 0); return; }
    if (!S.R && w.route) S.R = w.route;
  }
  function budgetHit() {
    if (X.budgetHit) return;
    X.budgetHit = true;
    if (S.walker) { try { S.walker.cancel(); } catch (e) { /* ignore */ } }
    if (!S.walkDone) S.walkDone = { reason: "budget" };
    log("err", { what: "budget", calls: Svc.sessionCalls, budget: X.budget });
    if (S.phase === "WAIT_CHAIN") Timers.set(resumeFromWait, 0);
  }

  function onWalkStart(info) {
    S.info = info;
    if (S.walker && S.walker.route && !S.R) S.R = S.walker.route;
    if (S.turns.length || S.stops.length) return;          // a retry walker: same route, keep turn state
    buildTurns(info);
    buildStops(info);
    var pois = [], i;
    for (i = 0; i < S.turns.length; i++) pois.push(S.turns[i].s0);
    for (i = 0; i < S.stops.length; i++) pois.push(S.stops[i].s0);
    pois.sort(num);
    X.pois = pois;
    els.scrub.max = String(Math.max(10, Math.round(info.totalOrigM)));
    drawTicks();
    drawBuf();
    if (!S.mobile) MapView.routeReady();
  }
  function streetOf(raw) {
    var main = stripStepHtml(String(raw == null ? "" : raw).split(/<div/i)[0]).replace(/[.\s]+$/, "");
    var m = /\b(?:onto|on)\s+([^,.]+?)(?:\s+toward\b.*)?$/i.exec(main);
    return m ? m[1].replace(/\s+$/, "") : "";
  }
  function buildTurns(info) {
    var R = S.R, out = [], ms = info.maneuvers || [];
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (!m.major) continue;
      out.push({ k: m.k, s: m.s, s0: m.s0, lat: m.lat, lng: m.lng, kind: m.kind, netDeg: m.netDeg,
        instr: stripStepHtml(m.instructions), street: streetOf(m.instructions),
        inBrg: R.line0.chordBearing(m.s0 - 30, m.s0 - 2), exitBrg: R.line0.chordBearing(m.s0 + 2, m.s0 + 30),
        turnPano: undefined, aimT: null, said: { approach: false, taking: false }, phase: "HIDDEN", exitIssued: false, doneT: 0,
        takingT: 0, doneDue: false, exitGoT: 0, stage: null, noticeT: 0 });
    }
    S.turns = out;
  }
  function buildStops(info) {
    var snap = [];
    if (RR.visitStops && RR.visitStops.length) snap = RR.visitStops.slice();
    else { try { RR.selected.forEach(function (s) { snap.push(s); }); } catch (e) { snap = []; } }
    var out = [], st = info.stops || [];
    for (var i = 0; i < st.length; i++) {
      var v = snap[st[i].k - 1] || null, pl = v ? llOf(v.location) : null;
      out.push({ k: st[i].k, s0: st[i].s0, lat: st[i].lat, lng: st[i].lng, name: v ? String(v.name || "") : "",
        cat: v ? (v.cat || null) : null, plat: pl ? pl.lat : null, plng: pl ? pl.lng : null, fired: false });
    }
    S.stops = out;
  }
  function catFill(cat) { return (window.CAT_FILL && cat && window.CAT_FILL[cat]) || BRAND; }
  function totalM() { return (S.info && S.info.totalOrigM) || routeMeters(S.route) || 1; }
  function drawTicks() {
    els.ticks.textContent = "";
    var total = totalM(), i, d;
    for (i = 0; i < S.turns.length; i++) {
      d = document.createElement("div");
      d.className = "sv-tick";
      d.style.left = (100 * clamp(S.turns[i].s0 / total, 0, 1)).toFixed(2) + "%";
      els.ticks.appendChild(d);
    }
    for (i = 0; i < S.stops.length; i++) {
      d = document.createElement("div");
      d.className = "sv-tick stop";
      d.style.left = (100 * clamp(S.stops[i].s0 / total, 0, 1)).toFixed(2) + "%";
      d.style.setProperty("--sv-dot", catFill(S.stops[i].cat));
      els.ticks.appendChild(d);
    }
  }
  function drawBuf() {
    els.buf.style.width = "calc((100% - 16px) * " + clamp(S.frontierS0 / totalM(), 0, 1).toFixed(4) + ")";
  }

  function copyHop(h) {
    var o = {}, k;
    for (k in h) if (has(h, k)) o[k] = h[k];
    if (h.next) o.next = { k: h.next.k, kind: h.next.kind, distM: h.next.distM, turnDeg: h.next.turnDeg };
    o.mode = null; o.ghosts = 0; o.issueT = null; o.settleT = null; o.povAtIssue = null;
    o.T = null; o.camKind = null; o.mv = null; o.mv2 = null; o.chord = null;
    return o;
  }
  function indexHop(hop) {
    if (S.byPano[hop.pano] == null) S.byPano[hop.pano] = hop.i;
    (X.byPanoAll[hop.pano] || (X.byPanoAll[hop.pano] = [])).push(hop.i);
  }
  /* §9.10 retry: a re-emitted hop with a different pano replaces hops[i..]. */
  function truncateHops(i) {
    S.hops.length = i;
    S.byPano = {};
    X.byPanoAll = {};
    for (var j = 0; j < S.hops.length; j++) indexHop(S.hops[j]);
    for (var k in S.plan) if (has(S.plan, k) && +k >= i) delete S.plan[k];
    S.frontierS0 = i ? S.hops[i - 1].s0 : 0;
    if (S.cur >= i) S.cur = i - 1;                         // always a surviving hop (or -1)
    for (var t = 0; t < S.turns.length; t++) {             // turn panos read mv(i-1), mv(i): re-decide
      var tp = S.turns[t].turnPano;
      if (tp === -1 || (tp != null && tp >= i - 1)) { S.turns[t].turnPano = undefined; S.turns[t].aimT = null; S.turns[t].stage = null; }
    }
  }
  /* §9.10 step 3, read BEFORE truncating at i: where the Player is, or is going, when that hop is replaced.
     The new chain is rejoined there by a seek, which waits for the new walker to get that far. */
  function reanchorAt(i) {
    var tj = X.mvTry ? X.mvTry.j : -1;
    if (tj >= 0 && tj < i) return null;                    // the move in progress lands on a surviving hop
    var pj = tj >= i ? tj : (S.cur >= i ? S.cur : -1);
    if (pj < 0 || !S.hops[pj]) return null;
    var s0 = (pj === tj && X.seekCtx) ? X.seekCtx.target : S.hops[pj].s0;
    return { s0: s0, resume: S.playing };                 // S.playing is the play intent, seeks included (r2-01)
  }
  function onWalkHop(h, i) {
    var at = null;
    if (i < S.hops.length) {
      if (S.hops[i].pano === h.pano) return;               // retry re-emit of a known hop
      at = reanchorAt(i);
      truncateHops(i);
    }
    var hop = copyHop(h);
    hop.i = S.hops.length;
    S.hops.push(hop);
    indexHop(hop);
    /* The exit hop of a detour the walker dropped (GPS-denied imagery: R-A's garage ramp) lists its panos; the repair
       search never walks them (a 1-2 pano detour is within its reach and would come back as ghost legs). */
    if (h.avoid && h.avoid.length) for (var q = 0; q < h.avoid.length; q++) X.avoid[String(h.avoid[q])] = 1;
    S.frontierS0 = Math.max(S.frontierS0, hop.s0);
    drawBuf();
    if (hop.i > 0) queueRepair(hop.i);
    if (hop.i === 0 && S.curPanoId == null) { prime(); return; }
    if (at && !(S.pending && S.pending.type === "seek")) {   // a pending user seek already moves the Player
      log("reanchor", { at: i, s0: r1(at.s0) });
      post({ type: "seek", s0: at.s0, resume: at.resume, exact: true });   // exact: wait until the new chain
      return;                                                               // reaches it (usually a "same" land)
    }
    if (S.phase === "WAIT_CHAIN") resumeFromWait();
  }
  function onWalkDone(sum) {
    sum = sum || { reason: "end" };
    if (navigator.onLine === false && (sum.reason === "gap-to-end" || sum.reason === "no-coverage")) {
      sum = { reason: "error", offline: true, hops: S.hops.length };   // offline is not "no imagery"
    }
    S.walkDone = sum;
    log("walk", { reason: sum.reason, hops: S.hops.length });
    if (!S.hops.length) {
      if (sum.reason === "error") { errorCard("Couldn't load more Street View.", retryWalk); return; }
      toastMsg("No Street View coverage along this route.");
      close();
      return;
    }
    if (S.phase === "WAIT_CHAIN") resumeFromWait();
  }
  function onWalkError() {
    S.walkDone = { reason: "error" };
    log("err", { what: "walker" });
    if (!S.hops.length) { errorCard("Couldn't load more Street View.", retryWalk); return; }
    if (S.phase === "WAIT_CHAIN") resumeFromWait();
  }
  function retryWalk(noResume) {
    if (noResume !== true) noResume = false;           // card buttons pass an event-less call
    /* r2-02: Retry belongs to the error card or a frontier wait. A stale Retry (the card outlived its state)
       must never start a second settle chain over a move in flight. r3-06: keyed on the error card being up as
       well as on the phase (any move away from the card takes it down: leaveCard). */
    var errUp = !!(X.card && X.card.err) && !Lock.busy && !X.midMove && !X.gating;
    if (!noResume && S.phase !== "ERROR" && S.phase !== "WAIT_CHAIN" && !errUp) { hideCard(); return; }
    hideCard();
    var need = !S.walkDone || S.walkDone.reason === "error" || S.walkDone.reason === "budget" || X.stalled;
    X.badRun = 0;
    X.stalled = false;
    if (need) {
      if (S.walker) { try { S.walker.cancel(); } catch (e) { /* ignore */ } }
      S.walkDone = null;
      X.budgetHit = false;
      Svc.sessionCalls = 0;                                  // a user retry gets a fresh allowance
      newWalker();
    }
    if (S.curPanoId == null || noResume) return;            // never primed: hop 0 of the new walker primes
    /* r3-07: a seek still pending (the chain stalled while it waited) keeps its own play intent: a paused seek lands
       paused after Retry (or the automatic reconnect retry) instead of resuming playback. */
    var sk = (S.pending && S.pending.type === "seek") ? S.pending : null;
    S.playing = sk ? !!sk.resume : true;
    if (S.playing) endLook();                               // playback resumes: the camera steers again (r1-01)
    setPlayIcon(S.playing ? "pause" : "play");
    if (Lock.busy || X.midMove || X.gating || S.cam.anim) return;   // a move in flight goes on into decide()
    phase("SETTLE");
    settle(S.cur);
  }

  /* ---------------- Priming hop 0 (§9.4): never setPov in the same tick as setPano ---------------- */

  function prime() {
    phase("PRIMING");
    var h0 = S.hops[0];
    lockWhenFree(ep(function () {
      if (safePano() === h0.pano && safeStatus() === okStatus()) {   // reopen on the same start: no setPano
        return primed({ landed: h0.pano, status: okStatus(), reason: "same", dt: 0 });
      }
      /* Measured (smoke r2): a never-shown visible:false panorama does no lookup for setPano, so the
         prime cut fell back at 1104 ms with no status_changed and its tiles started only after the
         reveal. Show it first; the opaque cover still hides everything above the attribution band. */
      try { if (!S.pano.getVisible()) S.pano.setVisible(true); } catch (e) { /* ignore */ }
      lockGo(h0.pano, "cut", { idx: 0 }, ep(primed));
      Timers.set(function () { if (!S.pano.getVisible()) S.pano.setVisible(true); }, SIM.primeVisibleFallbackMs);
    }));
  }
  function primed(r) {
    var h0 = S.hops[0];
    if (r.landed !== h0.pano && !X.primeRetried) {
      X.primeRetried = true;
      lockGo(h0.pano, "cut", { idx: 0 }, ep(primed));
      return;
    }
    S.cur = 0;
    S.curPanoId = r.landed || h0.pano;
    var c = camTarget(0);
    h0.T = c.T; h0.camKind = c.kind;
    zoomSet(S.zoom);
    povSet(c.T);
    try { S.pano.setVisible(true); } catch (e) { /* ignore */ }   // all at rest, under the cover
    reveal(S.curPanoId, (Net.ok && Net.supported) ? SIM.revealCapMs : SIM.revealFallbackMs, function () {
      dim("off");
      land(0, "start");
      phase("PAUSED");
      log("reveal", { pov: Math.round(povHeading() * 10) / 10, T: Math.round(c.T * 10) / 10 });
      if (h0.s0 > SIM.startChipM) chip("Street View starts " + shortDist(h0.s0) + " into the route", SIM.startChipMs);
      if (S.pending || S.playing) decide();            // Play or a seek arrived while priming
      else if (!S.reduced) X.autoT = Timers.set(function () { X.autoT = 0; play(); }, SIM.autoplayMs);
    });
  }
  /* The first-tile wait after a cut or the prime belongs to that move (fix r1-02): the Lock is free, but
     post(), decide() and userLook() treat X.midMove as busy, so a seek or step waits for this land/settle
     (which picks it up from S.pending) instead of starting a second move under a stale continuation. */
  function reveal(id, cap, fn) {
    X.midMove = true;
    Net.firstTile(id, cap, ep(function () { X.midMove = false; fn(); }));
  }

  /* ---------------- The Player: the only caller of the Lock (§9.5-§9.7) ---------------- */

  function speedObj() { return SIM.speeds[S.speedIdx] || SIM.speeds[1]; }
  function mul() { return speedObj().mul; }
  function badStatus(st) { return st != null && st !== okStatus(); }
  function panoLL(id) {
    var m = Svc.peek(id);
    if (m) return metaLL(m);
    var i = S.byPano[id];
    return i != null ? S.hops[i] : null;
  }
  function legsDist(fromId, legs) {
    var a = panoLL(fromId), d = 0;
    for (var k = 0; k < legs.length; k++) {
      var b = panoLL(legs[k]);
      if (a && b) d += distLL(a, b);
      a = b;
    }
    return d || 10;
  }
  function isLinkedNow(id) {
    var L = null, i;
    try { L = S.pano.getLinks(); } catch (e) { L = null; }
    if (L && L.length) {
      for (i = 0; i < L.length; i++) if (L[i] && L[i].pano === id) return true;
      return false;
    }
    var m = Svc.peek(S.curPanoId);
    if (m) for (i = 0; i < m.links.length; i++) if (m.links[i].pano === id) return true;
    return false;
  }
  function adoptIdx(id, near) {
    var a = id ? X.byPanoAll[id] : null, best = null;
    if (!a) return null;
    for (var i = 0; i < a.length; i++) if (best == null || Math.abs(a[i] - near) < Math.abs(best - near)) best = a[i];
    return best;
  }
  function hopAtOrBefore(s0) {
    var H = S.hops, lo = 0, hi = H.length - 1;
    if (!H.length || H[0].s0 > s0) return 0;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (H[mid].s0 <= s0) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function decide() {                              // the only place a move starts
    /* Each of these is a move in progress: gating = waiting for the network; midMove = a cut revealing or a
       re-lookup (r1-02); a live WAIT_PLAN timer = waiting for a repair plan (r1-08). Each ends in decide(). */
    if (!S.open || Lock.busy || X.midMove || S.cam.anim || X.gating) return;
    if (S.phase === "WAIT_PLAN" && X.waitT) return;
    if (S.pending) return runPending();
    if (!S.playing) {
      if (onCard()) return;                          // r3-06: ERROR / ENDED stay what they are under their card
      /* r2-03: the network dropped (onOffline paused) and came back while a move was still in flight; the
         playback the user never paused resumes here instead of parking for good (r3-10: never in a hidden tab). */
      if (!X.resumeOnline || navigator.onLine === false || document.hidden) return phase("PAUSED");
      X.resumeOnline = false;
      S.playing = true;
      setPlayIcon("pause");
    }
    var j = S.cur + 1;
    if (!S.hops[j]) {
      if (!S.walkDone) return waitChain(false);
      return atFrontier();
    }
    phase("MOVE");
    X.gating = true;
    Net.gate(S.curPanoId, fl(function () { X.gating = false; move(j); }));
  }
  function atFrontier() {
    var w = S.walkDone;
    /* §20 / r1-06: a walker that broke because the browser is offline waits (chip) instead of escalating;
       onOnline retries it from WAIT_CHAIN. */
    if (w && w.reason === "error" && navigator.onLine === false) return waitChain(false);
    if (w && (w.reason === "error" || w.reason === "budget")) return errorCard("Couldn't load more Street View.", retryWalk);
    return end();
  }

  /* opt.forceCut for seeks to non-neighbours. */
  function move(j, opt) {
    opt = opt || {};
    var hop = S.hops[j];
    if (!hop) return decide();
    var A = S.curPanoId, C = hop.pano, plan = S.plan[j];
    var fromPrev = j > 0 && S.hops[j - 1].pano === A;   // a repair path starts at hops[j-1]
    if (!opt.retry) X.mvTry = { j: j, retried: false };
    if (C === A) {
      X.moveT0 = now(); X.moveFrom = S.cur; X.moveDist = 0; S.m.moves++;
      land(j, "same");
      return settle(j);
    }
    var legs = null, mode = null, al = null;
    if (!opt.forceCut && isLinkedNow(C)) {
      legs = [C]; mode = "link";
      al = aliasAfter(j);
      if (al && al !== A && isLinkedNow(al)) legs = [al];   // r1-20: arrive at hop j ON that alias (a forward link)
    } else if (!opt.forceCut && fromPrev && plan && plan.via && plan.via !== "pending" && plan.via.length &&
               isLinkedNow(plan.via[0])) {
      legs = plan.via.concat([C]); mode = "ghost";
    } else if (!opt.forceCut && fromPrev && plan && plan.via === "pending") {
      if (!X.waitSince) X.waitSince = now();
      var waited = now() - X.waitSince;
      if (waited < SIM.repairWaitMs) {
        phase("WAIT_PLAN");
        if (waited >= 600 && X.chipText !== "Finding the street ahead…") chip("Finding the street ahead…");
        X.waitT = Timers.set(fl(function () { X.waitT = 0; move(j, opt); }), 100);
        return;
      }
    }
    if (X.waitSince) { X.waitSince = 0; chipClearWaiting(); }
    if (!legs) return cutTo(j);
    X.moveT0 = now(); X.moveFrom = S.cur; S.m.moves++;
    if (mode === "link") S.m.linked++;
    else { S.m.repaired++; S.m.ghostLegs += legs.length - 1; }
    hop.ghosts = legs.length - 1;
    X.moveDist = legsDist(A, legs);
    phase("MOVE");
    runLegs(j, legs, 0, mode, hop);
  }
  /* r1-20: hop j+1's repair path is one alias of hop j (a co-located capture < SIM.aliasM away that links hop
     j+1). Walked as a ghost leg it is a ~565 ms crossfade with no motion between the turn rotation and the exit.
     When the alias is linked from where the Player comes from, move(j) arrives ON it (a forward link); otherwise
     settle(j) crosses into it first (aliasStep), so the exit right after the camera steps is a plain link. */
  function aliasAfter(j) {
    var C = S.hops[j], plan = S.plan[j + 1];
    if (!C || !S.hops[j + 1] || !plan || !plan.via || plan.via === "pending" || plan.via.length !== 1) return null;
    var al = plan.via[0], ll = panoLL(al);
    return (ll && distLL(C, ll) < SIM.aliasM) ? al : null;
  }
  function aliasStep(j, al) {                          // a settle step; the Lock is free here (settle follows a land)
    return function (next, tok) {
      X.gating = true;
      Net.gate(S.curPanoId, fl(function () {
        X.gating = false;
        if (!live(tok)) return;
        if (Lock.busy) return next();                // cannot happen (decide is gated); never wedge the chain
        lockGo(al, "link", { idx: j, ghost: true, zoom: zoomForGo() }, ep(function (r) {
          if (r.landed) S.curPanoId = r.landed;      // a miss is harmless: move(j+1) plans from wherever it is
          if (live(tok)) next();
        }));
      }));
    };
  }
  /* hop: the target captured when the move started; a retry walker that replaces it ends the move (r1-05).
     r2-09: once the first leg of a repair path is issued the whole path is one move in flight (X.midMove) until
     it lands, so Pause, a hidden tab or looking around can no longer strand the Player on a ghost pano between
     legs; only the first leg's network gate (nothing issued yet) is still cancellable, like any playback move. */
  function runLegs(j, legs, k, mode, hop) {
    var id = legs[k];
    if (k > 0 && !isLinkedNow(id)) { X.midMove = false; return cutTo(j); }   // a ghost leg turned out unlinked
    var d = mode === "ghost" ? legTurn(j, legs, k) : 0;
    if (d) {
      var from = povHeading(), ms = Math.round(steerMs(Math.abs(d)) * mul());
      log("steer", { from: r1(from), to: r1(norm360(from + d)), ms: S.reduced ? 0 : ms, kind: "leg" });
      return camTo(from, d, ms, fl(function () { legGo(j, legs, k, mode, hop); }));
    }
    legGo(j, legs, k, mode, hop);
  }
  function legGo(j, legs, k, mode, hop) {
    X.gating = true;
    Net.gate(S.curPanoId, fl(function () {
      X.gating = false;
      if (legs.length > 1) X.midMove = true;
      lockGo(legs[k], "link", { idx: j, ghost: k < legs.length - 1, zoom: zoomForGo(), onIssue: issueHook(j, k, legs) },
        ep(function (r) { onLeg(j, legs, k, mode, r, hop); }));
    }));
  }
  /* r2-05 (spec §10: the heading carries over between ghost legs). r1-19 turned the camera to within 10 deg of
     every leg, and along a zigzag repair path that swung it back and forth (R-A k9: 58 deg right after "Turn left
     now", then left twice; hops 42-44 faced a wall). The first leg is now aimed by camTarget (legBound); between
     legs the camera turns only when the next leg is long and more than SIM.legSteerDeg off the view, and only far
     enough to bring it to SIM.legSideDeg -- never away from where the rest of the path goes, never against the
     turn whose exit this path is, and never while the user owns the camera. */
  function legTurn(j, legs, k) {
    if (k < 1 || S.userLook) return 0;
    var tk0 = exitTurnOf(X.moveFrom), st = tk0 && tk0.stage;
    if (st && st.j === j && st.aims.length === legs.length && st.aims[k] != null) {   // a staged turn (stagedAims)
      tk0.aimT = st.aims[k];                           // DONE judges the camera against the stage it turns to
      var ds = angDiff(st.aims[k], povHeading());
      return Math.abs(ds) < SIM.deadBandDeg ? 0 : ds;
    }
    var a = panoLL(S.curPanoId), b = panoLL(legs[k]), c = S.hops[j];
    if (!a || !b || distLL(a, b) < SIM.legLongM) return 0;
    var h = povHeading(), d = angDiff(brgLL(a, b), h);
    if (Math.abs(d) <= SIM.legSteerDeg) return 0;
    if (c && distLL(a, c) >= SIM.legMinM && angDiff(brgLL(a, c), h) * d < 0) return 0;   // a zigzag leg
    var tk = exitTurnOf(X.moveFrom);
    if (tk && !isUturn(tk) && d * tk.netDeg < 0) return 0;
    return d - SIM.legSideDeg * sgn(d);
  }
  function exitTurnOf(i) {                            // the turn whose turn pano this move leaves, if any
    for (var t = 0; t < S.turns.length; t++) if (i >= 0 && S.turns[t].turnPano === i) return S.turns[t];
    return null;
  }
  function isUturn(k) { return k.kind === "uturn" || Math.abs(k.netDeg) >= 150; }
  function issueHook(j, k, legs) {
    return ep(function (t0, pv) {
      if (k <= 0) {
        var f = S.hops[X.moveFrom];
        if (f && X.moveFrom === S.cur) { f.povAtIssue = r1(pv); f.issueT = Math.round(t0); }
        markExitIssued(X.moveFrom, j);
      }
      if (legs && S.hops[j]) MapView.tweenLeg(j, k, legs, t0);   // r2-13: a retry walker may have dropped hop j
    });
  }
  function onLeg(j, legs, k, mode, r, hop) {
    if (r.landed) S.curPanoId = r.landed;
    if (S.hops[j] !== hop) { X.midMove = false; return abandonMove(r); }   // a retry walker replaced the target (r1-05)
    if (r.landed !== legs[k] || badStatus(r.status)) { X.midMove = false; return mismatch(r, j); }
    if (k + 1 < legs.length) return runLegs(j, legs, k + 1, mode, hop);   // still mid-path: X.midMove stays set
    X.midMove = false;
    land(j, mode === "ghost" ? "ghost" : "link");
    settle(j);
  }
  function cutTo(j) {
    var hop = S.hops[j];
    if (!hop) return decide();
    if (!X.mvTry || X.mvTry.j !== j) X.mvTry = { j: j, retried: false };   // the target of the move in progress
    S.m.moves++;
    S.m.cuts++;
    if (hop.jump && hop.gapM > 25) S.m.cutsIntoBigJumps++;
    X.moveT0 = now(); X.moveFrom = S.cur; X.moveDist = 10;   // a cut paces like one nominal hop at 0.5x
    phase("MOVE");
    dim("on");
    Timers.set(function () { MapView.tweenCut(j); }, SIM.dimInMs);
    lockGo(hop.pano, "cut", { idx: j, onIssue: issueHook(j, -1, null) }, ep(function (r) {
      if (r.landed) S.curPanoId = r.landed;
      if (S.hops[j] !== hop) return abandonMove(r);
      if (r.landed !== hop.pano || badStatus(r.status)) return mismatch(r, j);
      X.zoomDirty = false;
      creepStop();
      zoomSet(S.zoom);
      povSet(camTarget(j).T);                                  // at rest, under the dim
      reveal(r.landed, SIM.cutRevealCapMs, function () {
        if (S.hops[j] !== hop) return abandonMove(null);
        dim("off"); land(j, "cut"); settle(j);
      });
    }));
  }
  function mismatch(r, j) {
    S.m.mismatch++;
    log("err", { what: "mismatch", expected: r.expected, landed: r.landed, status: r.status });
    if (badStatus(r.status)) {
      S.m.badStatus++;
      if (navigator.onLine === false) return offlineHold();     // §20: offline is never escalated (r1-06)
      X.badRun++;
      if (X.badRun >= 3) { dim("off"); return errorCard("Street View stopped responding.", retryWalk); }
      return relookup(j);
    }
    if (X.mvTry && X.mvTry.j === j && !X.mvTry.retried) { X.mvTry.retried = true; return cutTo(j); }
    dim("off");
    var a = adoptIdx(r.landed, j);
    if (a != null) { land(a, "adopt"); return settle(a); }
    land(j, "accept");                                         // accept the landed pano; continue from j
    settle(j);
  }
  /* A non-OK status: one location re-lookup within 15 m, else skip to j+1 by cut. The failed move is still in
     progress until that lands (X.midMove, r1-02/r1-08), so no seek can start a second move meanwhile. */
  function relookup(j) {
    var hop = S.hops[j], over = false, capT = 0;
    if (!hop) return abandonMove(null);
    X.midMove = true;
    function got(d, st) {
      if (over) return;
      over = true;
      Timers.clear(capT);
      X.midMove = false;
      if (S.hops[j] !== hop) return abandonMove(null);
      var id = (st === okStatus() && d && d.location) ? d.location.pano : null;
      if (id && id !== S.curPanoId) {
        dim("on");
        lockGo(id, "cut", { idx: j }, ep(function (r) {
          if (r.landed) S.curPanoId = r.landed;
          if (S.hops[j] !== hop) return abandonMove(r);
          if (badStatus(r.status)) return mismatch(r, j);
          zoomSet(S.zoom);
          povSet(camTarget(j).T);
          reveal(S.curPanoId, SIM.cutRevealCapMs, function () {
            if (S.hops[j] !== hop) return abandonMove(null);
            dim("off"); land(j, "relook"); settle(j);
          });
        }));
        return;
      }
      if (S.hops[j + 1]) return cutTo(j + 1);
      dim("off");
      land(j, "accept");
      settle(j);
    }
    capT = Timers.set(function () { got(null, "TIMEOUT"); }, SIM.relookMaxMs);   // the lookup can never wedge the Player
    Svc.getPanorama({ location: { lat: hop.lat, lng: hop.lng }, radius: 15, sources: [srcGoogle()], preference: prefNearest() },
      ep(got));
  }
  /* r1-05: a retry walker replaced the hop this move was going to while it was in flight. The pano we are on is
     real imagery; the Player carries on from S.pending (the reanchor seek onWalkHop posted, or the user's own). */
  function abandonMove(r) {
    if (r && r.landed) S.curPanoId = r.landed;
    X.mvTry = null;
    X.seekCtx = null;
    if (X.dimOn) dim("off");
    log("err", { what: "hop-replaced" });
    phase("SETTLE");
    decide();
  }
  /* §20 / r1-06: a move failed because the browser is offline. Never escalate: hold here, say so, and keep the
     user's intent (their seek, else a rejoin of the last good hop) for when the network is back; onOnline
     resumes a playback that the user had not paused. */
  function offlineHold() {
    /* r3-08: the intent is S.playing (onOffline may have paused it: X.offlineHeld), never the seek's resume flag
       captured when it started -- a Pause during the seek left that true and onOnline then resumed playback. */
    var sc = X.seekCtx, held = X.offlineHeld || S.playing;
    if (X.dimOn) dim("off");
    X.mvTry = null;
    X.seekCtx = null;
    pause();
    phase("PAUSED");
    S.pending = sc ? { type: "seek", s0: sc.target, resume: held } : { type: "rejoin" };
    X.offlineHeld = held;
    chip("You're offline");
    log("err", { what: "offline-hold" });
  }

  /* §9.7 landing: everything that depends on WHERE we are (HUD, stops, gaps, map). */
  function land(j, mode) {
    var hop = S.hops[j];
    if (!hop) return;
    var back = S.cur >= 0 && j < S.cur;
    S.cur = j;
    S.shown[hop.pano] = 1;
    var t = now();
    S.landT.push(t); S.landS0.push(hop.s0);
    if (S.landT.length > 8) { S.landT.shift(); S.landS0.shift(); }
    hop.mode = mode;
    hop.settleT = Math.round(t);
    if (mode !== "accept") X.badRun = 0;
    X.mvTry = null;
    var total = totalM();
    els.pos.textContent = km1(hop.s0) + " of " + km1(total) + " km";
    if (!scrubOwned()) {                               // r3-02: never under a pending drag or keyboard commit
      els.scrub.value = String(Math.round(hop.s0));
      els.scrub.setAttribute("aria-valuetext", km1(hop.s0) + " of " + km1(total) + " kilometres");
    }
    log("land", { idx: j, s0: hop.s0, mode: mode });
    var sc = X.seekCtx;
    if (sc) { X.seekCtx = null; seekLanded(sc, hop); }
    else if (back) hudRebuild(hop);
    MapView.landed(j);
    hudUpdate();
    stopsCheck(j);
    /* §12.6: the gap chip is about travel. r2-14: a seek (End: 3.9 km) that happens to land on a jump hop skipped
       no 140 m gap, so only a move from the hop before (playback or a step) says so. */
    if (!sc && X.moveFrom === j - 1 && hop.jump && (hop.gapM > SIM.gapChipM || hop.distM > SIM.gapChipDistM)) {
      var gd = hop.gapM > 0 ? hop.gapM : hop.distM;
      chip("No Street View for " + shortDist(gd) + " — skipping ahead", SIM.gapChipMs);
      say("Skipping " + sayDist(gd) + " with no Street View", "gap:" + j);
      X.gapHoldFor = j;
    }
  }
  /* r2-01: the landing no longer decides playback. S.playing took the seek's resume when the seek was posted, and
     any Play, Pause or hidden tab since then has updated it, so the latest intent is what settle() -> decide()
     acts on. (It used to be overwritten here: Pause during a resuming seek was reversed, Play during a paused
     seek dropped, a hidden tab resumed in the background, and a second Next stopped playback.) */
  function seekLanded(sc, hop) {
    for (var i = 0; i < S.stops.length; i++) S.stops[i].fired = S.stops[i].s0 < sc.target - SIM.stopLeadM;
    hudRebuild(hop);
    var n = S.landT.length;                            // r2-07: a seek is not travel; the speed is measured afresh
    if (n > 1) { S.landT = [S.landT[n - 1]]; S.landS0 = [S.landS0[n - 1]]; }
    if (S.playing) endLook();                          // Replay or a resuming seek: the camera steers again (r1-01)
    setPlayIcon(S.playing ? "pause" : "play");
  }

  /* SETTLE: stop hold, camera, dwell, gap hold — then decide (§9.7). */
  function settle(j) {
    if (!S.open) return;
    if (!S.hops[j]) return decide();                   // replaced by a retry walker: never strand the flow (r1-05)
    phase("SETTLE");
    var hop = S.hops[j], steps = [], m = mul();
    if (X.stopHoldFor === j) { X.stopHoldFor = -1; steps.push(stopHoldStep(j)); }
    if (!S.hops[j + 1]) {
      if (!S.walkDone) return run(steps, S.playing ? function () { waitChain(false); } : decide);   // paused: no wait/stall
      return run(steps, atFrontier);
    }
    var c = camTarget(j);
    hop.T = r1(c.T); hop.camKind = c.kind;
    var a = mv(j), b = mv2(j);
    hop.mv = a == null ? null : r1(a); hop.mv2 = b == null ? null : r1(b); hop.chord = r1(chord(j));
    var al = (S.playing && S.curPanoId === hop.pano) ? aliasAfter(j) : null;
    if (al && isLinkedNow(al)) steps.push(aliasStep(j, al));   // r1-20 (its crossfade stands in for the turn hold)
    else al = null;
    var dT = Math.abs(angDiff(c.T, povHeading()));
    /* A turn pano with nothing to swing here (a staged turn whose first leg runs on into the junction) gets no holds:
       they would be a still corner with no turn in it. */
    if (c.kind === "turn" && dT >= SIM.deadBandDeg) {
      if (!al) steps.push(holdStep(SIM.turnHoldBeforeMs * m));
      steps.push(steerStep(c, true));
      if (!S.reduced) steps.push(holdStep((c.uturn ? SIM.uturnHoldMs : SIM.turnHoldAfterMs) * m));
    } else if (dT >= SIM.deadBandDeg) {
      steps.push(steerStep(c, false));
    }
    if (S.speedIdx === 0) steps.push(dwellStep());
    if (X.gapHoldFor === j) { X.gapHoldFor = -1; steps.push(holdStep(SIM.gapHoldMs * m)); }
    run(steps, decide);
  }
  /* Runs step functions in order; any posted intent cuts the chain short at the next step. */
  function run(steps, done) {
    var tok = ++X.runTok, i = 0;
    function next() {
      if (tok !== X.runTok || !S.open) return;
      if (S.pending) { X.runTok++; return decide(); }
      if (i >= steps.length) return done();
      steps[i++](next, tok);
    }
    next();
  }
  function live(tok) { return S.open && tok === X.runTok; }
  function holdStep(ms) {
    return function (next) { X.stepT = Timers.set(next, ms); };
  }
  function steerMs(a) {
    if (a < 12) return SIM.steerSmallMs;
    if (a < 35) return SIM.steerMidMs;
    return Math.min(SIM.steerMaxMs, SIM.steerTurnBaseMs + SIM.steerTurnPerDeg * a);
  }
  function steerStep(c, isTurn) {
    return function (next) {
      if (S.userLook) return next();                   // the user owns the camera until Play
      var from = povHeading(), d = angDiff(c.T, from);
      /* A U-turn rotates the way the route turns, even past 180 -- but only when the shortest way is ambiguous
         (r1-10: forcing every sign turned a 3 deg correction after a step back into a 357 deg spin). r3-15: so does
         a sharp turn whose aim (now kept on its exit move, up to 40 deg past the exit street) is >= 150 deg away. */
      var spin = isTurn && !!c.k && (c.uturn || Math.abs(c.k.netDeg) >= 120) && Math.abs(d) >= 150;
      if (spin) {
        var sg = (c.k && c.k.netDeg < 0) ? -1 : 1;
        if (sg > 0 && d < 0) d += 360; else if (sg < 0 && d > 0) d -= 360;
      }
      if (Math.abs(d) < 0.5) return next();
      var ms = isTurn ? (spin ? SIM.uturnMs : Math.min(SIM.steerMaxMs, SIM.steerTurnBaseMs + SIM.steerTurnPerDeg * Math.abs(d)))
                      : steerMs(Math.abs(d));
      ms = Math.round(ms * mul());
      log("steer", { from: r1(from), to: r1(norm360(from + d)), ms: S.reduced ? 0 : ms, kind: c.kind });
      camTo(from, d, ms, next);
    };
  }
  /* 0.5x: distance-scaled dwell with a creep zoom (D29). r3-17 (deviates from §9.8's uncapped dwell): at most
     SIM.dwellMaxMs. A long move (R-A k9's 33 m repair path, a 23 m link) is still one ~560 ms transition, and it used
     to end in a 1.4-2 s still frame (feel r3: 818 ms visibly still); such moves now run a little faster than 9 m/s. */
  function dwellMs() { return Math.max(0, 1000 * (X.moveDist || 10) / SIM.speeds[0].mps - (now() - X.moveT0)); }
  function dwellStep() {
    return function (next) {
      var ms = Math.min(dwellMs(), SIM.dwellMaxMs);
      if (ms <= 0) return next();
      if (ms >= SIM.creepMinMs && !S.reduced) creepStart(ms);
      X.stepT = Timers.set(next, ms);
    };
  }

  /* ---------------- Camera primitives (§11.1): rAF setPov only while the Lock is free ---------------- */

  function povSet(h) {
    if (Lock.busy) { S.m.povSetBusy++; log("err", { what: "povset-busy" }); return; }
    log("povset", { heading: r1(norm360(h)), busy: false });
    try { S.pano.setPov({ heading: norm360(h), pitch: SIM.pitch }); } catch (e) { /* ignore */ }
  }
  function zoomSet(z) {
    if (Lock.busy) { S.m.zoomSetBusy++; X.zoomDirty = true; log("err", { what: "zoomset-busy" }); return; }
    log("zoomset", { z: z, busy: false });
    try { S.pano.setZoom(z); } catch (e) { /* ignore */ }
  }
  /* The zoom for the next lockGo: a pending layout zoom or the creep reset rides inside the transition. */
  function zoomForGo() {
    if (!X.zoomDirty && !X.creep) return null;
    X.zoomDirty = false;
    creepStop();
    return S.zoom;
  }
  function creepStart(ms) {
    var z0 = S.zoom, z1 = round2(S.zoom * SIM.creepZoom), t0 = now();
    creepStop();
    X.creep = true;
    log("zoomset", { z: z1, busy: false, creep: true });
    function tick() {
      if (!X.creep || Lock.busy) return;
      var u = clamp((now() - t0) / ms, 0, 1);         // linear: no dead stop before the next transition (r1-22)
      try { S.pano.setZoom(z0 + (z1 - z0) * u); } catch (e) { /* ignore */ }
      if (u < 1) X.creepRaf = Timers.raf(tick);
      else X.creepRaf = 0;
    }
    X.creepRaf = Timers.raf(tick);
  }
  function creepStop() {                               // stops the ramp; X.creep stays set until the reset rides a go
    if (X.creepRaf) Timers.cancelRaf(X.creepRaf);
    X.creepRaf = 0;
  }
  function camTo(from, delta, ms, done) {
    camCancel();
    var to = norm360(from + delta);
    if (S.reduced || ms <= 0 || Math.abs(delta) < 0.5) {
      povSet(to); chevApply(to); MapView.cone(to, true);
      if (done) done();
      return;
    }
    var t0 = now(), anim = { to: to, done: done };
    S.cam.anim = anim;
    function tick() {
      if (S.cam.anim !== anim) return;
      /* r3-13: the user took the camera (looking around while a repair path is between legs, where userLook leaves
         the move running, r2-09). Stop turning it under their drag, where it is, and let the move carry on. */
      if (S.userLook) { S.cam.anim = null; S.cam.raf = 0; if (done) done(); return; }
      var u = clamp((now() - t0) / ms, 0, 1), h = norm360(from + delta * easeInOutSine(u));
      povSet(h); chevApply(h); MapView.cone(h, false);
      if (u >= 1) { S.cam.anim = null; S.cam.raf = 0; if (done) done(); return; }
      S.cam.raf = Timers.raf(tick);
    }
    S.cam.raf = Timers.raf(tick);
  }
  function camCancel() {
    if (S.cam.raf) Timers.cancelRaf(S.cam.raf);
    S.cam.raf = 0;
    S.cam.anim = null;
  }
  function camFinish() {                               // jump to the end of an ease, then continue its flow
    var a = S.cam.anim;
    if (!a) return;
    camCancel();
    povSet(a.to); chevApply(a.to);
    if (a.done) a.done();
  }

  /* ---------------- Waits, end, error (§9.10) ---------------- */

  function waitChain(isSeek) {
    phase("WAIT_CHAIN");
    Timers.clear(X.chainChipT); Timers.clear(X.stallT);
    X.chainChipT = 0;
    if (!isSeek) {
      X.chainChipT = Timers.set(function () {
        X.chainChipT = 0;
        chip(navigator.onLine === false ? "You're offline" : "Finding the street ahead…");
      }, SIM.chainChipMs);
    }
    X.stallT = Timers.set(onStall, SIM.chainStallMs);
  }
  function onStall() {
    X.stallT = 0;
    if (S.phase !== "WAIT_CHAIN") return;
    if (navigator.onLine === false) { chip("You're offline"); X.offlineWait = true; return; }   // not escalated offline
    X.stalled = true;
    errorCard("Couldn't load more Street View.", retryWalk);
  }
  function resumeFromWait() {
    if (S.phase !== "WAIT_CHAIN" || !S.open) return;
    Timers.clear(X.chainChipT); Timers.clear(X.stallT);
    X.chainChipT = X.stallT = 0;
    chipClearWaiting();
    if (S.pending) return decide();
    settle(S.cur);
  }
  function end() {
    phase("ENDED");
    S.playing = false;
    setPlayIcon("replay");
    var last = S.hops[S.hops.length - 1], cur = S.hops[S.cur] || last;
    if (!scrubOwned()) els.scrub.value = String(Math.round(last.s0));
    var fin = RR.home ? llOf(RR.home.location) || (RR.home.lat != null ? { lat: RR.home.lat, lng: RR.home.lng } : null) : null;
    if (fin && cur && !Lock.busy) {
      var dl = angDiff(brgLL(cur, fin), povHeading());
      if (distLL(cur, fin) <= 60 && Math.abs(dl) > 30) camTo(povHeading(), dl, 600, null);
    }
    var total = totalM(), tail = total - last.s0;
    showCard("Finish · " + km1(total) + " km",
      tail > 60 ? "Street View ends " + shortDist(tail) + " before the finish." : "",
      "Replay", replay, "Close", close, false);
    S.endShown = true;
    say("Preview finished", "end");
  }
  function errorCard(text, fn) {
    phase("ERROR");
    S.playing = false;
    X.mvTry = null;                                  // the failed move is over...
    X.seekCtx = null;                                // ...and so is its seek (r2-12: it re-marked stops at a later land)
    X.resumeOnline = false;
    /* r2-15: the card is the only message: no chip ("Finding the street ahead…" and the like; "You're offline" stays,
       it says why) and no "Now" turn card under it (the next land redraws the turn HUD). */
    Timers.clear(X.chainChipT); Timers.clear(X.stallT);
    X.chainChipT = X.stallT = 0;
    if (X.chipText !== "You're offline") chipClear();
    endDoneShow();
    Timers.clear(X.hudWaitT); X.hudWaitT = 0;
    hudHideTurn();
    chevHide();
    beaconHide();
    setPlayIcon("play");
    showCard(text, "", "Retry", fn, "Close", close, true);
    say(text, "card");
  }
  /* r2-02: a seek or step that moves away from the end or error card takes the card down with it (an error card
     used to stay over the pano while playback went on under it, its Retry still live). */
  function leaveCard() {
    S.endShown = false;
    if (S.phase === "ERROR") X.badRun = 0;           // the user's own move is a fresh try (one re-lookup first)
    if (X.card) hideCard();
    setPlayIcon(S.playing ? "pause" : "play");       // leaving ENDED / ERROR: no Replay icon on a moving preview
  }
  function showCard(text, sub, altLabel, altFn, mainLabel, mainFn, isError) {
    els.cardText.textContent = text;
    els.cardSub.textContent = sub || "";
    els.cardSub.hidden = !sub;
    els.cardAlt.textContent = altLabel || "";
    els.cardAlt.hidden = !altLabel;
    els.cardMain.textContent = mainLabel;
    if (isError) els.card.setAttribute("role", "alert"); else els.card.removeAttribute("role");
    els.card.hidden = false;
    X.card = { alt: altFn, main: mainFn, err: !!isError };
  }
  /* The error or end card is up and its phase is current (r3-06). */
  function onCard() { return !!X.card && (S.phase === "ERROR" || S.phase === "ENDED"); }
  function hideCard() {
    var had = !!(document.activeElement && els.card.contains(document.activeElement));
    els.card.hidden = true;
    els.card.removeAttribute("role");
    X.card = null;
    if (had && S.open) { try { els.play.focus(); } catch (e) { /* ignore */ } }   // r1-13: never drop focus to <body>
  }

  /* ---------------- Play, pause, intents (§9.9) ---------------- */

  function setPlayIcon(kind) {
    if (kind === "pause") { els.play.innerHTML = ICON_PAUSE; els.play.setAttribute("aria-label", "Pause"); }
    else if (kind === "replay") { els.play.innerHTML = ICON_REPLAY; els.play.setAttribute("aria-label", "Replay"); }
    else { els.play.innerHTML = ICON_PLAY; els.play.setAttribute("aria-label", "Play"); }
  }
  function applySpeedLabel() {
    var s = speedObj();
    els.speed.textContent = s.label;
    els.speed.setAttribute("aria-label", s.aria);
  }
  function setSpeed(i) { S.speedIdx = clamp(i, 0, SIM.speeds.length - 1); applySpeedLabel(); }
  function cycleSpeed() { setSpeed(S.speedIdx === 0 ? 1 : 0); }

  /* Play and Pause only set the intent (S.playing); a move or seek in flight always finishes and its settle ->
     decide() acts on the latest intent (r2-01). */
  function play() {
    if (!S.open) return;
    Timers.clear(X.autoT); X.autoT = 0;
    X.offlineHeld = false;
    X.resumeOnline = false;
    if (S.pending && S.pending.type === "seek") S.pending.resume = true;   // r3-07: a pending seek carries the intent
    if (S.phase === "ENDED") return replay();        // replay() and Retry end looking around themselves (r1-01)
    if (S.phase === "ERROR") { if (X.card && X.card.alt) X.card.alt(); return; }
    S.playing = true;
    setPlayIcon("pause");
    if (S.curPanoId == null) return;                 // still priming: the reveal starts playback
    if (S.userLook) {
      endLook();
      if (!Lock.busy && !X.midMove && !S.cam.anim && S.phase === "PAUSED") {
        X.zoomDirty = false;
        zoomSet(S.zoom);
        var from = povHeading(), T = camTarget(S.cur).T;
        /* fl: a step or seek posted during this ease (interrupt -> camFinish) must not start a move here;
           post() decides for it (r1-08) */
        camTo(from, angDiff(T, from), S.reduced ? 0 : SIM.lookBackMs, fl(function () { if (S.phase === "PAUSED") decide(); }));
        return;
      }
    }
    if (S.phase === "PAUSED") decide();
  }
  /* §11.7: playback resumes, so the camera is the Player's again: clears the looking-around state and lets the
     next go (or a cut's dim) restore the zoom. Play, Replay, Retry and resuming seeks all pass through here. */
  function endLook() {
    if (!S.userLook) return;
    S.userLook = false;
    chipClear("Paused — looking around");
    X.zoomDirty = true;
  }
  function pause() {
    Timers.clear(X.autoT); X.autoT = 0;
    X.offlineHeld = false;                           // any pause is the user's (or a hidden tab's): no auto-resume
    X.resumeOnline = false;
    /* r1-07: a playback move still waiting on the network gate has not been issued: Pause (or a hidden tab)
       cancels it. Not a seek's move (r2-01: the seek still lands, paused), and not a repair path whose first
       leg is already issued (r2-09). */
    var gated = X.gating && S.playing && !Lock.busy && !X.midMove && !X.seekCtx;
    var seekWait = S.phase === "WAIT_CHAIN" && !!(S.pending && S.pending.type === "seek");   // it still lands
    S.playing = false;
    if (S.pending && S.pending.type === "seek") S.pending.resume = false;   // r3-07: ...paused, whatever stalls first
    if (S.phase !== "ENDED") setPlayIcon("play");
    if ((S.phase === "WAIT_CHAIN" && !seekWait) || S.phase === "WAIT_PLAN" || gated) {
      Timers.clear(X.chainChipT); Timers.clear(X.stallT); Timers.clear(X.waitT);
      X.chainChipT = X.stallT = X.waitT = 0;
      X.waitSince = 0;
      X.flow++;
      X.gating = false;
      if (gated || S.phase === "WAIT_PLAN") X.mvTry = null;
      chipClearWaiting();
      phase("PAUSED");
    }
  }
  function togglePlay() { if (S.playing) pause(); else play(); }

  /* Latest intent wins; it is applied only at decide(). */
  function post(p) {
    S.pending = p;
    Timers.clear(X.autoT); X.autoT = 0;
    if (p.type === "seek") {                          // r2-01: a seek's resume is the play intent from now on
      S.playing = !!p.resume;
      if (S.playing) X.resumeOnline = false;
      if (S.phase !== "ENDED" && S.phase !== "ERROR") setPlayIcon(S.playing ? "pause" : "play");
    }
    /* a move in flight (Lock, or its cut reveal / re-lookup / repair path: X.midMove, r1-02, r2-09) or priming:
       picked up at decide */
    if (!S.open || Lock.busy || X.midMove || S.curPanoId == null) return;
    interrupt();
    decide();
  }
  function interrupt() {
    X.flow++;                                          // kills a gated (not yet issued) move
    X.gating = false;
    X.mvTry = null;                                    // ...and with it that move's target and seek context
    X.seekCtx = null;
    X.runTok++;
    Timers.clear(X.stepT); Timers.clear(X.waitT); Timers.clear(X.chainChipT); Timers.clear(X.stallT);
    X.stepT = X.waitT = X.chainChipT = X.stallT = 0;
    X.waitSince = 0;
    chipClearWaiting();
    creepStop();
    camFinish();
  }
  function runPending() {
    var p = S.pending;
    S.pending = null;
    if (!p) return decide();
    if (p.type === "seek") return doSeek(p);
    if (p.type === "step") {                         // stepBy() paused when the step was posted; a Play since wins
      var j = S.cur + p.dir;
      /* r3-06: nothing to step to (the frontier, or before hop 0). Under the error or end card the step does nothing
         and the card stays live; decide() used to set PAUSED under it, so Retry only hid itself and Play re-ran end(). */
      if (j < 0 || !S.hops[j]) return onCard() ? undefined : decide();
      leaveCard();
      phase("MOVE");
      return move(j);
    }
    if (p.type === "rejoin") {
      chipClear("Tap play to rejoin the route");
      leaveCard();
      phase("MOVE");
      return cutTo(S.cur);
    }
    decide();
  }
  function doSeek(p) {
    var target = clamp(+p.s0 || 0, 0, totalM());
    log("seek", { s0: r1(target) });
    if (target > S.frontierS0 + (p.exact ? 0 : 15) && !S.walkDone) {
      S.pending = p;                                   // keep the intent until the chain gets there
      chip("Finding imagery… " + Math.round(100 * S.frontierS0 / Math.max(1, target)) + "%");
      return waitChain(true);
    }
    chipClearWaiting();
    var j = hopAtOrBefore(target), hop = S.hops[j];
    if (!hop) { if (!onCard()) phase("PAUSED"); return; }   // r3-06: the card (and its phase) stays live
    leaveCard();
    X.seekCtx = { target: target, resume: S.playing };   // S.playing stays the intent while the seek moves (r2-01)
    phase("MOVE");
    if (hop.pano === S.curPanoId) { X.moveT0 = now(); X.moveDist = 0; land(j, "same"); return settle(j); }
    move(j, { forceCut: !isLinkedNow(hop.pano) });
  }
  function seekTo(s0, resume) { post({ type: "seek", s0: s0, resume: !!resume }); }
  function replay() {
    var i;
    endLook();                                         // r1-01: looking around at the finish, then Replay
    for (i = 0; i < S.stops.length; i++) S.stops[i].fired = false;
    for (i = 0; i < S.turns.length; i++) {
      var k = S.turns[i];
      k.phase = "HIDDEN"; k.exitIssued = false; k.doneDue = false; k.exitGoT = 0; k.noticeT = 0; k.said = { approach: false, taking: false };
    }
    Timers.clear(X.doneDueT); X.doneDueT = 0;
    Timers.clear(X.hudWaitT); X.hudWaitT = 0;
    hideCard();
    S.endShown = false;
    hudHideTurn();
    seekTo(0, true);
  }

  /* ---------------- Chips, live region, dim (§12.3, §12.4, §17) ---------------- */

  function chip(text, ms) {
    els.gap.textContent = text;
    els.gap.hidden = false;
    X.chipText = text;
    X.chipGate = 0;                                    // a gate that wants to own this chip sets it after (r3-11)
    log("chip", { text: text });
    Timers.clear(X.chipT); X.chipT = 0;
    if (ms) {
      X.chipT = Timers.set(function () {
        X.chipT = 0;
        if (X.chipText === text) { els.gap.hidden = true; X.chipText = ""; }
      }, ms);
    }
  }
  function chipClear(text) {
    if (text != null && X.chipText !== text) return;
    Timers.clear(X.chipT); X.chipT = 0;
    els.gap.hidden = true;
    X.chipText = "";
  }
  function chipClearWaiting() {
    var t = X.chipText || "";
    if (t === "Finding the street ahead…" || t === "You're offline" || t === "Loading imagery…" ||
        t.indexOf("Finding imagery") === 0) chipClear(t);
  }
  /* Live region: >= 1.5 s apart, queued in order. A newer message replaces a queued one only when it is about
     the same subject (key: one turn, one stop, one gap, the end card) -- r1-17: latest-wins dropped real cues
     ("Turn around now" under "Stop 1, Grange Park"). At most SIM.sayQueueMax wait; the oldest goes first. */
  function say(text, key) {
    var q = X.sayQ, it = { text: text, key: key || "" }, i;
    for (i = 0; i < q.length; i++) if ((it.key && q[i].key === it.key) || q[i].text === text) { q[i] = it; break; }
    if (i === q.length) { q.push(it); if (q.length > SIM.sayQueueMax) q.shift(); }
    sayPump();
  }
  function sayPump() {
    if (X.sayT || !X.sayQ.length) return;
    X.sayT = Timers.set(function () {
      X.sayT = 0;
      var it = X.sayQ.shift();
      if (!it) return;
      X.lastSayT = now();
      els.live.textContent = it.text;
      log("say", { text: it.text });
      sayPump();
    }, Math.max(0, X.lastSayT + SIM.saySpacingMs - now()));
  }
  function sayDrop(prefix) {                           // a seek made these queued cues stale
    for (var i = X.sayQ.length - 1; i >= 0; i--) if (X.sayQ[i].key.indexOf(prefix) === 0) X.sayQ.splice(i, 1);
  }
  function dim(mode, text) {
    var d = els.dim;
    Timers.clear(X.dimT); X.dimT = 0;
    if (mode === "cover") {
      d.classList.remove("on"); d.classList.remove("leaving");
      d.classList.add("cover");
      els.dimText.textContent = text || "";
      d.hidden = false;
      X.dimOn = true;
      chevHide();
    } else if (mode === "on") {
      d.classList.remove("leaving"); d.classList.remove("cover");
      els.dimText.textContent = "";
      d.hidden = false;
      void d.offsetWidth;                              // start the 140 ms fade from opacity 0
      d.classList.add("on");
      X.dimOn = true;
      chevHide();
    } else {
      if (d.hidden) return;
      d.classList.add("leaving");
      d.classList.remove("on"); d.classList.remove("cover");
      X.dimOn = false;
      X.dimT = Timers.set(function () {
        X.dimT = 0;
        if (!X.dimOn) { d.hidden = true; d.classList.remove("leaving"); els.dimText.textContent = ""; }
      }, SIM.dimOutMs);
    }
    log("dim", { on: mode !== "off", mode: mode });
  }

  /* ---------------- REPAIR: linked paths across unlinked hops (§10) ---------------- */

  function queueRepair(i) { X.repairQ.push(i); pumpRepair(); }
  function pumpRepair() {
    while (X.repairRunning < SIM.repairConcurrency && X.repairQ.length) {
      var i = X.repairQ.shift();
      X.repairRunning++;
      repairPlan(i, ep(function () { X.repairRunning--; pumpRepair(); }));
    }
  }
  function hasLink(meta, id) {
    if (!meta) return false;
    for (var k = 0; k < meta.links.length; k++) if (meta.links[k].pano === id) return true;
    return false;
  }
  function linkedByMeta(a, b) { return hasLink(Svc.peek(a), b); }
  function repairPlan(i, done) {
    var A = S.hops[i - 1], C = S.hops[i];
    var plan = S.plan[i] = { via: undefined };
    if (!A || !C || !S.R) { plan.via = null; return done(); }
    if (linkedByMeta(A.pano, C.pano)) { plan.via = []; return done(); }
    if (C.jump && C.gapM > SIM.repairJumpMaxM) { plan.via = null; return done(); }   // a real gap: masked cut
    plan.via = "pending";
    var limit = Math.min(SIM.repairMaxM, SIM.repairDetour * distLL(A, C) + SIM.repairSlackM), lookups = 0;
    var open = [{ id: A.pano, path: [], len: 0, ll: A }], seen = {}, lo = A.s0 - 20, hi = C.s0 + 20;
    seen[A.pano] = 1;
    function finish(via) { if (S.plan[i] === plan) plan.via = via; done(); }
    function meta1(id, cb) { if (!Svc.peek(id)) lookups++; Svc.byId(id, cb); }   // network calls count
    function step() {
      if (X.budgetHit || !open.length || lookups > SIM.repairMaxLookups) return finish(null);
      var bi = 0, q;
      for (q = 1; q < open.length; q++) {
        if (open[q].len + distLL(open[q].ll, C) < open[bi].len + distLL(open[bi].ll, C)) bi = q;
      }
      var node = open.splice(bi, 1)[0];
      meta1(node.id, ep(function (meta) {
        if (!meta) return step();
        if (hasLink(meta, C.pano)) return finish(node.path);           // the path excludes A and C
        if (node.path.length >= SIM.repairMaxLegs - 1) return step();  // <= 2 ghosts = <= 3 linked legs
        var ids = [], k;
        for (k = 0; k < meta.links.length; k++) {
          var l = meta.links[k].pano;
          if (seen[l]) continue;
          seen[l] = 1;
          ids.push(l);
        }
        if (!ids.length) return step();
        var left = ids.length, got = [];
        for (k = 0; k < ids.length; k++) {
          meta1(ids[k], ep(function (m) {
            if (m) got.push(m);
            if (--left) return;
            for (var g = 0; g < got.length; g++) {
              var mm = got[g], mll = metaLL(mm), mid = mm.location.pano;
              var len2 = node.len + distLL(node.ll, mll);
              if (len2 + distLL(mll, C) > limit) continue;
              var p = S.R.fwd(mll.lat, mll.lng), pr = S.R.line0.project(p.x, p.y, lo, hi, 0);
              if (!pr || pr.d > SIM.repairGhostLatM) continue;
              if (S.byPano[mid] != null) continue;                    // never route through a chain hop
              if (X.avoid[mid]) continue;                             // nor through a detour the walker dropped
              open.push({ id: mid, path: node.path.concat([mid]), len: len2, ll: mll });
            }
            step();
          }));
        }
      }));
    }
    step();
  }

  /* ---------------- Camera model (§11.2-§11.6) ---------------- */

  /* Hop j is reached from hop j-1 by Google links: a direct link, or a repair path (plan via [] or [ids]). false
     for a masked cut; null while a jump's repair plan is still undecided. r2-05: a repaired jump is real motion,
     so mv()/mv2() and the turn pano see it. It used to read as no motion, which hid the turn at R-A k9 (crossed
     by a repaired jump) and made camTarget face the first ghost leg -- a 6.5 m overshoot into the junction. */
  function walkedTo(j) {
    var b = S.hops[j];
    if (!b || j < 1) return false;
    var p = S.plan[j], via = p ? p.via : undefined;
    if (via === null) return false;
    if (via === undefined || via === "pending") return b.jump ? null : true;
    return true;
  }
  function mv(i) {
    var a = S.hops[i], b = S.hops[i + 1];
    if (!a || !b || walkedTo(i + 1) !== true) return null;
    if (!b.jump && b.linkHeading != null && (b.how === "link" || b.how === "bridge" || b.how === "alias")) return norm360(b.linkHeading);
    return distLL(a, b) >= 6 ? brgLL(a, b) : null;
  }
  function mv2(i) {
    var a = S.hops[i], c = S.hops[i + 2];
    if (!a || !c || walkedTo(i + 1) !== true || walkedTo(i + 2) !== true) return mv(i);
    return distLL(a, c) >= 8 ? brgLL(a, c) : mv(i);
  }
  /* mv2, or at the chain tip the walker's outHeading (bearing to the next, not yet emitted, node). */
  function motion(i) {
    var m = mv2(i);
    if (m != null) return m;
    var h = S.hops[i];
    return (h && !S.hops[i + 1] && h.outHeading != null) ? norm360(h.outHeading) : null;
  }
  function chord(i) { var s = S.hops[i].s; return S.R.chordBearing(s, s + SIM.chordAheadM); }
  function firstHopWithS(s) {
    var H = S.hops, lo = 0, hi = H.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (H[mid].s < s) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /* r3-01: the bearing between the hop positions of the move i -> i+1, which is what its transition visibly moves
     along; null for a move not walked by links or shorter than SIM.turnPosMinM (pano positions jitter ~1 m). */
  function pmv(i) {
    var a = S.hops[i], b = S.hops[i + 1];
    if (!a || !b || walkedTo(i + 1) !== true || distLL(a, b) < SIM.turnPosMinM) return null;
    return brgLL(a, b);
  }
  /* r3-04: a hop belongs to the turn nearest to it along the route (a tie goes to the earlier turn), so turns closer
     than 2 x SIM.turnWindowM never share one turn pano (R-A k1/k2 both took hop 33: k2 went straight to TAKING at
     k1's DONE and got no camera turn of its own). */
  function ownsHop(k, s) {
    var t = S.turns.indexOf(k), d = Math.abs(s - k.s), p = S.turns[t - 1], q = S.turns[t + 1];
    return !(p && Math.abs(s - p.s) <= d) && !(q && Math.abs(s - q.s) < d);
  }
  /* §11.3: the first hop within 25 m of the turn where the realised motion bends >= 35 deg (memoized). r3-01 (adds to
     §11.3): Google's link heading is off the real bearing to the linked pano by > 15 deg for 9% of links (walker
     report), and at R-A k6/k8 it "bent" one hop before the hops did (hop 73: link 269 -> 319, positions 285 -> 298),
     so the turn sequence ran a hop early and the real swing came a hop later as a plain chord steer. Where both
     neighbouring moves are long enough to have a reliable position bearing, the positions must bend too. */
  function turnPanoOf(k) {
    if (k.turnPano !== undefined) return k.turnPano;
    var H = S.hops, n = H.length;
    if (!n) return undefined;
    for (var i = Math.max(1, firstHopWithS(k.s - SIM.turnWindowM)); i < n && H[i].s <= k.s + SIM.turnWindowM; i++) {
      if (!ownsHop(k, H[i].s)) continue;                                        // another turn's hop (r3-04)
      if (walkedTo(i) === null || walkedTo(i + 1) === null) return undefined;   // a repair plan is still pending
      var a = mv(i - 1), b = mv(i);
      if (a == null || b == null || Math.abs(angDiff(b, a)) < SIM.turnPanoDeg) continue;
      var pa = pmv(i - 1), pb = pmv(i);
      if (pa != null && pb != null && Math.abs(angDiff(pb, pa)) < SIM.turnPanoPosDeg) continue;   // r3-01
      k.turnPano = i;
      return i;
    }
    if (!S.walkDone && !(n >= 2 && H[n - 2].s > k.s + SIM.turnWindowM)) return undefined;   // not decidable yet
    var c = cutCornerOf(k);
    if (c === undefined) return undefined;
    k.turnPano = c;
    return c;
  }
  /* Final fixer: a turn crossed by a masked cut has no bending link to be its turn pano (R-A k4 once the walker dropped
     the garage ramp: the plaza is reached by a cut), so its camera turned under the dim and "Now" was up ~200 ms before
     the screen dimmed. The last hop at or before the turn point is its turn pano when the cut leaving it crosses the
     turn within SIM.turnWindowM of it: the turn sequence (hold, swing, hold) runs there, in plain view under "Now",
     and the cut follows. -1 when there is no such corner, undefined while the cut's repair plan is pending. */
  function cutCornerOf(k) {
    var H = S.hops, i = firstHopWithS(k.s + 0.01) - 1;
    if (i < 1 || !H[i + 1] || k.s - H[i].s > SIM.turnWindowM || !ownsHop(k, H[i].s)) return -1;
    var w = walkedTo(i + 1);
    return w === false ? i : (w === null ? undefined : -1);
  }
  /* §11.4's "next turn with k.s > hops[i].s - 6". r2-04: the turn pano can be up to SIM.turnWindowM past k.s (R-C
     k1: 15.1 m), and dropping the turn 6 m past k.s left the hops before its turn pano on chord+clamp (a 65 deg
     sideways slide) and the turn pano itself without its turn sequence. A turn stays current until its turn pano
     is passed. */
  function nextTurn(h) {
    for (var t = 0; t < S.turns.length; t++) {
      var k = S.turns[t];
      if (k.phase === "DONE") continue;
      if (k.s > h.s - 6 || turnAhead(k, h.i)) return k;
    }
    return null;
  }
  function turnNear(s, w) {
    for (var t = 0; t < S.turns.length; t++) if (Math.abs(S.turns[t].s - s) <= w) return true;
    return false;
  }
  /* r1-04 (deviates from §11.4, which aims at k.exitBrg whenever mv2 agrees within 35 deg): the camera at the
     turn pano faces the exit move itself. At R-A k6 the exit link cut the corner at 299-303 deg while the camera
     faced the exit street (342), and the 560 ms transition slid 43 deg sideways. The route's exit bearing is kept
     when the move runs within SIM.exitLegDeg of it. r2-10: the move is trusted only up to SIM.exitAimMaxDeg off
     the exit street (a detour's sideways step no longer aims the turn 90 deg off), and for a repair path it is
     the path's net bearing, not its first leg (r2-05). */
  function turnT(i, k) {
    var w = walkBrg(i);
    if (w != null) {
      var off = Math.abs(angDiff(w, k.exitBrg));
      if (off <= SIM.exitLegDeg) return k.exitBrg;
      if (off <= SIM.exitAimMaxDeg) return w;
    }
    /* A corner crossed by a masked cut (cutCornerOf) faces where the cut reveals -- the route chord at the hop after
       it -- when that is within SIM.exitAimMaxDeg of the exit street: the swing happens here, once, and DONE comes with
       it (facesExit takes the aim within SIM.doneAimDeg). R-B k2/k3 (Bay St, then Queen St W 11.5 m on): the reveal
       faced k3's exit, 18 deg past k2's, so k2 stayed "Now" until the 25 m fallback and k3 got a 564 ms "Now". */
    if (walkedTo(i + 1) === false && S.hops[i + 1]) {
      var c = chord(i + 1);
      if (Math.abs(angDiff(c, k.exitBrg)) <= SIM.exitAimMaxDeg) return c;
    }
    var m2 = mv2(i);                                   // a plan not known yet, or an odd exit move
    if (m2 != null && Math.abs(angDiff(m2, k.exitBrg)) <= SIM.exitOkDeg) return k.exitBrg;
    return m2 != null ? m2 : k.exitBrg;
  }
  /* The turn pano's aim: turnT, the first-leg bound, and never more than SIM.turnAgainstDeg the wrong way. r3-15: an
     aim within SIM.exitAimMaxDeg of the exit street is never "the wrong way": the signed in -> aim angle wraps for a
     sharp turn whose exit move passes 180 deg (sharp-left 145, exit move at in+175: the clamp aimed 155 deg off it). */
  function turnAim(i, k) {
    var sa = stagedAims(i, k);
    if (sa) return sa[0];
    var T = legBound(i, norm360(turnT(i, k)), walkBrg(i));
    if (!isUturn(k) && Math.abs(angDiff(T, k.exitBrg)) > SIM.exitAimMaxDeg) {
      var rel = angDiff(T, k.inBrg);
      if (rel * k.netDeg < 0 && Math.abs(rel) > SIM.turnAgainstDeg) T = norm360(k.inBrg - SIM.turnAgainstDeg * sgn(k.netDeg));
    }
    return T;
  }
  /* F5/F6 (final fixer; deviates from §10's heading held across ghost legs). A turn whose exit is a repair path turns
     in stages along it, as a walker crosses a junction: before each leg the camera faces that leg -- but only ever
     further into the turn (never back against it: r2-05's swing-back), and at most SIM.stageOverDeg past the exit
     street; a leg that bends the other way first (into the junction) is walked facing where the camera already looks.
     The turn pano used to swing to the path's net bearing and hold it over every leg: R-C k1 swung 71 -> 110 for a
     145 exit and then slid 59 deg left and 54 deg right across the junction, finishing the swing after DONE; R-A k9
     and R-C k0 slid 71 and 60 deg sideways. Returns the heading to face before each leg of the move i -> i+1 (index
     = leg), or null: not a repair path, a U-turn or a sharp turn (whose legs wrap), or positions not cached. */
  function stagedAims(i, k) {
    var via = walkLegs(i), a = S.hops[i], b = S.hops[i + 1], pts = [a], q, r;
    if (!via || !via.length || !a || !b || isUturn(k) || Math.abs(k.netDeg) >= 120) return null;
    for (q = 0; q < via.length; q++) { var ll = panoLL(via[q]); if (!ll) return null; pts.push(ll); }
    pts.push(b);
    var sg = k.netDeg < 0 ? -1 : 1, hi = Math.abs(k.netDeg) + SIM.stageOverDeg, lo = 0, aims = [];
    for (q = 0; q < pts.length - 1; q++) {
      var bq = null, x = lo;
      for (r = q + 1; r < pts.length; r++) if (distLL(pts[q], pts[r]) >= SIM.legMinM) { bq = brgLL(pts[q], pts[r]); break; }
      if (bq != null) {
        var rel = sg * angDiff(bq, k.inBrg);
        x = clamp(rel, lo, hi);
        /* the first leg, before the turn starts: a long one is not entered more than the motion clamp sideways; the
           camera may lean toward it, at most SIM.turnAgainstDeg against the turn */
        if (q === 0 && rel < x - SIM.motionClampDeg && distLL(pts[0], pts[1]) >= SIM.legLongM) {
          x = Math.max(rel + SIM.motionClampDeg, -SIM.turnAgainstDeg);
        }
      }
      if (q === 0) {                                   // and never facing more than 80 deg off where the chain goes
        var m2 = mv2(i), r2 = m2 == null ? null : sg * angDiff(m2, k.inBrg);
        if (r2 != null && r2 - x > 80) x = Math.min(hi, r2 - 80);
      }
      aims.push(norm360(k.inBrg + sg * x));
      lo = x;
    }
    return aims;
  }
  /* The legs of the move i -> i+1 as move() will walk them: [] for a direct link, the repair path's ghost panos,
     or null for a masked cut or a plan not decided yet. From cached metadata, valid before the Player is on i. */
  function walkLegs(i) {
    var a = S.hops[i], b = S.hops[i + 1];
    if (!a || !b) return null;
    if (linkedByMeta(a.pano, b.pano)) return [];
    var p = S.plan[i + 1], via = p ? p.via : undefined;
    return (via && via !== "pending") ? via : null;
  }
  /* The first transition of that move that visibly moves (>= SIM.legMinM; an alias leg is skipped): {brg, len}. */
  function firstLeg(i) {
    var legs = walkLegs(i), from = S.hops[i], b = S.hops[i + 1];
    if (!legs) return null;
    for (var q = 0; q <= legs.length; q++) {
      var ll = q < legs.length ? panoLL(legs[q]) : b;
      if (!ll) return null;
      var d = distLL(from, ll);
      if (d >= SIM.legMinM) return { brg: brgLL(from, ll), len: d };
      from = ll;
    }
    return null;
  }
  /* The net bearing of that move (hop i -> hop i+1) when it is walked by links; null for a cut or no motion. */
  function walkBrg(i) {
    var a = S.hops[i], b = S.hops[i + 1];
    if (!walkLegs(i) || distLL(a, b) < SIM.legMinM) return null;
    return brgLL(a, b);
  }
  /* r2-05: a move whose first visible leg is long (>= SIM.legLongM) is never entered more than SIM.legSideDeg
     sideways -- unless that would turn the camera more than the motion clamp away from where the move goes (a
     zigzag path), where the steadier heading wins. */
  function legBound(i, T, ref) {
    var fl = firstLeg(i);
    if (!fl || fl.len < SIM.legLongM) return T;
    var d = angDiff(T, fl.brg);
    if (Math.abs(d) <= SIM.legSideDeg) return T;
    var T2 = norm360(fl.brg + SIM.legSideDeg * sgn(d));
    if (ref != null && Math.abs(angDiff(T2, ref)) > SIM.motionClampDeg + 0.5) return T;
    return T2;
  }
  function diverged(i) {                               // the chain has visibly left the route: follow the imagery
    if (i < 1) return false;
    for (var q = i - 1; q <= i; q++) {
      var m = mv2(q);
      if (m == null || Math.abs(angDiff(chord(q), m)) <= SIM.divergeDeg || turnNear(S.hops[q].s, SIM.turnWindowM)) return false;
    }
    return true;
  }
  /* §11.4: where the camera must face BEFORE the move i -> i+1 is issued. */
  function camTarget(i) {
    var h = S.hops[i];
    if (!h || !S.R) return { T: povHeading(), kind: "none" };
    var k = nextTurn(h), tp = k ? turnPanoOf(k) : undefined;
    if (k && tp === i) {
      var sa = stagedAims(i, k), Ta = sa ? sa[0] : turnAim(i, k);
      k.aimT = Ta;                                     // r2-10: DONE also accepts this aim (r3-01: only near the street)
      k.stage = sa ? { j: i + 1, aims: sa } : null;    // the rest of a staged turn, steered by legTurn
      return { T: Ta, kind: "turn", uturn: isUturn(k), k: k };
    }
    var useIn = !!k && h.s >= k.s - 26 && (tp === undefined || (tp >= 0 && i < tp));   // don't peek early
    var base = useIn ? k.inBrg : chord(i), T = base, kind = useIn ? "in" : "chord";
    if (k && tp != null && tp === i + 1) {
      var dd = angDiff(turnAim(i + 1, k), base);
      if (Math.abs(dd) > 150) dd = Math.abs(dd) * (k.netDeg < 0 ? -1 : 1);   // a U-turn pre-rotates its own way
      if (Math.abs(dd) >= SIM.preTurnMinDeg) { T = base + SIM.preTurnFrac * dd; kind = "preturn"; }
    }
    if (diverged(i)) { var f = mv2(i); if (f != null) { T = f; kind = "follow"; } }
    var m2 = motion(i);                                // a repaired jump counts as motion now (r2-05)
    /* r3-16 (deviates from §11.4 line 795, which clamps to mv2): on the hop before the turn pano mv2 runs through the
       corner, so clamping to it overrode D8's 25% pre-turn while this move still runs along the incoming street
       (sharp-left 135: 68 deg off the move; a retrace U-turn: 135 deg off). Clamp to this move itself there. */
    if (k && tp != null && tp === i + 1) { var m1 = mv(i); if (m1 != null) m2 = m1; }
    if (m2 != null && Math.abs(angDiff(T, m2)) > SIM.motionClampDeg) {   // never face sideways to the motion
      T = m2 + SIM.motionClampDeg * sgn(angDiff(T, m2));
      kind += "+clamp";
    }
    var Tl = legBound(i, norm360(T), m2);              // r2-05: nor enter a long first leg more than 60 deg sideways
    if (Math.abs(angDiff(Tl, T)) > 0.05) { T = Tl; kind += "+leg"; }
    return { T: norm360(T), kind: kind };
  }
  /* §11.6: vertical field of view <= 90 deg on portrait stages, otherwise zoom 1. */
  function zoomFor(W, H) {
    if (!(W > 0) || !(H > 0) || W >= H) return 1;
    var hfov = 2 * Math.atan(W / H) * 180 / Math.PI;
    return clamp(round2(Math.log(180 / hfov) / Math.LN2), SIM.zoomMin, SIM.zoomMax);
  }
  function zoomForStage() {
    var r = els.stage.getBoundingClientRect();
    return zoomFor(r.width, r.height);
  }

  /* ---------------- HUD: turn phases (§12.1) ---------------- */

  function kindPhrase(k) { return KIND_PHRASE[k.kind] || "Continue"; }
  function turnText(k) { return k.kind === "uturn" ? "Turn around" : (k.instr || kindPhrase(k)); }
  function arrowClass(kind) { return (!kind || kind === "straight") ? "" : "m-" + kind; }
  /* §12.1 v over the last 6 lands. r2-07: the MEDIAN of the per-hop speeds, so the holds and the swing of the turn
     just taken (one or two slow intervals) no longer read as a slow approach to the next one (R-A k6: 14.2 m/s
     against ~17 moving put APPROACH 2381 ms before the exit). Backward steps and seeks are not travel. */
  function measuredV() {
    var n = S.landT.length, def = S.speedIdx === 0 ? 9 : 18, v = [];
    for (var i = Math.max(1, n - 6); i < n; i++) {
      var dt = S.landT[i] - S.landT[i - 1], ds = S.landS0[i] - S.landS0[i - 1];
      if (dt > 0 && ds > 0) v.push(1000 * ds / dt);
    }
    if (v.length < 2) return def;
    v.sort(num);
    return clamp(v[v.length >> 1], 5, 25);
  }
  /* r2-04: a turn whose turn pano (up to SIM.turnWindowM past k.s) is still ahead of hop i is not over yet. */
  function turnAhead(k, i) { var tp = turnPanoOf(k); return tp != null && tp >= 0 && i <= tp; }
  /* One timer completes a deferred DONE (hudPovCheck): the "Now" floor, SIM.takingMinMs. */
  function armDoneDue(wait) {
    if (X.doneDueT) return;
    X.doneDueT = Timers.set(function () { X.doneDueT = 0; hudPovCheck(povHeading()); }, Math.max(0, wait) + 1);
  }
  /* Ruling R3: the second of two turns at most SIM.foldM apart may skip its own approach card. It does when its "Now"
     is due at the very next land: the card before it (its approach card, or the first turn's "On {street}") would be
     up for one link transition, ~560 ms at either speed (R-A k2's "In 20 m" between k1's DONE and its own "Now": 578
     ms; at 0.5x the "On {street}" card it replaced: 561 ms), under the R4 floor. */
  function foldTaking(k, tp) {
    var kp = S.turns[S.turns.indexOf(k) - 1], n = S.hops[S.cur + 1];
    if (!kp || kp.phase !== "DONE" || k.s0 - kp.s0 > SIM.foldM || !n) return false;
    return n.s0 >= k.s0 - SIM.nowM || (tp != null && tp >= 0 && S.cur + 1 >= tp);
  }
  function hudUpdate() {
    var cur = S.hops[S.cur];
    if (!cur || !S.turns.length) return;
    var k = null;
    for (var i = 0; i < S.turns.length; i++) {
      var t = S.turns[i];
      if (t.phase === "DONE") continue;
      if (cur.s0 > t.s0 + SIM.doneFallbackM && !turnAhead(t, S.cur)) {
        /* R4 (final fixer): the 25 m fallback -- a masked cut or a long link landing past the turn -- honours the
           "Now" floor exactly as the camera's DONE does (hudPovCheck). It used to take "Now" down at once: R-A k4
           564-780 ms (the cut into the plaza), R-B k3 564 ms. */
        if (t.phase === "TAKING" && now() - (t.takingT || 0) < SIM.takingMinMs) {
          if (!t.exitIssued) { t.exitIssued = true; if (!t.exitGoT) t.exitGoT = now(); }
          t.doneDue = true;
          armDoneDue(SIM.takingMinMs - (now() - (t.takingT || 0)));
          k = t;
          break;
        }
        turnDone(t, true);
        continue;
      }
      k = t;
      break;
    }
    if (!k) { if (!X.doneShowing) hudHideTurn(); beaconHide(); chevOff(); return; }
    var d = k.s0 - cur.s0, v = measuredV();
    var noticeM = clamp(SIM.noticeSec * v, SIM.noticeMinM, SIM.noticeMaxM);
    var approachM = clamp(SIM.approachSec * v, SIM.approachMinM, SIM.approachMaxM);
    var tp = turnPanoOf(k), want;
    /* r2-07: the cues are timed to where the camera actually turns. When the turn pano comes before the turn
       point (R-A k6: 15.6 m), NOTICE and APPROACH count down to it; the card still shows the distance to the turn. */
    var dA = (tp != null && tp >= 0 && S.hops[tp]) ? Math.min(d, S.hops[tp].s0 - cur.s0) : d;
    if (d <= SIM.nowM || (tp != null && tp >= 0 && S.cur >= tp)) want = "TAKING";
    else if (dA <= approachM) want = (k.phase !== "APPROACH" && foldTaking(k, tp)) ? "TAKING" : "APPROACH";
    else if (dA <= noticeM) want = "NOTICE";
    else want = "HIDDEN";
    if (PH[want] < PH[k.phase]) want = k.phase;      // phases only advance during play
    setTurnPhase(k, want, d, approachM, dA);
  }
  /* Re-runs the HUD once a card's R4 floor is reached. */
  function hudWait(ms) {
    Timers.clear(X.hudWaitT);
    X.hudWaitT = Timers.set(function () { X.hudWaitT = 0; if (S.phase !== "ERROR") hudUpdate(); }, Math.max(0, ms) + 1);
  }
  function setTurnPhase(k, ph, d, approachM, dA) {
    /* R4 (final fixer): an approach card never replaces a card that has been up less than SIM.cardMinMs -- an "On
       {street}" card (R-A at 0.5x: after 37 ms, while the cut's dim was lifting) or this turn's own notice card when it
       came late, after waiting out a DONE card (R-B k8: 321 ms). It waits, as NOTICE waits for the whole DONE card
       below. "Now" never waits. */
    var upT = X.doneShowing ? X.doneShowT : (k.phase === "NOTICE" ? k.noticeT : 0);
    if (ph === "APPROACH" && k.phase !== "APPROACH" && upT && now() - upT < SIM.cardMinMs) {
      hudWait(SIM.cardMinMs - (now() - upT));
      return;
    }
    if (k.phase !== ph) {
      if (ph === "TAKING") k.takingT = now();          // r3-05: the "Now" card's minimum display counts from here
      k.phase = ph;
      log("hud", { k: k.k, phase: ph });
    }
    S.hud.k = k.k;
    S.hud.phase = ph;
    if (ph === "HIDDEN") { if (!X.doneShowing) hudHideTurn(); beaconHide(); chevOff(); return; }
    beaconFor(k);
    if (ph === "NOTICE" && X.doneShowing) { chevOff(); return; }   // let "On {street}" finish first
    endDoneShow();
    var card = els.turn, dd = Math.max(0, d);
    if (ph === "NOTICE") {
      if (!k.noticeT) k.noticeT = now();               // when the notice card itself first shows (R4 floor above)
      card.className = "sv-turn notice";
      els.turnDist.textContent = kindPhrase(k) + " in " + shortDist(dd);
      els.turnInstr.textContent = "";
      els.turnThen.hidden = true;
      chevOff();
    } else if (ph === "APPROACH") {
      card.className = "sv-turn";
      els.turnDist.textContent = shortDist(dd);
      els.turnInstr.textContent = turnText(k);
      thenLine(k);
      var f = clamp((Math.max(0, dA != null ? dA : d) - SIM.nowM) / Math.max(1, approachM - SIM.nowM), 0, 1);
      chevShow(k, "approach", k.inBrg, SIM.chevApproachMin + (1 - SIM.chevApproachMin) * (1 - f));
      if (!k.said.approach) { k.said.approach = true; say("In " + sayDist(dd) + ", " + lcFirst(turnText(k)), "turn:" + k.k); }
    } else if (ph === "TAKING") {
      card.className = "sv-turn now";
      els.turnDist.textContent = "Now";
      els.turnInstr.textContent = turnText(k);
      thenLine(k);
      chevShow(k, "taking", k.exitBrg, 1);
      if (!k.said.taking) { k.said.taking = true; say(kindPhrase(k) + " now", "turn:" + k.k); }
    }
    var ac = arrowClass(k.kind);
    els.turnArrow.className = "sv-turn-arrow" + (ac ? " " + ac : "");
    card.hidden = false;
  }
  function thenLine(k) {
    var idx = S.turns.indexOf(k), k2 = S.turns[idx + 1];
    if (k2 && k2.s0 - k.s0 <= SIM.thenWithinM) {
      els.turnThen.textContent = "then " + lcFirst(kindPhrase(k2));
      els.turnThen.hidden = false;
    } else {
      els.turnThen.textContent = "";
      els.turnThen.hidden = true;
    }
  }
  /* DONE: "On {street}" for 1.2 s, then a 200 ms fade (or hide at once without a street). Final fixer: T4 (DONE clears
     <= 3 s after the exit go) together with R4 (no card under SIM.cardMinMs): the card is cut short to clear by the
     exit go (refT, else the turn's own) + SIM.doneClearMs, and left out when that leaves it less than SIM.cardMinMs --
     a turn completed late along a long repair path (R-A k9, ~2 s after its exit go), whose "Now" card named the street
     all along. */
  function turnDone(k, show, refT) {
    if (k.phase === "DONE") return;
    k.phase = "DONE";
    k.doneT = now();
    log("hud", { k: k.k, phase: "DONE" });
    beaconHide();
    chevFade();
    var fade = S.reduced ? 0 : 200, hold = SIM.doneShowMs, ref = refT || k.exitGoT || 0;
    if (ref) hold = Math.min(hold, Math.round(ref + SIM.doneClearMs - fade - now()));
    if (show && k.street && hold >= SIM.cardMinMs) {
      els.turn.className = "sv-turn notice";
      els.turnArrow.className = "sv-turn-arrow";
      els.turnDist.textContent = "On " + k.street;
      els.turnInstr.textContent = "";
      els.turnThen.hidden = true;
      els.turn.hidden = false;
      X.doneShowing = true;
      X.doneShowT = now();
      Timers.clear(X.turnFadeT);
      X.turnFadeT = Timers.set(function () {
        els.turn.classList.add("fading");
        X.turnFadeT = Timers.set(function () {
          X.turnFadeT = 0;
          X.doneShowing = false;
          hudHideTurn();
          hudUpdate();
        }, fade);
      }, hold);
    } else if (!X.doneShowing) {
      hudHideTurn();
    }
  }
  function endDoneShow() {
    if (!X.doneShowing) return;
    Timers.clear(X.turnFadeT);
    X.turnFadeT = 0;
    X.doneShowing = false;
  }
  /* A move toward hop toIdx was issued from hop fromIdx: a turn's exit is issued once a move leaves its turn pano
     (or a later hop), or, for a turn with no turn pano, once a move crosses its turn point. r3-05: every turn not
     DONE is marked, not only the TAKING one, so a turn a few metres after it whose exit the same move took can
     complete with it (hudPovCheck). DONE once the camera faces the exit street (§12.1). */
  function markExitIssued(fromIdx, toIdx) {
    var to = S.hops[toIdx];
    for (var t = 0; t < S.turns.length; t++) {
      var k = S.turns[t];
      if (k.phase === "DONE" || k.exitIssued) continue;
      var tp = turnPanoOf(k);
      if (tp != null && tp >= 0) { if (fromIdx >= tp) k.exitIssued = true; }
      else if (to && to.s0 > k.s0) k.exitIssued = true;
      if (k.exitIssued) k.exitGoT = now();             // T4's clock: "On {street}" clears by this + doneClearMs
    }
    hudPovCheck(povHeading());
  }
  /* The camera faces the turn's exit: the exit street, or the aim the turn pano steered to (r2-10: r1-04 aims at the
     exit move itself, up to SIM.exitAimMaxDeg off the street). r3-01: that aim counts only when it is within
     SIM.doneAimDeg of the street. Otherwise DONE (R-A k6/k8/k9: aims 43/58/37 deg off) took the TAKING arrow and the
     "Now" card down while the camera still had that far to turn, and the real swing ran a hop later with no cue
     (under the next turn's card at k6). The turn now stays TAKING until the camera faces the exit street (the next
     hop's steer) or SIM.doneFallbackM has passed. */
  function facesExit(k, h) {
    if (Math.abs(angDiff(h, k.exitBrg)) < SIM.doneDeg) return true;
    return k.aimT != null && Math.abs(angDiff(k.aimT, k.exitBrg)) <= SIM.doneAimDeg && Math.abs(angDiff(h, k.aimT)) < SIM.doneDeg;
  }
  /* Mid-steer (final fixer), a turn completes only near the end of a steer that itself ends facing the exit: a staged
     steer may run SIM.stageOverDeg past the street and used to complete the turn on its way through, with ~25 deg of
     the swing still to come. A steer that ends anywhere else is judged where the camera is, as before. */
  function facesNow(k, h) {
    var a = S.cam.anim;
    if (a && facesExit(k, a.to)) return Math.abs(angDiff(a.to, h)) < SIM.doneDeg;
    return facesExit(k, h);
  }
  /* DONE once the exit is issued and the camera faces the exit. Turns complete in order: the TAKING turn first, then
     (r3-05) any later turn whose exit was already issued and which the camera already faces completes with it, and
     only the last of them shows "On {street}". R-A k3 (7.6-11.5 m after k2, no turn pano) used to go TAKING at k2's
     DONE and DONE at the next go: a 200 ms "Now" flash. A "Now" card also stays up SIM.takingMinMs at least. */
  function hudPovCheck(h) {
    var first = null, done = [], t, k;
    if (S.phase === "ERROR") return;                   // r2-15: no turn card under the error card; Retry re-checks
    for (t = 0; t < S.turns.length; t++) {
      k = S.turns[t];
      if (k.phase === "DONE") continue;
      if (!first) {
        if (k.phase !== "TAKING" || !k.exitIssued || !(k.doneDue || facesNow(k, h))) return;
        first = k;
      } else if (!k.exitIssued || !facesNow(k, h) || k.s0 - done[done.length - 1].s0 > SIM.thenWithinM) {
        break;                                         // only a turn the card's then-line announced is folded in
      }
      done.push(k);
    }
    if (!first) return;
    var wait = SIM.takingMinMs - (now() - (first.takingT || 0));
    if (wait > 0) {                                    // r3-05: never a "Now" flash; the camera already faces the exit
      first.doneDue = true;
      armDoneDue(wait);
      return;
    }
    var last = done[done.length - 1], ref = 0;         // the street we are on now is the last turn's
    for (t = 0; t < done.length; t++) if (done[t].exitGoT && (!ref || done[t].exitGoT < ref)) ref = done[t].exitGoT;
    for (t = 0; t < done.length - 1; t++) turnDone(done[t], false);
    turnDone(last, true, ref);
    hudUpdate();
  }
  function hudRebuild(hop) {                           // after seeks and backward steps
    for (var t = 0; t < S.turns.length; t++) {
      var k = S.turns[t];
      k.exitIssued = false; k.doneDue = false; k.exitGoT = 0; k.noticeT = 0;
      k.phase = (hop.s0 > k.s0 + SIM.doneFallbackM && !turnAhead(k, hop.i)) ? "DONE" : "HIDDEN";
    }
    Timers.clear(X.doneDueT); X.doneDueT = 0;
    Timers.clear(X.hudWaitT); X.hudWaitT = 0;
    endDoneShow();
    hudHideTurn();
    beaconHide();
    chevHide();
    sayDrop("turn:");                                  // queued turn cues are stale after a seek
  }
  function hudHideTurn() {
    els.turn.hidden = true;
    els.turn.className = "sv-turn";
    S.hud.phase = "HIDDEN";
  }
  function hudResetDom() {
    hudHideTurn();
    els.turnDist.textContent = "";
    els.turnInstr.textContent = "";
    els.turnThen.hidden = true;
    els.gap.hidden = true;
    els.gap.textContent = "";
    els.stopCard.hidden = true;
    hideCard();
    chevHide();
    els.dim.hidden = true;
    els.dim.className = "sv-dim";
  }
  function hudHideAll() {
    hudResetDom();
    if (S.mapObjs.beacon) { try { S.mapObjs.beacon.setVisible(false); } catch (e) { /* ignore */ } }
    X.beaconOn = false;
  }

  /* ---------------- Ground arrow (§12.1): world-locked through --sv-rel ---------------- */

  function fmtP(p) { return (Math.round(p.x * 100) / 100) + " " + (Math.round(p.y * 100) / 100); }
  /* Arrow r1 (prominence): the shaft is a 20-unit white stroke in a 30-unit brand outline (sim.css), so the
     heads are wider (52 / 44 / 40 units across) to stay clearly wider than the shaft. Everything keeps inside the
     -10..110 viewBox with its 5-unit outline; the shaft still starts on x = 50 (the transform-origin line). */
  function glyphStraight() { return { body: "M50 94 V44", head: "M50 4 L76 42 L24 42 Z" }; }
  function glyphTurn(k) {
    if (k.kind === "uturn") {
      return k.netDeg < 0
        ? { body: "M70 94 V46 A20 20 0 0 0 30 46 V60", head: "M30 92 L10 60 L50 60 Z" }
        : { body: "M30 94 V46 A20 20 0 0 1 70 46 V60", head: "M70 92 L90 60 L50 60 Z" };
    }
    var th = /sharp/.test(k.kind) ? 135 : (/slight/.test(k.kind) ? 45 : 90);
    var left = /left/.test(k.kind) || (!/right/.test(k.kind) && k.netDeg < 0);
    var t = th * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    var P2 = { x: 66 - 16 * cs, y: 64 - 16 * sn }, dx = sn, dy = -cs;
    var P3 = { x: P2.x + 10 * dx, y: P2.y + 10 * dy };
    var tip = { x: P3.x + 26 * dx, y: P3.y + 26 * dy };
    var b1 = { x: P3.x + 22 * cs, y: P3.y + 22 * sn }, b2 = { x: P3.x - 22 * cs, y: P3.y - 22 * sn };
    function m(p) { return left ? { x: 100 - p.x, y: p.y } : p; }   // mirror x -> 100 - x (and the arc's sweep)
    return {
      body: "M50 94 V64 A16 16 0 0 " + (left ? 0 : 1) + " " + fmtP(m(P2)) + " L " + fmtP(m(P3)),
      head: "M" + fmtP(m(tip)) + " L" + fmtP(m(b1)) + " L" + fmtP(m(b2)) + " Z"
    };
  }
  function setGlyph(g) {
    els.chevBodyO.setAttribute("d", g.body); els.chevBody.setAttribute("d", g.body);
    els.chevHeadO.setAttribute("d", g.head); els.chevHead.setAttribute("d", g.head);
  }
  function chevShow(k, mode, worldBrg, scale) {
    var c = X.chev;
    if (c.k !== k.k || c.mode !== mode) setGlyph(mode === "approach" ? glyphTurn(k) : glyphStraight());
    Timers.clear(X.chevFadeT); X.chevFadeT = 0;
    c.k = k.k; c.mode = mode; c.worldBrg = worldBrg; c.visible = true;
    c.scale = S.reduced ? 1 : scale;
    els.chev.className = "sv-chevron" + (mode === "approach" ? " approach" : (S.reduced ? "" : " pulse"));
    els.chev.style.setProperty("--sv-chev-scale", c.scale.toFixed(3));
    chevApply(povHeading());
  }
  function chevApply(h) {
    var c = X.chev;
    if (!els || !c.visible) return;
    if (X.dimOn || S.userLook) { if (!els.chev.hidden) els.chev.hidden = true; return; }
    c.rel = angDiff(c.worldBrg, h);
    els.chev.style.setProperty("--sv-rel", c.rel.toFixed(1) + "deg");
    if (els.chev.hidden) els.chev.hidden = false;
  }
  function chevHide() {
    var c = X.chev;
    c.visible = false; c.mode = ""; c.k = -1;
    Timers.clear(X.chevFadeT); X.chevFadeT = 0;
    if (els) { els.chev.hidden = true; els.chev.className = "sv-chevron"; }
  }
  function chevFade() {
    if (!X.chev.visible) return;
    els.chev.className = "sv-chevron fading";
    X.chev.mode = "fading";
    Timers.clear(X.chevFadeT);
    X.chevFadeT = Timers.set(function () { X.chevFadeT = 0; if (X.chev.mode === "fading") chevHide(); }, S.reduced ? 0 : 400);
  }
  /* The HUD's "no arrow for this phase": a DONE arrow keeps its 400 ms fade (r1-11: every hudUpdate after
     turnDone used to hide it in the same tick). Seeks and dims still hide it at once (chevHide). */
  function chevOff() { if (X.chev.mode !== "fading") chevHide(); }

  /* ---------------- Beacon in the scene (§12.2): one page-lifetime pano Marker ---------------- */

  var BEACON_ICONS = {};
  var BEACON_ROT = { "left": -90, "right": 90, "slight-left": -45, "slight-right": 45, "sharp-left": -135, "sharp-right": 135 };
  function beaconIcon(k) {
    var key = k.kind + (k.netDeg < 0 ? "-" : "+");
    if (BEACON_ICONS[key]) return BEACON_ICONS[key];
    var glyph;
    if (k.kind === "uturn") {
      glyph = '<g transform="translate(32 30)' + (k.netDeg < 0 ? ' scale(-1 1)' : '') + ' scale(1.5) translate(-12 -12)">' +
        '<path d="M8 19V9a4 4 0 0 1 8 0v6"/><path d="m12.5 12 3.5 3.5 3.5-3.5"/></g>';
    } else {
      glyph = '<g transform="translate(32 30) rotate(' + (BEACON_ROT[k.kind] || 0) + ') scale(1.5) translate(-12 -12.5)">' +
        '<path d="M12 20V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/></g>';
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="160" viewBox="0 0 64 80">' +
      '<path d="M22 52 L42 52 L32 78 Z" fill="' + BRAND + '" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="32" cy="30" r="27" fill="' + BRAND + '" stroke="#ffffff" stroke-width="3"/>' +
      '<g fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' + glyph + '</g></svg>';
    BEACON_ICONS[key] = {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(64, 80),
      anchor: new google.maps.Point(32, 78)
    };
    return BEACON_ICONS[key];
  }
  function beaconFor(k) {
    var cur = S.hops[S.cur];
    if (!SIM.beacon || !S.pano || !cur) return beaconHide();
    var d = distLL(cur, k);
    if (d <= SIM.beaconMinM || d > SIM.beaconMaxM) return beaconHide();
    var b = S.mapObjs.beacon;
    if (!b) {
      try { b = S.mapObjs.beacon = new google.maps.Marker({ map: S.pano, clickable: false, title: "", visible: false }); }
      catch (e) { return; }
    }
    if (X.beaconK !== k.k) {
      b.setIcon(beaconIcon(k));
      placeMarker(b, { lat: k.lat, lng: k.lng });
      X.beaconK = k.k;
    }
    if (!X.beaconOn) { b.setVisible(true); X.beaconOn = true; }
  }
  function beaconHide() {
    if (X.beaconOn && S.mapObjs.beacon) { try { S.mapObjs.beacon.setVisible(false); } catch (e) { /* ignore */ } }
    X.beaconOn = false;
  }

  /* ---------------- Stops (§12.5) ---------------- */

  function stopsCheck(j) {
    var hop = S.hops[j];
    for (var i = 0; i < S.stops.length; i++) {
      var st = S.stops[i];
      if (st.fired || hop.s0 < st.s0 - SIM.stopLeadM) continue;
      st.fired = true;                                 // once per playthrough
      els.stopText.textContent = "Stop " + st.k + (st.name ? " · " + st.name : "");
      els.stopDot.style.setProperty("--sv-dot", catFill(st.cat));
      els.stopCard.hidden = false;
      Timers.clear(X.stopCardT);
      X.stopCardT = Timers.set(function () { X.stopCardT = 0; els.stopCard.hidden = true; },
        (S.speedIdx === 0 ? SIM.stopHoldSlowMs : SIM.stopHoldMs) + 3500);
      X.stopHoldFor = j;
      X.stopNow = st;
      say("Stop " + st.k + (st.name ? ", " + st.name : ""), "stop:" + st.k);
      log("stop", { k: st.k });
      return;                                          // one stop per landing
    }
  }
  function stopHoldStep(j) {
    return function (next, tok) {
      var st = X.stopNow, hop = S.hops[j], slow = S.speedIdx === 0, t0 = now();
      var base = slow ? SIM.stopHoldSlowMs : SIM.stopHoldMs, lm = slow ? 1.3 : 1;
      function finish() {
        if (!live(tok)) return;
        X.stepT = Timers.set(function () {
          Timers.clear(X.stopCardT); X.stopCardT = 0;
          els.stopCard.hidden = true;
          next();
        }, Math.max(0, base - (now() - t0)));
      }
      var tgt = st ? (st.plat != null ? { lat: st.plat, lng: st.plng } : { lat: st.lat, lng: st.lng }) : null;
      if (!tgt || S.reduced || Lock.busy) return finish();
      var from = povHeading(), dl = angDiff(brgLL(hop, tgt), from);
      if (distLL(hop, tgt) > SIM.stopLookMaxM || Math.abs(dl) <= SIM.stopLookMinDeg) return finish();
      var ms = Math.round(clamp(300 + 5 * Math.abs(dl), 350, 900) * lm);
      log("steer", { from: r1(from), to: r1(norm360(from + dl)), ms: ms, kind: "stop" });
      camTo(from, dl, ms, function () {
        if (!live(tok)) return;
        X.stepT = Timers.set(function () {
          if (!live(tok)) return;
          var f2 = povHeading(), T = camTarget(j).T;
          log("steer", { from: r1(f2), to: r1(T), ms: Math.round(600 * lm), kind: "stop-back" });
          camTo(f2, angDiff(T, f2), Math.round(600 * lm), finish);
        }, 500);
      });
    };
  }

  /* ---------------- Scrubber, Prev/Next, keys (§13) ---------------- */

  function scrubVal() { var v = parseFloat(els.scrub.value); return isNaN(v) ? 0 : v; }
  function scrubFeedback(v) {
    var total = totalM();
    els.pos.textContent = km1(v) + " of " + km1(total) + " km";
    els.scrub.setAttribute("aria-valuetext", km1(v) + " of " + km1(total) + " kilometres");
    if (!S.mobile) MapView.ghostAt(v);
  }
  function onScrubInput() {
    if (!S.open || !S.hops.length) return;
    var v = scrubVal();
    scrubFeedback(v);
    if (X.scrubPtr || X.dragging) {
      if (!X.dragging) { X.dragging = true; X.dragResume = S.playing; pause(); }
      var t = now(), since = t - X.lastDragCommit;
      if (since >= SIM.seekDragCommitMs) { X.lastDragCommit = t; seekTo(v, false); }
      else if (!X.dragT) {
        X.dragT = Timers.set(function () {
          X.dragT = 0;
          if (!X.dragging) return;
          X.lastDragCommit = now();
          seekTo(scrubVal(), false);
        }, SIM.seekDragCommitMs - since);
      }
      return;
    }
    /* Keyboard on the range: debounced commit. r3-02: the value is captured here, and lands leave the range alone while
       the commit is pending (scrubOwned), so a hop that lands inside the 250 ms no longer resets it (about 45% of
       keyboard seeks during 1x playback were lost, or went back to where the Player was). */
    X.keyV = v;
    Timers.clear(X.keyT);
    X.keyT = Timers.set(function () {
      var kv = X.keyV;
      X.keyT = 0; X.keyV = null;
      MapView.ghostAt(null);
      seekTo(kv != null ? kv : scrubVal(), S.playing);
    }, SIM.rangeKeyDebounceMs);
  }
  /* The range shows the user's own value while a pointer drag or a keyboard commit is pending (r3-02). */
  function scrubOwned() { return X.dragging || !!X.keyT; }
  function onScrubChange() { endScrubDrag(); }        // keyboard changes commit through the debounce
  /* Ends a pointer drag: commit the final value and resume if playback was running. Runs on change AND on
     pointerup/pointercancel (r1-09: Chromium fires no change when the thumb is released on its starting value,
     and a cancelled touch fires none, which left X.dragging set and the scrubber frozen). Idempotent. */
  function endScrubDrag() {
    X.scrubPtr = false;
    if (!S.open || !X.dragging) return;
    var resume = X.dragResume;
    X.dragging = false;
    Timers.clear(X.dragT); X.dragT = 0;
    MapView.ghostAt(null);
    X.lastDragCommit = now();
    seekTo(scrubVal(), resume);
  }
  function poiJump(dir) {
    var cur = S.hops[S.cur];
    if (!cur) return;
    var s = cur.s0, P = X.pois, t = null, i, pd = S.pending && S.pending.type === "seek" ? S.pending : null;
    /* r2-01: a second press goes on from the seek already asked for (a double Next skipped once, then stopped) */
    if (pd) s = clamp(+pd.s0 || 0, 0, totalM());
    else if (X.seekCtx) s = X.seekCtx.target;
    if (dir > 0) {
      for (i = 0; i < P.length; i++) if (P[i] - SIM.poiLeadM > s + SIM.poiMinGapM) { t = P[i] - SIM.poiLeadM; break; }
      if (t == null) t = Math.min(s + SIM.poiSkipM, totalM());
    } else {
      for (i = P.length - 1; i >= 0; i--) if (P[i] - SIM.poiLeadM < s - SIM.poiMinGapM) { t = Math.max(0, P[i] - SIM.poiLeadM); break; }
      if (t == null) t = Math.max(0, s - SIM.poiSkipM);
    }
    seekTo(t, S.playing);
  }
  function stepBy(dir) { pause(); post({ type: "step", dir: dir }); }
  function onKey(e) {
    if (!S.open || !els) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tg = e.target, inOv = !!(tg && tg.nodeType === 1 && els.overlay.contains(tg));
    if (!inOv && tg !== document.body && tg !== document.documentElement) return;
    var key = e.key, onScrub = tg === els.scrub, onBtn = !!(tg && tg.tagName === "BUTTON"), act = null;
    if (key === "Tab") { if (S.mobile) trapTab(e); return; }
    if (key === "Escape" || key === "Esc") {
      if (document.querySelector("dialog[open]")) return;
      act = close;
    } else if (key === " " || key === "Spacebar") {
      if (onBtn) return;                               // native button activation
      act = togglePlay;
    } else if (key === "k" || key === "K") {
      act = togglePlay;
    } else if (/^(ArrowRight|ArrowLeft|ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(key)) {
      if (onScrub) { e.stopPropagation(); return; }    // the range moves natively
      if ((key === "ArrowRight" && e.shiftKey) || key === "PageDown") act = function () { poiJump(1); };
      else if ((key === "ArrowLeft" && e.shiftKey) || key === "PageUp") act = function () { poiJump(-1); };
      else if (key === "ArrowRight" || key === "ArrowUp") act = function () { stepBy(1); };
      else if (key === "ArrowLeft" || key === "ArrowDown") act = function () { stepBy(-1); };
      else if (key === "Home") act = function () { seekTo(0, S.playing); };
      else act = function () { var l = S.hops[S.hops.length - 1]; if (l) seekTo(l.s0, S.playing); };
    } else if (key === "+" || key === "=") {
      act = function () { setSpeed(S.speedIdx + 1); };
    } else if (key === "-" || key === "_") {
      act = function () { setSpeed(S.speedIdx - 1); };
    }
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();                               // keeps Google's canvas keyboard navigation out (N1)
    act();
  }
  function trapTab(e) {
    var all = els.overlay.querySelectorAll("button, input[type=range]"), list = [], i;
    for (i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.disabled || !b.getClientRects().length) continue;
      list.push(b);
    }
    if (!list.length) return;
    var idx = list.indexOf(document.activeElement), n = list.length;
    var nx = e.shiftKey ? (idx <= 0 ? n - 1 : idx - 1) : ((idx < 0 || idx >= n - 1) ? 0 : idx + 1);
    e.preventDefault();
    e.stopPropagation();
    try { list[nx].focus(); } catch (x) { /* ignore */ }
  }

  /* ---------------- Looking around (§11.7) ---------------- */

  function inCard(t) { return !!(t && t.nodeType === 1 && els.card.contains(t)); }
  function onPanoTarget(t) { return !!(t && t.nodeType === 1 && els.pano.contains(t)); }
  function onStageDown(e) {
    if (!S.open || inCard(e.target) || !onPanoTarget(e.target)) return;
    X.lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
  }
  function onStageMove(e) {
    var p = X.lookPtr;
    if (!p || p.fired || e.pointerId !== p.id) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (dx * dx + dy * dy > 64) { p.fired = true; userLook(); }
  }
  function onStageUp(e) { if (X.lookPtr && e.pointerId === X.lookPtr.id) X.lookPtr = null; }
  function onStageWheel(e) {
    if (!S.open || inCard(e.target) || !onPanoTarget(e.target)) return;
    userLook();
  }
  function userLook() {
    if (!S.open || S.curPanoId == null) return;
    pause();
    S.userLook = true;
    /* At rest: end the settle flow here. A move in flight lands first: the Lock, a revealing cut, a repair path
       between legs (X.midMove, r2-09), or a seek/step move still on the network gate (X.gating after pause(),
       r2-12: killing it left a stale seek context that a later land applied). r3-09: so does a seek waiting for
       the chain (pause() leaves that wait alone); forcing PAUSED here parked it until the next Play. */
    var seekWait = S.phase === "WAIT_CHAIN" && !!(S.pending && S.pending.type === "seek");
    if (!Lock.busy && !X.midMove && !X.gating && !seekWait) {
      X.runTok++;
      X.flow++;
      X.mvTry = null;
      X.seekCtx = null;
      Timers.clear(X.stepT); X.stepT = 0;
      camCancel();
      creepStop();
      if (S.phase !== "ENDED" && S.phase !== "ERROR") phase("PAUSED");
    }
    chip("Paused — looking around", 2000);
    chevApply(povHeading());
  }

  /* ---------------- Tab visibility, connectivity (§20) ---------------- */

  function onVisibility() {
    if (!S.open || !document.hidden) return;
    /* r3-10: never resumes automatically -- also not a playback the network took away: onOffline's hold
       (X.offlineHeld) and an in-flight move's resume (X.resumeOnline) are dropped even when already paused. */
    X.offlineHeld = false;
    X.resumeOnline = false;
    if (S.playing) { pause(); camFinish(); }
  }
  /* r1-06: say so at once, whatever the Player is doing, and start no new move into imagery that cannot load
     (a move already in flight finishes; if it fails, offlineHold keeps the intent). onOnline resumes. */
  function onOffline() {
    if (!S.open || S.phase === "ENDED") return;
    X.onlineRetried = false;                           // r2-11: every offline episode gets its own automatic retry
    chip("You're offline");
    if (S.playing || X.resumeOnline) { pause(); X.offlineHeld = true; }
  }
  function onOnline() {
    if (!S.open) return;
    chipClear("You're offline");
    var held = X.offlineHeld;                          // onOffline/offlineHold stopped a playback the user had not paused
    X.offlineHeld = false;
    X.offlineWait = false;
    var w = S.walkDone, broken = !!(w && w.reason === "error"), hid = !!document.hidden;
    /* r3-10: in a hidden tab nothing resumes. The walker is still rebuilt where that resumes nothing; an error card
       is left for the user (its retry would take the card down and resume), so it gets no automatic retry. */
    if (!X.onlineRetried && (S.phase === "WAIT_CHAIN" || S.phase === "ERROR" || broken) && !(hid && S.phase === "ERROR")) {
      X.onlineRetried = true;
      var seekWait = !!(S.pending && S.pending.type === "seek");
      var resume = !hid && (S.phase === "ERROR" || (S.phase === "WAIT_CHAIN" && !seekWait && (S.playing || held)));
      retryWalk(!resume);                              // a seek waiting for the chain keeps waiting, now retried
      if (resume) return;
    }
    /* r2-11: a frontier wait whose stall timer expired while offline (onStall only said so) starts its clock again */
    if (S.phase === "WAIT_CHAIN" && !X.stallT) X.stallT = Timers.set(onStall, SIM.chainStallMs);
    if (held && !S.playing && !hid) {
      if (S.phase === "PAUSED") play();
      else X.resumeOnline = true;                      // r2-03: a move still in flight resumes at its decide()
    }
  }

  /* ---------------- Desktop map: marker, cone, trail, follow, click-to-seek (§15) ---------------- */

  function mapColors() {
    var dark = false;
    try { dark = !!(window.RRTheme && RRTheme.effective && RRTheme.effective() === "dark"); } catch (e) { dark = false; }
    return dark ? COLORS.dark : COLORS.light;
  }
  function dotIcon(fill, op) {
    return { path: google.maps.SymbolPath.CIRCLE, scale: 7.5, fillColor: fill, fillOpacity: op,
      strokeColor: "#ffffff", strokeWeight: 2.5 };
  }
  function coneIcon(fill, rot) {
    return { path: "M0,0 L-13,-30 A32,32 0 0 1 13,-30 Z", fillColor: fill, fillOpacity: 0.28, strokeColor: fill,
      strokeOpacity: 0.6, strokeWeight: 1, rotation: rot, anchor: new google.maps.Point(0, 0) };
  }

  var MapView = {
    ensure: function () {
      var mo = S.mapObjs;
      if (mo.dot) return;
      var c = mapColors();
      mo.dot = new google.maps.Marker({ icon: dotIcon(c.fill, 1), zIndex: 1000, clickable: false });
      mo.cone = new google.maps.Marker({ icon: coneIcon(c.fill, 0), zIndex: 999, clickable: false });
      mo.trail = new google.maps.Polyline({ strokeColor: c.trail, strokeOpacity: 0.95, strokeWeight: 7, zIndex: 5, clickable: false });
      mo.hit = new google.maps.Polyline({ strokeOpacity: 0, strokeWeight: 22, zIndex: 6, clickable: true });
      mo.ghost = new google.maps.Marker({ icon: dotIcon(c.fill, 0.45), zIndex: 998, clickable: false, visible: false });
      mo.hit.addListener("click", function (ev) { MapView.click(ev); });
      var b = document.createElement("button");
      b.className = "sv-follow";
      b.type = "button";
      b.setAttribute("aria-pressed", "true");
      b.setAttribute("aria-label", "Follow the preview marker");
      b.textContent = "Follow";
      b.addEventListener("click", function () { if (S.open) MapView.setFollow(!S.follow); });
      mo.followEl = b;
    },
    on: function () {
      if (!S.open || S.mobile || !RR.map || X.mvOn) return;
      try { MapView.ensure(); } catch (e) { return; }
      var mo = S.mapObjs;
      X.mvOn = true;
      MapView.recolor();
      S.follow = true;
      X.fzPending = true;                              // r2-20: the first follow zooms in on the marker
      mo.followEl.setAttribute("aria-pressed", "true");
      var ctl = RR.map.controls[google.maps.ControlPosition.TOP_LEFT];
      if (ctl.getArray().indexOf(mo.followEl) === -1) ctl.push(mo.followEl);
      mo.trail.setPath([]);
      mo.dot.setMap(RR.map); mo.cone.setMap(RR.map); mo.trail.setMap(RR.map); mo.ghost.setMap(RR.map);
      mo.ghost.setVisible(false);
      X.mvDrag = RR.map.addListener("dragstart", function () { if (S.open && S.follow) MapView.setFollow(false); });
      MapView.routeReady();
      if (S.cur >= 0 && S.hops[S.cur]) { MapView.place(S.hops[S.cur].s0); MapView.trailTo(S.mkS0); }
      else { mo.dot.setVisible(false); mo.cone.setVisible(false); }
    },
    off: function () {
      MapView.stopTween();
      X.mvOn = false;
      var mo = S.mapObjs;
      if (mo.dot) {
        mo.dot.setMap(null); mo.cone.setMap(null); mo.trail.setMap(null); mo.hit.setMap(null); mo.ghost.setMap(null);
        mo.trail.setPath([]);
      }
      if (mo.followEl && RR.map) {
        var ctl = RR.map.controls[google.maps.ControlPosition.TOP_LEFT], i = ctl.getArray().indexOf(mo.followEl);
        if (i !== -1) ctl.removeAt(i);
      }
      if (X.mvDrag) { google.maps.event.removeListener(X.mvDrag); X.mvDrag = null; }
    },
    routeReady: function () {
      if (!X.mvOn || !S.R) return;
      if (!X.lineLL) {
        var V = S.R.line0.V, a = [];
        for (var i = 0; i < V.length; i++) a.push(S.R.inv(V[i].x, V[i].y));
        X.lineLL = a;
      }
      S.mapObjs.hit.setPath(X.lineLL);
      S.mapObjs.hit.setMap(RR.map);
    },
    place: function (s0) {                             // always ON the drawn route line
      S.mkS0 = s0;
      if (!X.mvOn || !S.R) return;
      var ll = lineLL(s0), mo = S.mapObjs;
      placeMarker(mo.dot, ll);
      placeMarker(mo.cone, ll);
      if (!mo.dot.getVisible()) { mo.dot.setVisible(true); mo.cone.setVisible(true); }
      MapView.trailTip(s0, ll);
      mkPush(s0, ll);
    },
    trailTo: function (s0) {                           // rebuilt on every land
      if (!X.mvOn || !X.lineLL) return;
      var seg = S.R.line0.segAt(s0), path = X.lineLL.slice(0, seg + 1);
      path.push(lineLL(s0));
      S.mapObjs.trail.setPath(path);
      X.trailSeg = seg;
    },
    trailTip: function (s0, ll) {                      // the last vertex follows the marker each frame
      if (!X.lineLL) return;
      if (S.R.line0.segAt(s0) !== X.trailSeg) return MapView.trailTo(s0);
      var p = S.mapObjs.trail.getPath(), n = p.getLength();
      if (n) p.setAt(n - 1, new google.maps.LatLng(ll.lat, ll.lng));
    },
    landed: function (j) {
      var s0 = S.hops[j].s0;
      if (!X.mvOn) { S.mkS0 = s0; return; }
      if (!X.tween || S.reduced || Math.abs(X.tween.to - s0) > 0.5) {
        MapView.stopTween();
        MapView.place(s0);
        MapView.follow();
      }
      MapView.trailTo(S.mkS0);
    },
    tweenLeg: function (j, k, legs, t0) {
      if (!X.mvOn || S.reduced || !S.hops[j]) return;    // r2-13: hop j can be truncated by a retry walker
      if (k === 0) {                                   // split the s0 interval across legs by leg length
        var a = S.mkS0, b = S.hops[j].s0, prev = panoLL(S.curPanoId), lens = [], tot = 0, q;
        for (q = 0; q < legs.length; q++) {
          var ll = panoLL(legs[q]), d = (prev && ll) ? distLL(prev, ll) : 10;
          lens.push(d); tot += d; prev = ll;
        }
        X.legS = [a];
        var acc = 0;
        for (q = 0; q < legs.length; q++) { acc += lens[q]; X.legS.push(a + (b - a) * (tot > 0 ? acc / tot : (q + 1) / legs.length)); }
      }
      var from = X.legS ? X.legS[k] : S.mkS0, to = X.legS ? X.legS[k + 1] : S.hops[j].s0;
      var dur = SIM.markerTweenMs, linear = false;
      if (S.speedIdx === 0 && k === legs.length - 1) {   // 0.5x: transition + dwell, linear, never stops
        /* the dwell after this transition is capped (r3-17): so is the tween, or the marker would lag the pano */
        dur = Math.max(SIM.markerTweenMs, Math.min(dwellMs(), SIM.dwellMaxMs + SIM.markerTweenMs) - SIM.markerDelayMs);
        linear = true;
      }
      MapView.tween(from, to, Math.max(0, t0 + SIM.markerDelayMs - now()), dur, linear);
    },
    tweenCut: function (j) {
      if (!X.mvOn || S.reduced || !S.hops[j]) return;
      MapView.tween(S.mkS0, S.hops[j].s0, 0, SIM.markerCutMs, false);
    },
    tween: function (from, to, delay, dur, linear) {
      MapView.stopTween();
      var tw = { from: from, to: to, t0: now() + delay, dur: Math.max(1, dur), linear: linear, raf: 0 };
      X.tween = tw;
      function frame() {
        if (X.tween !== tw) return;
        var t = now();
        if (t >= tw.t0) {
          var u = clamp((t - tw.t0) / tw.dur, 0, 1), e = tw.linear ? u : easeInOutSine(u);
          MapView.place(tw.from + (tw.to - tw.from) * e);
          if (u >= 1) { X.tween = null; MapView.follow(); return; }
        }
        tw.raf = Timers.raf(frame);
      }
      tw.raf = Timers.raf(frame);
    },
    stopTween: function () {
      if (X.tween) { Timers.cancelRaf(X.tween.raf); X.tween = null; }
    },
    follow: function () {                              // pan when the marker leaves the inner 60%
      if (!X.mvOn || !S.follow) return;
      if (X.fzPending) {                               // r2-20 (deviates from §15.4): zoom in once when follow engages
        X.fzPending = false;
        var c = lineLL(S.mkS0), z = RR.map.getZoom();
        RR.map.setCenter(c);
        if (z == null || z < SIM.followZoom) RR.map.setZoom(SIM.followZoom);
        log("pan", { s0: r1(S.mkS0), zoom: RR.map.getZoom() });
        return;
      }
      var b = RR.map.getBounds();
      if (!b) return;
      var ne = b.getNorthEast(), sw = b.getSouthWest(), ll = lineLL(S.mkS0);
      var dLat = ne.lat() - sw.lat(), dLng = ne.lng() - sw.lng(), f = SIM.followInset;
      if (dLng < 0) dLng += 360;
      var inside = ll.lat > sw.lat() + f * dLat && ll.lat < ne.lat() - f * dLat &&
                   ll.lng > sw.lng() + f * dLng && ll.lng < sw.lng() + (1 - f) * dLng;
      if (inside) return;
      if (S.reduced) RR.map.setCenter(ll); else RR.map.panTo(ll);
      log("pan", { s0: r1(S.mkS0) });
    },
    setFollow: function (on) {
      S.follow = !!on;
      if (S.mapObjs.followEl) S.mapObjs.followEl.setAttribute("aria-pressed", S.follow ? "true" : "false");
      if (S.follow && X.mvOn) {
        if (S.cur >= 0) { X.fzPending = true; MapView.follow(); return; }   // zoom in on the marker again (r2-20)
        var ll = lineLL(S.mkS0);
        if (S.reduced) RR.map.setCenter(ll); else RR.map.panTo(ll);
        log("pan", { s0: r1(S.mkS0) });
      }
    },
    ghostAt: function (s0) {
      if (!X.mvOn) return;
      var g = S.mapObjs.ghost;
      if (s0 == null) { g.setVisible(false); return; }
      placeMarker(g, lineLL(clamp(s0, 0, S.R.total0)));
      if (!g.getVisible()) g.setVisible(true);
    },
    cone: function (h, force) {                        // <= every 50 ms, plus a trailing update
      if (!X.mvOn) return;
      var t = now();
      if (!force && t - X.lastConeT < SIM.coneThrottleMs) {
        if (!X.coneT) X.coneT = Timers.set(function () { X.coneT = 0; MapView.cone(povHeading(), true); }, SIM.coneThrottleMs);
        return;
      }
      X.lastConeT = t;
      X.coneH = h;
      S.mapObjs.cone.setIcon(coneIcon(X.mvFill || mapColors().fill, h));
    },
    recolor: function () {
      var mo = S.mapObjs;
      if (!mo.dot) return;
      var c = mapColors();
      X.mvFill = c.fill;
      mo.dot.setIcon(dotIcon(c.fill, 1));
      mo.ghost.setIcon(dotIcon(c.fill, 0.45));
      mo.cone.setIcon(coneIcon(c.fill, X.coneH != null ? X.coneH : povHeading()));
      mo.trail.setOptions({ strokeColor: c.trail });
    },
    click: function (ev) {                             // §15.5: the pass nearest the current position wins
      if (!S.open || !S.R || !ev || !ev.latLng) return;
      var p = S.R.fwd(ev.latLng.lat(), ev.latLng.lng()), L0 = S.R.line0;
      var cur = S.hops[S.cur], c0 = cur ? cur.s0 : 0;
      var g = L0.project(p.x, p.y, 0, S.R.total0, 0), w = L0.project(p.x, p.y, c0 - 400, c0 + 400, 0);
      var target = (w && g && w.d <= g.d + 1.5) ? w.s : (g ? g.s : c0);
      seekTo(target, S.playing);
    }
  };

  /* ---------------- Debug snapshot (§7.4): plain JSON-safe data ---------------- */

  function debug(sinceT) {
    var since = typeof sinceT === "number" ? sinceT : -Infinity, lg = [], mk = [], i;
    for (i = 0; i < LOG.length; i++) if (LOG[i].t > since) lg.push(LOG[i]);
    for (i = 0; i < MK.length; i++) if (MK[i].t > since) mk.push(MK[i]);
    var pv = null;
    try { var p = S.pano && S.pano.getPov(); if (p) pv = { heading: r1(norm360(p.heading)), pitch: r1(p.pitch || 0) }; } catch (e) { pv = null; }
    var mll = (X.mvOn && S.R) ? lineLL(S.mkS0) : null;
    var snap = {
      version: "sv2", panoCreates: S.panoCreates, open: S.open, phase: S.phase, playing: S.playing,
      speed: speedObj().key, cur: S.cur, epoch: S.epoch, zoom: S.zoom, follow: S.follow, pov: pv,
      lock: { busy: Lock.busy, mode: Lock.mode, id: Lock.id, t0: Lock.t0, seq: Lock.seq },
      hops: S.hops, turns: S.turns, stops: S.stops, info: { totalOrigM: S.info ? S.info.totalOrigM : null },
      walkDone: S.walkDone,
      svc: Svc ? { netCalls: Svc.netCalls, sessionCalls: Svc.sessionCalls, hits: Svc.hits, budget: X.budget, reqLog: Svc.reqLog } : null,
      net: { ok: Net.ok, supported: Net.supported, slow: Net.slow, tilesSeen: Net.tilesSeen, z0Lat: Net.z0Lat },
      chev: { visible: !!(X.chev.visible && els && !els.chev.hidden), mode: X.chev.mode, worldBrg: X.chev.worldBrg, rel: X.chev.rel },
      beacon: { visible: !!X.beaconOn, k: X.beaconK },
      marker: mll ? { s0: r1(S.mkS0), lat: mll.lat, lng: mll.lng } : null,
      timers: Timers.count(), m: S.m, curPanoId: S.curPanoId, pano: S.pano ? safePano() : null,
      log: lg, mk: mk
    };
    return JSON.parse(JSON.stringify(snap));
  }

  /* ---------------- Public API (§4) ---------------- */

  window.RRSim = {
    open: open,                                        // #previewBtn (app.js) and #preToSim (run.js)
    close: close,
    isOpen: function () { return S.open; },
    _debug: debug
  };
})();
