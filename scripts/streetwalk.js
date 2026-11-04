/* ============================================================
   rrStreetWalk (final, tuned v6 + hardening r2) — route-following Street View walker (RunRoute).
   Turns a WALKING DirectionsResult route (legs[].steps[].path) into a chain
   of official Street View pano ids that follows the route the way pressing
   the forward arrow on Google Maps would: pano -> linked pano (~10 m),
   direction preserved, the right link at intersections, no replays.

   Billing: StreetViewService.getPanorama METADATA only (free: "Neither the
   built-in Street View experience ... nor usage of the StreetViewService()
   class is charged"). Never creates or touches a StreetViewPanorama; the
   caller steps its ONE panorama with setPano(hop.pano).

   ES5, standalone:  var ctl = rrStreetWalk(svc, route.legs, opts);
     opts.onStart(info)  info = { totalM, maneuvers[], stops[] }
     opts.onHop(hop, i)  hops arrive in order, one hop behind the search (up to
                         detourMaxNodes + 1 behind while the tip is in a short
                         run of another capture date, so a detour can be undone)
     opts.onDone(sum)    sum  = { reason, hops, jumps, gapM, tailM, calls, ms }
     opts.onError(err)
     ctl.cancel(); ctl.setCursor(i) (with opts.maxAhead); ctl.stats(); ctl.route

   Hardening r2 (2026-11-04), two traversal rules on top of the tuned v6:
   - U-turn (out-and-back at a stop): where the regular step finds no valid
     hop within uturnLookM before a U-turn, walk on to the pano nearest the
     turn point, then turn around there on a link whose position is projected
     onto the leg AFTER the U-turn. v6 re-anchored instead: a jump onto the
     return leg that replayed the panos just shown.
   - Detour: a short run of another capture date (<= detourMaxNodes panos)
     that is left into a different date through a link whose heading disagrees
     with the pano positions (more than glitchDeg over >= glitchMinM), with
     >= detourGlitches such legs on the way in, through and out, is GPS-denied
     imagery off the walkable surface (e.g. a garage ramp under a plaza). It is
     dropped before it is emitted, and the hop out of it becomes one cut from
     the pano before it. That hop carries "avoid" (the dropped pano ids, hidden
     ones included) so the caller's own link search never walks them either.
   Final fixer (2026-11-04):
   - Fork: when the best link leaves the tip's capture run for another date
     and a valid link that keeps the run parts from it (forkDeg) scoring
     within forkMargin, one more hop down each arm decides. The one-hop score
     let a long link up the wrong arm of a Y junction win on progress alone
     (R-C: West Rd beat Colborne Lodge Dr for 45 m, then a cut back).
   ============================================================ */
(function (root) {
  "use strict";

  var D2R = Math.PI / 180;
  var ER = 6371008.8;

  var DEFAULTS = {
    smoothM: 16,         // decisions use the route smoothed over +-this (sidewalk crossings, jogs, spikes)
    lookaheadM: 20,      // target point (route s + this) for the link angle prefilter
    angleMaxDeg: 120,    // links within this of the desired bearing get their metadata fetched
    latMaxM: 24,         // hard cap: lateral offset of a linked pano from the route
    wLat0: 0.25,         // score per metre of lateral offset
    latSoftM: 8,         // ... plus wLat per metre beyond this
    wLat: 0.5,
    dLatMaxM: 10,        // hard cap: lateral may grow by at most this in one hop
    wDLat: 0.5,          // score per metre of lateral growth
    minGainM: 2,         // a hop must advance route progress by at least this
    aliasM: 2.5,         // a linked pano closer than this = same spot (duplicate / other date)
    backTolM: 8,         // projection window starts this far behind current progress
    windowM: 70,         // projection window length ahead of current progress
    lambda: 0.1,         // projection cost = lateral + lambda * (s - windowStart): earliest pass wins
    startSlackM: 8,      // a pass inside the window beats one clamped to the window start if within this
    gainCapM: 14,        // progress beyond this earns no extra score
    cutTolM: 2,          // hop midpoint farther from the route than both ends by more than this = corner cut
    cutMaxM: 10,
    wCut: 1.5,
    excTolM: 4,          // progress minus hop distance: short-circuiting a U-turn / loop
    excMaxM: 15,
    wExc: 1.0,
    contLookM: 25,       // onward direction = route chord [s, s + contLookM]
    contTolDeg: 25,      // an onward link within this of the onward direction costs nothing
    wCont: 1.0,          // score per 10 deg beyond contTolDeg
    contMaxDeg: 90,      // no onward link within this = dead end
    deadEndPen: 6,
    dateBonus: 1.0,      // same imageDate as the current pano
    confidentScore: 3,   // a best hop scoring below this triggers the depth-2 lookahead
    bridgeTop: 2,        // depth-2 search through at most this many intermediate panos
    bridgeMaxM: 30,
    bridgeBackM: 5,
    bridgePen: 1.0,
    bridgeMargin: 1.0,   // a 2-hop path must beat the single best hop by this much
    revisitWindowM: 300, // a pano seen within this many route metres may only be revisited across a U-turn
    uturnDeg: 150,
    uturnLookM: 40,      // a U-turn at most this far ahead (or uturnPastM behind: the smoothed line folds the
    uturnPastM: 6,       //   spur tip back by ~smoothM/2) gets the approach-then-turn-around step
    uturnSpanM: 40,      // approach hops project onto the original route within this span before the turn point,
    uturnGainM: 2,       //   each getting at least this much closer to it
    uturnReachM: 30,     // turn around on a link only within this distance of the turn point
    glitchDeg: 40,       // a link whose heading is more than this off the bearing between the two pano positions,
    glitchMinM: 8,       //   over at least this distance, has unreliable geometry (GPS-denied capture)
    detourMaxNodes: 3,   // a run of at most this many panos of one capture date, entered from and left into other
    detourMaxM: 50,      //   dates within this many route metres through >= detourGlitches such links, is a detour
    detourGlitches: 2,   //   off the walkable surface (a ramp, a garage): dropped and replaced by one cut
    forkDeg: 20,         // the best link leaves the tip's capture date while a valid link keeping it heads at least this
    forkMargin: 4,       //   far apart and scores within this: a fork, decided one more hop down each arm
    anchorRadiusM: 30,   // location lookups when re-anchoring
    anchorLatMaxM: 20,
    anchorAlignDeg: 60,  // an anchored pano must have a link within this of the route bearing
    anchorFirst: [10, 20, 30, 45],
    anchorStepM: 20,
    startOffsets: [0, 10, 20, 30, 45, 60, 80, 100],
    finishTolM: 15,
    maneuverMinDeg: 30,  // step boundaries turning at least this (over +-maneuverSpanM) are maneuvers
    maneuverSpanM: 15,
    majorSpanM: 30,      // a maneuver is 'major' (worth a turn arrow) if the bearing changes >= majorMinDeg
    majorMinDeg: 30,     //   over +-majorSpanM (crosswalk jogs cancel out and stay minor)
    concurrency: 4,
    retries: 2,
    timeoutMs: 10000,
    maxAhead: 0,         // 0 = build the whole chain eagerly; N = stay at most N hops ahead of setCursor()
    debug: false,
    sources: null,       // default [google.maps.StreetViewSource.GOOGLE] (official imagery: has links)
    preference: null     // default google.maps.StreetViewPreference.NEAREST
  };

  /* ---------------- small helpers ---------------- */

  function extend(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    if (b) for (k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) o[k] = b[k];
    return o;
  }
  function llOf(p) {
    if (!p) return null;
    if (typeof p.lat === "function") return { lat: p.lat(), lng: p.lng() };
    if (typeof p.lat === "number" && typeof p.lng === "number") return { lat: p.lat, lng: p.lng };
    return null;
  }
  function hyp(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }
  function norm360(h) { h = h % 360; return h < 0 ? h + 360 : h; }
  function angDiff(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }   // signed a-b in [-180,180)
  function brgXY(ax, ay, bx, by) { return norm360(Math.atan2(bx - ax, by - ay) / D2R); }
  function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  function defer(fn) {
    if (typeof Promise === "function") Promise.resolve().then(fn);
    else setTimeout(fn, 0);
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- polyline model (planar metres, arc-length s) ---------------- */

  function makeLine(V, startSlack) {
    var n = V.length, total = V[n - 1].cum;
    function segAt(s) {
      if (s <= 0) return 0;
      if (s >= total) return n - 2;
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (V[mid].cum <= s) lo = mid; else hi = mid; }
      return lo;
    }
    function pointAt(s) {
      if (s <= 0) return { x: V[0].x, y: V[0].y };
      if (s >= total) return { x: V[n - 1].x, y: V[n - 1].y };
      var i = segAt(s), a = V[i], b = V[i + 1], L = b.cum - a.cum, t = L > 0 ? (s - a.cum) / L : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    /* Clamped point-to-polyline projection restricted to [sFrom, sTo].
       cost = lateral + lambda*(s - sFrom): of two passes at a similar distance
       (out-and-back, loops) the EARLIEST wins. A point whose nearest in-window
       place is the clamped window START lies behind the window; a genuine pass
       inside the window (the return leg of an out-and-back) about as close wins. */
    function project(px, py, sFrom, sTo, lambda) {
      if (sFrom < 0) sFrom = 0;
      if (sTo > total) sTo = total;
      if (sTo < sFrom) return null;
      var best = null, inner = null, i = segAt(sFrom);
      lambda = lambda || 0;
      for (; i < n - 1; i++) {
        var A = V[i], B = V[i + 1];
        if (A.cum > sTo) break;
        var L = B.cum - A.cum;
        if (!(L > 0)) continue;
        var tmin = Math.max(0, (sFrom - A.cum) / L), tmax = Math.min(1, (sTo - A.cum) / L);
        if (tmax < tmin) continue;
        var dx = B.x - A.x, dy = B.y - A.y;
        var t = ((px - A.x) * dx + (py - A.y) * dy) / (L * L);
        if (t < tmin) t = tmin; else if (t > tmax) t = tmax;
        var qx = A.x + dx * t, qy = A.y + dy * t;
        var d = hyp(px - qx, py - qy), s = A.cum + L * t;
        var cost = d + lambda * (s - sFrom);
        if (!best || cost < best.cost) best = { s: s, d: d, cost: cost };
        if (s > sFrom + 0.01 && (!inner || cost < inner.cost)) inner = { s: s, d: d, cost: cost };
      }
      if (best && inner && best.s <= sFrom + 0.01 && inner.d <= best.d + startSlack) return inner;
      return best;
    }
    function chordBearing(s0, s1) {
      if (s1 > total) { s1 = total; s0 = Math.max(0, Math.min(s0, total - 8)); }
      if (s0 < 0) s0 = 0;
      var pa = pointAt(s0), pb = pointAt(s1);
      return brgXY(pa.x, pa.y, pb.x, pb.y);
    }
    return { V: V, n: n, total: total, segAt: segAt, pointAt: pointAt, project: project,
      chordBearing: chordBearing, bearingAt: function (s) { return chordBearing(s, s + 8); } };
  }

  /* Resample at ~stepM and replace each point by the mean of the route within +-w metres
     (prefix sums over uniform samples). Each sample keeps its ORIGINAL arc length. */
  function smoothVerts(L0, w) {
    var stepM = 2, total = L0.total, m = Math.max(2, Math.ceil(total / stepM) + 1), k;
    var xs = [], ys = [], cs = [];
    for (k = 0; k < m; k++) {
      var c = Math.min(total, k * total / (m - 1)), p = L0.pointAt(c);
      xs.push(p.x); ys.push(p.y); cs.push(c);
    }
    var px = [0], py = [0];
    for (k = 0; k < m; k++) { px.push(px[k] + xs[k]); py.push(py[k] + ys[k]); }
    var h = Math.max(1, Math.round(w / (total / (m - 1)))), V = [], cum = 0;
    for (k = 0; k < m; k++) {
      var a = Math.max(0, k - h), b = Math.min(m - 1, k + h), cnt = b - a + 1;
      var x = (px[b + 1] - px[a]) / cnt, y = (py[b + 1] - py[a]) / cnt;
      if (V.length) {
        var q = V[V.length - 1], dd = hyp(x - q.x, y - q.y);
        if (dd < 0.05) continue;
        cum += dd;
      }
      V.push({ x: x, y: y, cum: cum, ocum: cs[k] });
    }
    return V;
  }

  /* ---------------- route model ---------------- */

  function buildRoute(legs, C) {
    if (!legs || !legs.length) return null;
    var steps = [], pts = [], li, si, pi, g = 0, k;
    for (li = 0; li < legs.length; li++) {
      var ls = (legs[li] && legs[li].steps) || [];
      for (si = 0; si < ls.length; si++) {
        var st = ls[si] || {};
        var path = st.path || st.lat_lngs || [];
        if (!path.length) path = [st.start_location, st.end_location];
        steps.push({ leg: li, maneuver: String(st.maneuver || ""), instructions: String(st.instructions || ""), cum: null });
        for (pi = 0; pi < path.length; pi++) {
          var ll = llOf(path[pi]);
          if (ll) pts.push({ lat: ll.lat, lng: ll.lng, leg: li, step: g });
        }
        g++;
      }
    }
    if (pts.length < 2) return null;

    var lat0 = pts[0].lat, lng0 = pts[0].lng, cosl = Math.cos(lat0 * D2R);
    function fwd(lat, lng) { return { x: (lng - lng0) * D2R * ER * cosl, y: (lat - lat0) * D2R * ER }; }
    function inv(x, y) { return { lat: lat0 + y / ER / D2R, lng: lng0 + x / (ER * cosl) / D2R }; }

    var V0 = [], cum = 0, legEnd = [];
    for (k = 0; k < pts.length; k++) {
      var p = fwd(pts[k].lat, pts[k].lng);
      if (V0.length) {
        var q = V0[V0.length - 1], dd = hyp(p.x - q.x, p.y - q.y);
        if (dd >= 0.05) { cum += dd; V0.push({ x: p.x, y: p.y, cum: cum }); }
      } else {
        V0.push({ x: p.x, y: p.y, cum: 0 });
      }
      if (steps[pts[k].step].cum === null) steps[pts[k].step].cum = cum;
      legEnd[pts[k].leg] = cum;
    }
    if (V0.length < 2 || !(cum > 1)) return null;
    var L0 = makeLine(V0, C.startSlackM);

    /* Maneuvers and stops come from the ORIGINAL geometry. */
    var man0 = [], span = C.maneuverSpanM;
    for (k = 1; k < steps.length; k++) {
      var b0 = steps[k].cum;
      if (b0 === null || b0 < 1 || b0 > L0.total - 1) continue;
      var pa = L0.pointAt(Math.max(0, b0 - span)), pb = L0.pointAt(b0), pc = L0.pointAt(Math.min(L0.total, b0 + span));
      var turn = angDiff(brgXY(pb.x, pb.y, pc.x, pc.y), brgXY(pa.x, pa.y, pb.x, pb.y)), man = steps[k].maneuver;
      if (Math.abs(turn) < C.maneuverMinDeg && man.indexOf("uturn") === -1) continue;
      var net = angDiff(L0.chordBearing(b0 + 2, Math.min(L0.total, b0 + C.majorSpanM)),
        L0.chordBearing(Math.max(0, b0 - C.majorSpanM), Math.max(0, b0 - 2)));
      var major = Math.abs(net) >= C.majorMinDeg;
      man0.push({ s0: b0, x: pb.x, y: pb.y, turnDeg: turn, netDeg: net, major: major,
        maneuver: man, kind: kindOf(man, major ? net : turn), step: k, leg: steps[k].leg, instructions: steps[k].instructions });
    }

    /* Decision geometry: the smoothed route (or the original when smoothM is 0). */
    var L = L0, toS = function (s0) { return s0; }, toS0 = function (s) { return s; };
    if (C.smoothM > 0 && L0.total > 4 * C.smoothM) {
      var VS = smoothVerts(L0, C.smoothM);
      if (VS.length >= 2) {
        L = makeLine(VS, C.startSlackM);
        toS = function (s0) {           // original arc length -> smoothed arc length
          if (s0 <= 0) return 0;
          if (s0 >= VS[VS.length - 1].ocum) return L.total;
          var lo = 0, hi = VS.length - 1;
          while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (VS[mid].ocum <= s0) lo = mid; else hi = mid; }
          var a = VS[lo], b = VS[lo + 1], f = b.ocum > a.ocum ? (s0 - a.ocum) / (b.ocum - a.ocum) : 0;
          return a.cum + f * (b.cum - a.cum);
        };
        toS0 = function (s) {           // smoothed -> original (for progress display)
          if (s <= 0) return 0;
          if (s >= L.total) return L0.total;
          var i = L.segAt(s), a = VS[i], b = VS[i + 1], f = b.cum > a.cum ? (s - a.cum) / (b.cum - a.cum) : 0;
          return a.ocum + f * (b.ocum - a.ocum);
        };
      }
    }
    var maneuvers = [];
    for (k = 0; k < man0.length; k++) { man0[k].k = k; man0[k].s = toS(man0[k].s0); maneuvers.push(man0[k]); }
    var stops = [];
    for (k = 0; k < legEnd.length - 1; k++) {
      var sp = L0.pointAt(legEnd[k]);
      stops.push({ k: k + 1, s: toS(legEnd[k]), s0: legEnd[k], x: sp.x, y: sp.y });
    }
    return { total: L.total, total0: L0.total, maneuvers: maneuvers, stops: stops, fwd: fwd, inv: inv,
      pointAt: L.pointAt, project: L.project, bearingAt: L.bearingAt, chordBearing: L.chordBearing,
      toS: toS, toS0: toS0, line: L, line0: L0 };
  }

  /* Turn classification: Directions' maneuver string when it names a direction, else the geometry. */
  function kindOf(man, turn) {
    man = man || "";
    if (man.indexOf("uturn") !== -1) return "uturn";
    if (man.indexOf("sharp-left") !== -1) return "sharp-left";
    if (man.indexOf("sharp-right") !== -1) return "sharp-right";
    if (man.indexOf("slight-left") !== -1) return "slight-left";
    if (man.indexOf("slight-right") !== -1) return "slight-right";
    if (man.indexOf("left") !== -1) return "left";
    if (man.indexOf("right") !== -1) return "right";
    var a = Math.abs(turn), side = turn < 0 ? "left" : "right";
    if (a >= 150) return "uturn";
    if (a >= 120) return "sharp-" + side;
    if (a >= 55) return side;
    if (a >= 30) return "slight-" + side;
    return "straight";
  }

  /* ---------------- metadata store (free lookups, concurrency-limited, cached) ---------------- */

  function makeMeta(svc, C, stats) {
    var cache = {}, waiting = {}, q = [], inflight = 0;
    var G = (typeof google !== "undefined" && google.maps) ? google.maps : null;
    var OK = (G && G.StreetViewStatus && G.StreetViewStatus.OK) || "OK";
    var ZERO = (G && G.StreetViewStatus && G.StreetViewStatus.ZERO_RESULTS) || "ZERO_RESULTS";

    function normalize(data) {
      if (!data || !data.location || !data.location.pano) return null;
      var ll = llOf(data.location.latLng);
      if (!ll) return null;
      var links = [], raw = data.links || [], j;
      for (j = 0; j < raw.length; j++) {
        var l = raw[j];
        if (l && l.pano) links.push({ pano: String(l.pano), heading: norm360(+l.heading || 0) });
      }
      return { id: String(data.location.pano), lat: ll.lat, lng: ll.lng, links: links,
        date: String(data.imageDate || ""), copyright: String(data.copyright || "") };
    }
    function pump() { while (inflight < C.concurrency && q.length) send(q.shift()); }
    function get(key, req, cb) {
      if (Object.prototype.hasOwnProperty.call(cache, key)) {
        var v = cache[key];
        stats.cacheHits++;
        defer(function () { cb(v); });
        return;
      }
      if (waiting[key]) { waiting[key].push(cb); return; }
      waiting[key] = [cb];
      q.push({ key: key, req: req, tries: 0 });
      pump();
    }
    function send(job) {
      inflight++;
      stats.calls++;
      if (job.req.pano) stats.idCalls++; else stats.locCalls++;
      var done = false;
      var timer = setTimeout(function () { finish(null, "TIMEOUT"); }, C.timeoutMs);
      function finish(data, status) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inflight--;
        if (status !== OK && status !== ZERO && job.tries < C.retries) {
          job.tries++;
          stats.retries++;
          setTimeout(function () { q.unshift(job); pump(); }, 300 * Math.pow(2, job.tries));
          pump();
          return;
        }
        if (status !== OK && status !== ZERO) stats.errors++;
        var v = status === OK ? normalize(data) : null;
        cache[job.key] = v;
        if (v && !job.req.pano && !Object.prototype.hasOwnProperty.call(cache, "p:" + v.id)) cache["p:" + v.id] = v;
        var w = waiting[job.key] || [];
        delete waiting[job.key];
        for (var k = 0; k < w.length; k++) w[k](v);
        pump();
      }
      try {
        var ret = svc.getPanorama(job.req, function (data, status) { finish(data, status); });
        if (ret && typeof ret.then === "function") {
          ret.then(function (resp) { if (resp && resp.data) finish(resp.data, OK); }, function () { /* callback carries the status */ });
        }
      } catch (e) {
        finish(null, "EXCEPTION");
      }
    }
    return {
      byId: function (id, cb) { get("p:" + id, { pano: id }, cb); },
      near: function (lat, lng, radius, cb) {
        var req = { location: { lat: lat, lng: lng }, radius: radius, preference: C.preference };
        if (C.sources) req.sources = C.sources;
        get("l:" + lat.toFixed(6) + "," + lng.toFixed(6) + ":" + radius, req, cb);
      }
    };
  }

  /* ---------------- the walker ---------------- */

  function rrStreetWalk(svc, routeLegs, opts) {
    var C = extend(DEFAULTS, opts || {});
    var G = (typeof google !== "undefined" && google.maps) ? google.maps : null;
    if (!C.sources && G && G.StreetViewSource && G.StreetViewSource.GOOGLE) C.sources = [G.StreetViewSource.GOOGLE];
    if (!C.preference) C.preference = (G && G.StreetViewPreference && G.StreetViewPreference.NEAREST) || "nearest";
    var onStart = typeof C.onStart === "function" ? C.onStart : function () {};
    var onHop = typeof C.onHop === "function" ? C.onHop : function () {};
    var onDone = typeof C.onDone === "function" ? C.onDone : function () {};
    var onError = typeof C.onError === "function" ? C.onError : function () {};

    var stats = { calls: 0, idCalls: 0, locCalls: 0, cacheHits: 0, retries: 0, errors: 0, hops: 0, linkHops: 0,
      aliasHops: 0, bridgeHops: 0, skipHops: 0, lookaheads: 0, anchors: 0, jumps: 0, gapM: 0, uturns: 0, detours: 0,
      forks: 0, t0: now(), ms: 0 };
    var log = C.debug ? [] : null;
    var R = buildRoute(routeLegs, C);
    var chain = [];
    var emitted = 0;       // chain[0 .. emitted-1] have been handed to onHop
    var visited = {};      // pano id -> route progress of its latest visit
    var suspect = {};      // pano id -> 1: part of a dropped detour, never used again
    var uDone = {};        // maneuver k -> 1: this U-turn has been handled
    var uFloor = -1;       // after turning around on a link: projections never reach back before this (the U-turn)
    var finished = false, cancelled = false, cursor = 0, parked = null;

    var ctl = {
      cancel: function () { cancelled = true; parked = null; },
      setCursor: function (i) {
        cursor = Math.max(cursor, i | 0);
        if (parked) { var f = parked; parked = null; defer(f); }
      },
      stats: function () { return stats; },
      debug: function () { return log; },
      route: R
    };
    if (!R) {
      defer(function () { finished = true; onDone({ reason: "no-route", hops: 0 }); });
      return ctl;
    }
    var meta = makeMeta(svc, C, stats);
    var maxHops = Math.ceil(R.total / Math.max(0.5, C.minGainM)) + 50;

    function fail(e) {
      if (finished) return;
      finished = true;
      try { onError(e); } catch (e2) { /* ignore */ }
    }
    function safe(fn) {
      return function () {
        if (cancelled || finished) return;
        try { fn.apply(null, arguments); } catch (e) { fail(e); }
      };
    }

    function nextManeuver(s) {
      var M = R.maneuvers;
      for (var k = 0; k < M.length; k++) {
        if (M[k].major && M[k].s > s - 6) {
          return { k: k, kind: M[k].kind, distM: r1(M[k].s - s), turnDeg: Math.round(M[k].netDeg) };
        }
      }
      return null;
    }
    function pub(h) {
      var o = { i: h.i, pano: h.id, lat: h.lat, lng: h.lng, s: r1(h.s), s0: r1(R.toS0(h.s)), lateral: r1(h.d),
        date: h.date, how: h.how, jump: h.jump, gapM: r1(h.gapM || 0), distM: r1(h.distM || 0),
        inHeading: Math.round(h.inHeading), outHeading: Math.round(h.outHeading), routeHeading: Math.round(R.bearingAt(h.s)),
        next: nextManeuver(h.s), nLinks: h.links.length, linkHeading: h.linkHeading == null ? null : Math.round(h.linkHeading) };
      if (h.avoid) o.avoid = h.avoid.slice();   // the exit hop of a dropped detour: its pano ids (never walk them)
      return o;
    }
    function emit(h, nxt) {
      var dd = nxt ? hyp(nxt.x - h.x, nxt.y - h.y) : 0;
      h.outHeading = (nxt && !nxt.jump && dd >= 1.5) ? brgXY(h.x, h.y, nxt.x, nxt.y) : R.bearingAt(h.s);
      onHop(pub(h), h.i);
    }
    /* The tip is always held back (its outHeading needs the next node). So is a short run of one capture date
       that differs from the node before it, together with that node: if the run turns out to be a detour it is
       dropped before anyone has seen it. */
    function holdFrom() {
      var L = chain.length;
      if (!L) return 0;
      var date = chain[L - 1].date, rs = L - 1;
      while (rs > 0 && chain[rs - 1].date === date) { rs--; if (L - rs > C.detourMaxNodes) return L - 1; }
      return rs >= 1 ? rs - 1 : L - 1;
    }
    function flush(all) {
      var upto = all ? chain.length : holdFrom();
      while (emitted < upto) {
        var h = chain[emitted];
        emitted++;
        emit(h, chain[emitted] || null);
      }
    }
    function count(node, k) {
      if (node.how === "link") stats.linkHops += k;
      else if (node.how === "alias") stats.aliasHops += k;
      else if (node.how === "bridge") stats.bridgeHops += k;
      else if (node.how === "skip") stats.skipHops += k;
      else if (node.jump) { stats.jumps += k; stats.gapM += k * node.gapM; }
    }
    /* 1 when the link (heading h) from (ax, ay) to (bx, by) disagrees with the bearing between the positions. */
    function glitch(ax, ay, bx, by, h) {
      if (h == null || hyp(bx - ax, by - ay) < C.glitchMinM) return 0;
      return Math.abs(angDiff(h, brgXY(ax, ay, bx, by))) > C.glitchDeg ? 1 : 0;
    }
    /* Detour rule. `node` leaves the tip's capture date through an unreliable link. If the tip's run is short and
       still unemitted, and the links into, through and out of it carry >= detourGlitches unreliable legs, drop the
       run: `node` becomes one cut (a jump) from the node before the run. */
    function detour(node) {
      var L = chain.length, tip = chain[L - 1], rs = L - 1, g = node.gl || 0, k;
      if (node.date === tip.date || !g) return;
      while (rs > 0 && chain[rs - 1].date === tip.date) { rs--; if (L - rs > C.detourMaxNodes) return; }
      if (rs < 1 || rs - 1 < emitted) return;
      var P = chain[rs - 1];
      if (tip.s - P.s > C.detourMaxM) return;
      for (k = rs; k < L; k++) g += chain[k].gl || 0;
      if (g < C.detourGlitches) return;
      if (log) log.push({ i: L, phase: "detour", from: P.id.slice(0, 10), dropped: L - rs, glitches: g, to: node.id.slice(0, 10) });
      var dropped = [];
      for (k = L - 1; k >= rs; k--) {
        var r = chain.pop();
        count(r, -1); suspect[r.id] = 1; dropped.unshift(r.id);
        if (r.via) dropped.unshift(r.via);
      }
      if (node.via) dropped.push(node.via);   // the exit's own hidden pano (a skip leaving the run) is part of it
      stats.detours++;
      node.how = "anchor"; node.jump = true; node.gapM = Math.max(0, node.s - P.s); node.linkHeading = null; node.reason = "detour";
      node.avoid = dropped;    // published on the hop: the caller's own link search must not walk them either
    }
    function push(node) {
      if (chain.length && !node.jump) detour(node);
      var prev = chain.length ? chain[chain.length - 1] : null;
      node.i = chain.length;
      if (prev && node.s < prev.s) node.s = prev.s;       // progress never decreases
      var dd = prev ? hyp(node.x - prev.x, node.y - prev.y) : 0;
      node.distM = dd;
      node.inHeading = (prev && !node.jump && dd >= 1.5) ? brgXY(prev.x, prev.y, node.x, node.y) : R.bearingAt(node.s);
      chain.push(node);
      visited[node.id] = node.s;
      stats.hops = chain.length;
      count(node, 1);
      flush(false);
    }
    function finishWalk(reason) {
      if (finished) return;
      flush(true);
      finished = true;
      stats.ms = now() - stats.t0;
      var last = chain.length ? chain[chain.length - 1] : null;
      var tail = last ? Math.max(0, R.total - last.s) : R.total;
      try {
        onDone({ reason: reason, hops: chain.length, totalM: r1(R.total), endS: last ? r1(last.s) : 0,
          tailM: r1(tail), jumps: stats.jumps, gapM: r1(stats.gapM), calls: stats.calls, ms: Math.round(stats.ms) });
      } catch (e) { /* ignore */ }
    }

    function wantFrom(x, y, s) {
      var t = R.pointAt(Math.min(R.total, s + C.lookaheadM));
      if (hyp(t.x - x, t.y - y) < 3) return R.bearingAt(s);
      return brgXY(x, y, t.x, t.y);
    }
    /* Smallest angle between one of m's onward links (not back to fromId) and the route's onward
       direction at s. 0 = keeps going exactly along the route; > contMaxDeg = dead end. */
    function contAngle(m, s, fromId) {
      if (s >= R.total - C.finishTolM - 10) return 0;
      var w = R.chordBearing(s, s + C.contLookM), best = 180;
      for (var j = 0; j < m.links.length; j++) {
        if (m.links[j].pano === fromId) continue;
        var a = Math.abs(angDiff(m.links[j].heading, w));
        if (a < best) best = a;
      }
      return best;
    }
    /* Going back over imagery just shown is only right across a real U-turn (out-and-back at a
       stop); a switchback ramp or zig-zag sidewalk would otherwise replay the same panos backwards. */
    function recentRevisit(id, sNew) {
      if (!Object.prototype.hasOwnProperty.call(visited, id)) return false;
      var s0 = visited[id];
      if (sNew - s0 >= C.revisitWindowM) return false;
      for (var k = 0; k < R.maneuvers.length; k++) {
        var M = R.maneuvers[k];
        if (M.s >= s0 - 5 && M.s <= sNew + 5 && isUturn(M)) return false;
      }
      return true;
    }
    function isUturn(M) {
      return M.maneuver.indexOf("uturn") !== -1 || Math.max(Math.abs(M.netDeg), Math.abs(M.turnDeg)) >= C.uturnDeg;
    }

    /* Score linked pano m as the next hop from `from` (the chain tip, or a bridge pano with base = tip).
       sFrom (U-turn step only): project onto the route from there on, i.e. onto the leg after the U-turn. */
    function evalCand(from, m, linkHeading, want, base, sFrom) {
      base = base || from;
      var p = R.fwd(m.lat, m.lng);
      var dist = hyp(p.x - from.x, p.y - from.y);
      var lo = sFrom != null ? sFrom : Math.max(from.s - C.backTolM, uFloor);
      var pr = R.project(p.x, p.y, lo, Math.max(lo, from.s) + C.windowM, C.lambda);
      var e = { m: m, x: p.x, y: p.y, dist: dist, linkHeading: linkHeading,
        dh: linkHeading == null ? null : Math.abs(angDiff(linkHeading, want)), valid: false, score: -1e9 };
      if (!pr) return e;
      e.s = pr.s; e.d = pr.d;
      e.gain = pr.s - base.s;
      e.exc = e.gain - (dist + (base === from ? 0 : from.hopDist));
      e.dLat = pr.d - base.d;
      var pm = R.project((p.x + from.x) / 2, (p.y + from.y) / 2, Math.min(lo, from.s), Math.max(pr.s, from.s) + 2, 0);
      e.cut = pm ? pm.d - Math.max(pr.d, from.d) : 0;
      e.cont = contAngle(m, pr.s, from.id);
      e.revisit = recentRevisit(m.id, pr.s);
      e.valid = !e.revisit && !suspect[m.id] && dist >= C.aliasM && e.gain >= (sFrom != null ? 0 : C.minGainM) &&
        e.d <= C.latMaxM && e.dLat <= C.dLatMaxM && e.exc <= C.excMaxM && e.cut <= C.cutMaxM;
      e.score = Math.min(e.gain, C.gainCapM) -
        C.wLat0 * e.d - C.wLat * Math.max(0, e.d - C.latSoftM) -
        C.wDLat * Math.max(0, e.dLat) -
        C.wCut * Math.max(0, e.cut - C.cutTolM) -
        C.wExc * Math.max(0, e.exc - C.excTolM) -
        (e.cont > C.contMaxDeg ? C.deadEndPen : C.wCont * Math.max(0, e.cont - C.contTolDeg) / 10) +
        (m.date && m.date === base.date ? C.dateBonus : 0);
      return e;
    }
    function pick(ev) {
      var best = null;
      for (var j = 0; j < ev.length; j++) {
        var e = ev[j];
        if (!e.valid) continue;
        if (!best || e.score > best.score + 1e-9 || (Math.abs(e.score - best.score) <= 1e-9 && e.d < best.d)) best = e;
      }
      return best;
    }
    function logDecision(cur, want, ev, best, phase) {
      if (!log) return;
      var c = [];
      for (var j = 0; j < ev.length; j++) {
        var e = ev[j];
        c.push({ id: e.m.id.slice(0, 10), dh: e.dh == null ? null : Math.round(e.dh), dist: r1(e.dist), gain: e.gain == null ? null : r1(e.gain),
          d: e.d == null ? null : r1(e.d), dLat: e.dLat == null ? null : r1(e.dLat), exc: e.exc == null ? null : r1(e.exc),
          cut: e.cut == null ? null : r1(e.cut), cont: e.cont == null ? null : Math.round(e.cont), rv: !!e.revisit,
          score: r1(e.score), ok: e.valid, date: e.m.date });
      }
      log.push({ i: chain.length, phase: phase, at: cur.id.slice(0, 10), s: r1(cur.s), d: r1(cur.d), want: Math.round(want),
        links: cur.links.length, cands: c, chose: best ? best.m.id.slice(0, 10) : null });
    }
    function fetchMany(ids, cb) {
      var out = new Array(ids.length), left = ids.length;
      if (!left) { defer(function () { cb(out); }); return; }
      for (var j = 0; j < ids.length; j++) {
        (function (jj) {
          meta.byId(ids[jj], function (m) { out[jj] = m; if (--left === 0) cb(out); });
        })(j);
      }
    }
    /* `from`: where the hop starts (for the glitch test of its link); `gl` adds the legs of a hidden pano. */
    function nodeOf(e, how, from, gl) {
      return { id: e.m.id, lat: e.m.lat, lng: e.m.lng, x: e.x, y: e.y, s: e.s, d: e.d, date: e.m.date,
        links: e.m.links, how: how, jump: false, gapM: 0, linkHeading: e.linkHeading,
        gl: gl != null ? gl : (from ? glitch(from.x, from.y, e.x, e.y, e.linkHeading) : 0) };
    }
    function forwardLinks(from, want, seen, out) {
      for (var j = 0; j < from.links.length; j++) {
        var L = from.links[j];
        if (seen[L.pano]) continue;
        seen[L.pano] = 1;
        if (Math.abs(angDiff(L.heading, want)) <= C.angleMaxDeg) { out.ids.push(L.pano); out.heads.push(L.heading); }
      }
      return out;
    }

    var next = safe(function () {
      var cur = chain[chain.length - 1];
      if (cur.s >= R.total - C.finishTolM) return finishWalk("end");
      if (chain.length > maxHops) return finishWalk("max-hops");
      if (C.maxAhead > 0 && (chain.length - 1 - cursor) >= C.maxAhead) { parked = next; return; }
      var want = wantFrom(cur.x, cur.y, cur.s);
      var seen = {};
      seen[cur.id] = 1;
      var fl = forwardLinks(cur, want, seen, { ids: [], heads: [] });
      if (!fl.ids.length) { logDecision(cur, want, [], null, "no-link"); return anchor(cur, "no-forward-link"); }
      fetchMany(fl.ids, safe(function (metas) {
        var ev = [], aliases = [];
        for (var k = 0; k < metas.length; k++) {
          if (!metas[k]) continue;
          var e = evalCand(cur, metas[k], fl.heads[k], want);
          ev.push(e);
          if (e.dist < C.aliasM) aliases.push(metas[k]);
        }
        var best = pick(ev);
        logDecision(cur, want, ev, best, "links");
        if (best && best.score >= C.confidentScore) {
          var rival = forkRival(ev, best, cur);
          if (rival) return forkLook(cur, best, rival);
          push(nodeOf(best, "link", cur)); return defer(next);
        }
        if (aliases.length && !best) return expandAliases(cur, want, aliases, seen, ev);
        bridge(cur, ev, seen, best);
      }));
    });

    /* Fork rule. The best link leaves the tip's capture run for another date while a valid link that keeps the run
       parts from it (headings forkDeg or more apart) and scores within forkMargin: a Y junction where the one-hop score
       cannot tell the arms apart, and the longer link wins on progress even up the wrong road (R-C at Colborne Lodge
       Dr: West Rd, 2021-11, 192 deg, 19.9 m, beat the 2026-05 run on along Colborne Lodge Dr at 162 deg, 9.7 m, with
       the route at 163; the chain drifted 22 m off and needed a cut back). Look one hop down each arm and take the one
       whose two hops score best. Keeping the run is the condition: at a fork inside one run, or one the best link
       continues, the extra hop of look-ahead chose worse as often as better (x1 London: a 22 m gap later). */
    function forkRival(ev, best, cur) {
      var r = null;
      if (!cur.date || best.m.date === cur.date) return null;
      for (var j = 0; j < ev.length; j++) {
        var e = ev[j];
        if (e === best || !e.valid || e.m.date !== cur.date || best.score - e.score > C.forkMargin) continue;
        if (e.linkHeading == null || best.linkHeading == null || Math.abs(angDiff(e.linkHeading, best.linkHeading)) < C.forkDeg) continue;
        if (!r || e.score > r.score) r = e;
      }
      return r;
    }
    function forkLook(cur, best, rival) {
      var B = [best, rival], ids = [], heads = [], owner = [], j, k;
      for (j = 0; j < 2; j++) {
        var b = B[j], sn = {};
        b.node = { id: b.m.id, x: b.x, y: b.y, s: Math.max(b.s, cur.s), d: b.d, date: b.m.date, links: b.m.links };
        sn[cur.id] = 1; sn[best.m.id] = 1; sn[rival.m.id] = 1;
        var fl = forwardLinks(b.m, wantFrom(b.x, b.y, b.node.s), sn, { ids: [], heads: [] });
        for (k = 0; k < fl.ids.length; k++) { ids.push(fl.ids[k]); heads.push(fl.heads[k]); owner.push(j); }
      }
      fetchMany(ids, safe(function (metas) {
        var nx = [null, null];
        for (var q = 0; q < metas.length; q++) {
          if (!metas[q]) continue;
          var bb = B[owner[q]], g = evalCand(bb.node, metas[q], heads[q], wantFrom(bb.x, bb.y, bb.node.s));
          if (g.valid && (!nx[owner[q]] || g.score > nx[owner[q]].score)) nx[owner[q]] = g;
        }
        var v0 = best.score + (nx[0] ? nx[0].score : -C.deadEndPen), v1 = rival.score + (nx[1] ? nx[1].score : -C.deadEndPen);
        var win = v1 > v0 + 1e-9 ? rival : best;
        stats.forks++;
        if (log) log.push({ i: chain.length, phase: "fork", at: cur.id.slice(0, 10), best: best.m.id.slice(0, 10),
          rival: rival.m.id.slice(0, 10), v: [r1(v0), r1(v1)], chose: win.m.id.slice(0, 10) });
        push(nodeOf(win, "link", cur));
        defer(next);
      }));
    }

    function uturnNear(cur) {
      var M = R.maneuvers;
      for (var k = 0; k < M.length; k++) {
        if (uDone[k] || !isUturn(M[k])) continue;
        if (M[k].s > cur.s + C.uturnLookM) return null;
        if (M[k].s >= cur.s - C.uturnPastM) return M[k];
      }
      return null;
    }
    /* U-turn rule. The regular step found no valid hop and a U-turn is close: first walk on to the pano nearest
       the turn point (each approach hop gets >= uturnGainM closer and stays on the route before the turn), then
       turn around there on a link projected onto the leg AFTER the turn. Only when neither works does the old
       re-anchor run (`fallback`). */
    function uturnStep(cur, U, fallback) {
      var pt = R.line0.pointAt(U.s0), dCur = hyp(cur.x - pt.x, cur.y - pt.y), ids = [], heads = [], j;
      for (j = 0; j < cur.links.length; j++) { ids.push(cur.links[j].pano); heads.push(cur.links[j].heading); }
      if (!ids.length) { uDone[U.k] = 1; return fallback(); }
      fetchMany(ids, safe(function (metas) {
        var lo0 = Math.max(0, U.s0 - C.uturnSpanM), c0 = R.line0.project(cur.x, cur.y, lo0, U.s0, 0), best = null, k;
        for (k = 0; k < metas.length; k++) {
          var m = metas[k];
          if (!m || m.id === cur.id || suspect[m.id] || Object.prototype.hasOwnProperty.call(visited, m.id)) continue;
          var p = R.fwd(m.lat, m.lng), dm = hyp(p.x - pt.x, p.y - pt.y);
          if (hyp(p.x - cur.x, p.y - cur.y) < C.aliasM || dm > dCur - C.uturnGainM) continue;
          var q = R.line0.project(p.x, p.y, lo0, U.s0, 0);
          if (!q || q.d > C.latMaxM || (c0 && (q.s < c0.s - 1 || q.d - c0.d > C.dLatMaxM))) continue;
          if (!best || dm < best.dm) best = { m: m, x: p.x, y: p.y, dm: dm, d0: q.d, head: heads[k] };
        }
        if (best) {
          var hi = Math.max(cur.s, U.s), pr = R.project(best.x, best.y, cur.s - C.backTolM, hi, 0);
          if (log) log.push({ i: chain.length, phase: "uturn-approach", at: cur.id.slice(0, 10), chose: best.m.id.slice(0, 10),
            dTurn: r1(best.dm), dCur: r1(dCur), uS: r1(U.s) });
          push({ id: best.m.id, lat: best.m.lat, lng: best.m.lng, x: best.x, y: best.y, s: pr ? Math.min(Math.max(pr.s, cur.s), hi) : cur.s,
            d: pr ? pr.d : best.d0, date: best.m.date, links: best.m.links, how: "link", jump: false, gapM: 0,
            linkHeading: best.head, gl: glitch(cur.x, cur.y, best.x, best.y, best.head) });
          return defer(next);
        }
        if (dCur <= C.uturnReachM) {
          var ev = [], back = R.bearingAt(U.s + 1);
          for (k = 0; k < metas.length; k++) if (metas[k]) ev.push(evalCand(cur, metas[k], heads[k], back, null, U.s));
          var bt = pick(ev);
          logDecision(cur, back, ev, bt, "uturn");
          if (bt) { uDone[U.k] = 1; uFloor = U.s; stats.uturns++; push(nodeOf(bt, "link", cur)); return defer(next); }
        }
        uDone[U.k] = 1;
        fallback();
      }));
    }

    /* A linked pano at (almost) the same spot — an alternate-date or duplicate capture — is
       not a move; consider ITS links as if they were the current pano's (one level). */
    function expandAliases(cur, want, aliases, seen, ev0) {
      var fl = { ids: [], heads: [] };
      for (var j = 0; j < aliases.length; j++) { seen[aliases[j].id] = 1; forwardLinks(aliases[j], want, seen, fl); }
      if (!fl.ids.length) return bridge(cur, ev0, seen, null);
      fetchMany(fl.ids, safe(function (metas) {
        var ev = [];
        for (var q = 0; q < metas.length; q++) if (metas[q]) ev.push(evalCand(cur, metas[q], fl.heads[q], want));
        var best = pick(ev);
        logDecision(cur, want, ev, best, "alias");
        if (best) { push(nodeOf(best, "alias", cur)); return defer(next); }
        bridge(cur, ev0.concat(ev), seen, null);
      }));
    }

    /* Depth-2 search. With no valid hop: a pano sitting sideways in a wide intersection (a
       sidewalk-routed turn) may still lead on. With only a weak hop: check whether a 2-hop path
       is clearly better. Either way go through the intermediate only if ITS link reaches a
       valid hop; skip showing it if it steps sideways off the route. */
    function bridge(cur, ev, seen, single) {
      var bs = [], j;
      function fallback() {
        if (single) { push(nodeOf(single, "link", cur)); return defer(next); }
        anchor(cur, "no-valid-link");
      }
      for (j = 0; j < ev.length; j++) {
        var e = ev[j];
        if (e.s == null || e.dist < C.aliasM || e.dist > C.bridgeMaxM || e.gain < -C.bridgeBackM ||
            e.d > C.latMaxM + 4 || e.cut > C.cutMaxM || e.cont > C.contMaxDeg || e.revisit || suspect[e.m.id]) continue;
        bs.push(e);
      }
      bs.sort(function (a, b) { return b.score - a.score; });
      bs = bs.slice(0, C.bridgeTop);
      if (!bs.length) return fallback();
      var ids = [], heads = [], owner = [];
      for (j = 0; j < bs.length; j++) {
        var b = bs[j];
        b.node = { id: b.m.id, x: b.x, y: b.y, s: Math.max(b.s, cur.s), d: b.d, date: b.m.date, links: b.m.links, hopDist: b.dist };
        var fl = forwardLinks(b.m, wantFrom(b.x, b.y, b.node.s), seen, { ids: [], heads: [] });
        for (var k = 0; k < fl.ids.length; k++) { ids.push(fl.ids[k]); heads.push(fl.heads[k]); owner.push(j); }
      }
      if (!ids.length) return fallback();
      fetchMany(ids, safe(function (metas) {
        var best = null, bestB = null, ev2 = [];
        for (var q = 0; q < metas.length; q++) {
          if (!metas[q]) continue;
          var bb = bs[owner[q]];
          var g = evalCand(bb.node, metas[q], heads[q], wantFrom(bb.x, bb.y, bb.node.s), cur);
          g.valid = g.valid && g.gain >= 2 * C.minGainM;
          g.score -= C.bridgePen;
          ev2.push(g);
          if (g.valid && (!best || g.score > best.score)) { best = g; bestB = bb; }
        }
        logDecision(cur, 0, ev2, best, single ? "lookahead" : "bridge");
        if (!best || (single && bestB !== single && best.score <= single.score + C.bridgeMargin)) return fallback();
        if (single) stats.lookaheads++;
        var sideStep = bestB !== single && (bestB.d > C.latMaxM || (bestB.d - cur.d) > C.dLatMaxM || bestB.cut > C.cutMaxM);
        if (!sideStep) push(nodeOf(bestB, bestB === single ? "link" : "bridge", cur));
        var nd = sideStep ? nodeOf(best, "skip", null, glitch(cur.x, cur.y, bestB.x, bestB.y, bestB.linkHeading) +
          glitch(bestB.x, bestB.y, best.x, best.y, best.linkHeading)) : nodeOf(best, "link", bestB);
        if (sideStep) nd.via = bestB.m.id;          // the hidden pano: a dropped detour lists it in "avoid" too
        push(nd);
        defer(next);
      }));
    }

    function hasAlignedLink(m, routeBrg, maxDeg) {
      for (var j = 0; j < m.links.length; j++) {
        if (Math.abs(angDiff(m.links[j].heading, routeBrg)) <= maxDeg) return true;
      }
      return false;
    }
    function anchorOffsets(fromS, isStart) {
      var out = [], base = isStart ? C.startOffsets : C.anchorFirst, k, s;
      for (k = 0; k < base.length; k++) { s = fromS + base[k]; if (s > R.total) break; out.push(s); }
      for (s = fromS + base[base.length - 1] + C.anchorStepM; s < R.total; s += C.anchorStepM) out.push(s);
      if (!out.length || out[out.length - 1] < R.total - 1) out.push(R.total);
      return out;
    }
    /* No valid hop from cur: a U-turn close ahead gets the approach-then-turn-around step first. */
    function anchor(cur, reason) {
      var U = cur ? uturnNear(cur) : null;
      if (U) return uturnStep(cur, U, function () { anchorAt(cur, reason); });
      anchorAt(cur, reason);
    }
    /* Re-anchor (start, dead end, gap): free location lookups at route points ahead of fromS,
       a batch of `concurrency` at a time; the first pano that projects forward, close to the
       route, is not a replay, and has a link along the route wins. */
    function anchorAt(cur, reason) {
      var isStart = !cur;
      var fromS = cur ? cur.s : 0;
      var offs = anchorOffsets(fromS, isStart);
      var bi = 0;
      stats.anchors++;
      var batch = safe(function () {
        var sl = offs.slice(bi, bi + C.concurrency);
        bi += sl.length;
        if (!sl.length) return finishWalk(isStart ? "no-coverage" : "gap-to-end");
        var res = new Array(sl.length), left = sl.length;
        var decide = safe(function () {
          for (var j = 0; j < sl.length; j++) {
            var m = res[j];
            if (!m || (cur && m.id === cur.id) || suspect[m.id]) continue;
            var p = R.fwd(m.lat, m.lng);
            var lo = isStart ? 0 : fromS + C.minGainM;
            var hi = Math.min(R.total, sl[j] + C.anchorRadiusM + 10);
            var pr = R.project(p.x, p.y, lo, hi, C.lambda);
            if (!pr || pr.d > C.anchorLatMaxM || recentRevisit(m.id, pr.s)) continue;
            var nearEnd = pr.s >= R.total - C.finishTolM - 10;
            if (!nearEnd && !hasAlignedLink(m, R.bearingAt(pr.s), C.anchorAlignDeg)) continue;
            if (log) log.push({ i: chain.length, phase: isStart ? "start" : "anchor", reason: reason, fromS: r1(fromS),
              at: r1(sl[j]), chose: m.id.slice(0, 10), s: r1(pr.s), d: r1(pr.d) });
            push({ id: m.id, lat: m.lat, lng: m.lng, x: p.x, y: p.y, s: pr.s, d: pr.d, date: m.date, links: m.links,
              how: isStart ? "start" : "anchor", jump: !isStart, gapM: isStart ? 0 : pr.s - fromS, reason: reason, linkHeading: null });
            defer(next);
            return;
          }
          batch();
        });
        for (var j = 0; j < sl.length; j++) {
          (function (jj) {
            var pt = R.pointAt(sl[jj]), ll = R.inv(pt.x, pt.y);
            meta.near(ll.lat, ll.lng, C.anchorRadiusM, function (m) { res[jj] = m; if (--left === 0) decide(); });
          })(j);
        }
      });
      batch();
    }

    defer(safe(function () {
      try {
        onStart({ totalM: r1(R.total), totalOrigM: r1(R.total0), maneuvers: R.maneuvers.map(function (m) {
          var ll = R.inv(m.x, m.y);
          return { k: m.k, s: r1(m.s), s0: r1(m.s0), lat: ll.lat, lng: ll.lng, kind: m.kind, turnDeg: Math.round(m.turnDeg),
            netDeg: Math.round(m.netDeg), major: m.major, maneuver: m.maneuver, leg: m.leg, instructions: m.instructions };
        }), stops: R.stops.map(function (s) { var ll = R.inv(s.x, s.y); return { k: s.k, s: r1(s.s), s0: r1(s.s0), lat: ll.lat, lng: ll.lng }; }) });
      } catch (e) { /* ignore */ }
      anchor(null, "start");
    }));
    return ctl;
  }

  rrStreetWalk.DEFAULTS = DEFAULTS;
  rrStreetWalk.version = "final";
  rrStreetWalk.build = "r3-fork-avoid";
  root.rrStreetWalk = rrStreetWalk;
})(typeof window !== "undefined" ? window : this);
