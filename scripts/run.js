/* ============================================================
   RunRoute — live run guidance (run.js)
   Pre-run check dialog, geolocation watch + route snapping,
   voice cues, wake lock, GPS state banners, end-run summary.
   Spec §6. Exposes window.RRRun = { open, retheme }.

   PRIVACY: GPS fixes live in memory only — nothing from the
   watch is ever written to localStorage.
   ============================================================ */

"use strict";

window.RRRun = (function () {

  var LIGHT_FILL = "#4353f0";
  var DARK_FILL = "#8e99ff";
  var GPS_SEARCHING = "Searching for GPS…";
  var GPS_WEAK = "Weak GPS signal";

  var preBound = false;     // pre-run dialog handlers bound
  var sumBound = false;     // summary dialog handlers bound
  var runUiBound = false;   // run UI handlers bound
  var openSaveAfter = false;

  var st = null;            // per-run state; null when idle

  /* ---------------- voice preference (rr-voice) ---------------- */

  function voicePref() {
    try { return localStorage.getItem("rr-voice") !== "0"; } catch (e) { return true; }
  }

  function setVoicePref(on) {
    try {
      if (on) localStorage.removeItem("rr-voice");
      else localStorage.setItem("rr-voice", "0");
    } catch (e) { /* storage unavailable */ }
  }

  function paintVoiceBtn(btn, on) {
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Voice cues on" : "Voice cues off");
  }

  /* ---------------- speech (FIFO, one utterance at a time) ---------------- */

  var speechQ = [];
  var speaking = false;
  var lastCueAt = {};

  function speechOk() {
    return typeof window.speechSynthesis !== "undefined" &&
           typeof window.SpeechSynthesisUtterance !== "undefined";
  }

  function rawSpeak(text) {
    if (!st || !st.voice || !speechOk()) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = document.documentElement.lang || "en";
    speaking = true;
    var done = function () { speaking = false; setTimeout(drainSpeech, 0); };
    u.onend = done;
    u.onerror = done;
    try { window.speechSynthesis.speak(u); } catch (e) { speaking = false; }
  }

  function drainSpeech() {
    if (speaking || !speechQ.length) return;
    rawSpeak(speechQ.shift());
  }

  function speak(text) {
    if (!st || !st.voice || !speechOk()) return;
    var now = Date.now();
    if (lastCueAt[text] && now - lastCueAt[text] < 20000) return; // identical-cue suppression
    lastCueAt[text] = now;
    speechQ.push(text);
    drainSpeech();
  }

  /* Preempting never cancel()s then speak()s immediately — waits 300 ms. */
  function preemptSpeak(text) {
    if (!speechOk()) return;
    speechQ.length = 0;
    var busy = speaking;
    try { busy = busy || window.speechSynthesis.speaking; } catch (e) { /* ignore */ }
    if (busy) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      speaking = false;
      setTimeout(function () { rawSpeak(text); }, 300);
    } else {
      rawSpeak(text);
    }
  }

  function silenceSpeech() {
    speechQ.length = 0;
    speaking = false;
    try { if (speechOk()) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }

  /* ---------------- step-instruction text ---------------- */

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

  function arrowClassFor(m) {
    m = m || "";
    if (m.indexOf("uturn") !== -1) return " m-uturn";
    if (m.indexOf("slight-left") !== -1) return " m-slight-left";
    if (m.indexOf("slight-right") !== -1) return " m-slight-right";
    if (m.indexOf("left") !== -1) return " m-left";
    if (m.indexOf("right") !== -1) return " m-right";
    return ""; // unknown/absent -> straight
  }

  /* ---------------- guidance geometry ---------------- */

  function buildGuidance() {
    var dir = null;
    try { dir = RR.directionsRenderer.getDirections(); } catch (e) { return null; }
    if (!dir || !dir.routes || !dir.routes[0]) return null;
    var route = dir.routes[0];
    var legs = route.legs || [];
    if (!legs.length) return null;

    var centerLL = null;
    try { if (route.bounds) centerLL = route.bounds.getCenter(); } catch (e) { /* ignore */ }
    if (!centerLL && legs[0].start_location) centerLL = legs[0].start_location;
    if (!centerLL) return null;

    var R = 6371000;
    var lat0 = centerLL.lat() * Math.PI / 180;
    var lng0 = centerLL.lng() * Math.PI / 180;
    var cos0 = Math.cos(lat0);
    if (!cos0) cos0 = 1e-9;

    function projNum(lat, lng) {
      return {
        x: R * (lng * Math.PI / 180 - lng0) * cos0,
        y: R * (lat * Math.PI / 180 - lat0)
      };
    }
    function projLL(ll) { return projNum(ll.lat(), ll.lng()); }
    function unproject(x, y) {
      return {
        lat: (lat0 + y / R) * 180 / Math.PI,
        lng: (lng0 + x / (R * cos0)) * 180 / Math.PI
      };
    }

    var steps = [];
    var verts = [];
    var cum = 0;
    var prev = null;
    var li, si, pi;
    for (li = 0; li < legs.length; li++) {
      var lsteps = legs[li].steps || [];
      for (si = 0; si < lsteps.length; si++) {
        var step = lsteps[si];
        var idx = steps.length;
        var rec = {
          instr: stripStepHtml(step.instructions),
          maneuver: step.maneuver || "",
          startCum: cum,
          endCum: cum
        };
        var path = step.path || [];
        for (pi = 0; pi < path.length; pi++) {
          var pt = projLL(path[pi]);
          if (prev) {
            var dx = pt.x - prev.x, dy = pt.y - prev.y;
            cum += Math.sqrt(dx * dx + dy * dy);
          }
          verts.push({ x: pt.x, y: pt.y, cum: cum, step: idx });
          prev = pt;
        }
        rec.endCum = cum;
        steps.push(rec);
      }
    }
    if (!steps.length || verts.length < 2) return null;

    // Stops in optimized visit order: leg k ends at stop k; last leg ends home.
    // Names come from the visit-order snapshot taken at route time (drag-safe).
    var snap = RR.visitStops || [];
    var stops = [];
    var nStops = Math.max(0, legs.length - 1);
    for (var k = 0; k < nStops; k++) {
      var loc = legs[k].end_location;
      if (!loc) continue;
      var sp = projLL(loc);
      var name = (snap[k] && snap[k].name) ? snap[k].name : ("Stop " + (k + 1));
      stops.push({ name: String(name), x: sp.x, y: sp.y });
    }

    var homeP = null;
    if (RR.home && RR.home.location) {
      homeP = projLL(RR.home.location);
    } else if (legs[legs.length - 1].end_location) {
      homeP = projLL(legs[legs.length - 1].end_location);
    }

    return {
      steps: steps,
      verts: verts,
      total: cum,
      stops: stops,
      homeP: homeP,
      projNum: projNum,
      unproject: unproject
    };
  }

  /* Clamped point-to-segment projection over verts[from..to+1]. */
  function scan(p, from, to, minAlong) {
    var verts = st.g.verts;
    var best = null;
    for (var i = from; i <= to; i++) {
      var A = verts[i], B = verts[i + 1];
      var abx = B.x - A.x, aby = B.y - A.y;
      var len2 = abx * abx + aby * aby;
      var t = 0;
      if (len2 > 0) {
        t = ((p.x - A.x) * abx + (p.y - A.y) * aby) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      var sx = A.x + t * abx, sy = A.y + t * aby;
      var dx = p.x - sx, dy = p.y - sy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var along = A.cum + t * (B.cum - A.cum);
      if (minAlong != null && along < minAlong) continue;
      if (!best || dist < best.dist) best = { dist: dist, along: along, seg: i, x: sx, y: sy };
    }
    return best;
  }

  /* ---------------- GPS banners ---------------- */

  function showGps(msg) {
    var el = $("runGps");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (st) st.gpsMsg = msg;
  }

  function hideGps() {
    if (st) st.gpsMsg = null;
    var el = $("runGps");
    if (el) el.hidden = true;
  }

  /* ---------------- runner marker + accuracy ring ---------------- */

  function effectiveTheme() {
    try { if (window.RRTheme && RRTheme.effective) return RRTheme.effective(); } catch (e) { /* ignore */ }
    return "light";
  }

  function runnerIcon(fill) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7.5,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2.5
    };
  }

  function placeRunner(markerPos, rawPos, accuracy) {
    var fill = effectiveTheme() === "dark" ? DARK_FILL : LIGHT_FILL;
    try {
      if (!st.marker) {
        st.marker = new google.maps.Marker({
          map: RR.map,
          position: markerPos,
          zIndex: 60,
          clickable: false,
          icon: runnerIcon(fill)
        });
      } else {
        st.marker.setPosition(markerPos);
      }
      if (!st.ring) {
        st.ring = new google.maps.Circle({
          map: RR.map,
          center: rawPos,
          radius: accuracy,
          fillColor: fill,
          fillOpacity: 0.12,
          strokeWeight: 0,
          strokeOpacity: 0,
          clickable: false
        });
      } else {
        st.ring.setCenter(rawPos);
        st.ring.setRadius(accuracy);
      }
    } catch (e) { /* maps hiccup — keep running */ }
  }

  function retheme(theme) {
    if (!st || !st.active) return;
    var fill = theme === "dark" ? DARK_FILL : LIGHT_FILL;
    try {
      if (st.marker) st.marker.setIcon(runnerIcon(fill));
      if (st.ring) st.ring.setOptions({ fillColor: fill });
    } catch (e) { /* ignore */ }
  }

  /* ---------------- geolocation watch ---------------- */

  function startWatch() {
    if (!navigator.geolocation) return;
    stopWatch();
    if (!RR.run) RR.run = {};
    RR.run.watchId = navigator.geolocation.watchPosition(onFix, onFixError,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
  }

  function stopWatch() {
    if (RR.run && RR.run.watchId != null) {
      try { navigator.geolocation.clearWatch(RR.run.watchId); } catch (e) { /* ignore */ }
      RR.run.watchId = null;
    }
  }

  function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request("screen").then(
          function (lock) { if (RR.run) RR.run.wakeLock = lock; },
          function () { /* denied — banner only when unsupported */ }
        );
      }
    } catch (e) { /* ignore */ }
  }

  function releaseWakeLock() {
    try { if (RR.run && RR.run.wakeLock) RR.run.wakeLock.release(); } catch (e) { /* ignore */ }
    if (RR.run) RR.run.wakeLock = null;
  }

  function onFixError(err) {
    if (!st || !st.active || !err) return;
    if (err.code === 1) { // PERMISSION_DENIED
      stopGuidance(true);
      restoreUI();
      st = null;
      if (typeof toast === "function") toast("Location permission was revoked — run ended.");
    } else if (err.code === 3) { // TIMEOUT — watch stays alive
      showGps(GPS_SEARCHING);
    }
  }

  /* ---------------- per-fix engine ---------------- */

  function onFix(position) {
    if (!st || !st.active) return;
    var c = position && position.coords;
    if (!c) return;
    var now = Date.now();
    var acc = (typeof c.accuracy === "number" && isFinite(c.accuracy)) ? c.accuracy : 9999;

    // Weak-signal tracking on every fix received
    if (acc > 25) {
      if (!st.weakSince) st.weakSince = now;
      else if (now - st.weakSince >= 10000) showGps(GPS_WEAK);
    } else {
      st.weakSince = null;
      hideGps(); // good fix clears any GPS banner
    }

    // Accept / reject
    if (acc > (st.hasFix ? 40 : 50)) return;
    if (position.timestamp && now - position.timestamp > 5000) return; // stale
    st.hasFix = true;
    if (st.gpsMsg === GPS_SEARCHING) hideGps();

    var p = st.g.projNum(c.latitude, c.longitude);

    // Snap: window [last-5, last+30]; full scan at start and while off-route
    var segCount = st.g.verts.length - 1;
    var from = 0, to = segCount - 1;
    if (st.seg != null && !st.off) {
      from = Math.max(0, st.seg - 5);
      to = Math.min(segCount - 1, st.seg + 30);
    }
    var best = scan(p, from, to, null);
    if (!best) return;
    var deviation = best.dist;

    // Along-distance never regresses more than 30 m in one fix
    var chosen = best;
    if (st.along != null && best.along < st.along - 30) {
      var constrained = scan(p, from, to, st.along - 30);
      chosen = constrained || { dist: best.dist, along: st.along - 30, seg: st.seg, x: best.x, y: best.y };
    }
    st.seg = chosen.seg;
    var prevAlong = st.along;
    st.along = chosen.along;

    // Current speed (m/s)
    var speed = 0;
    if (typeof c.speed === "number" && isFinite(c.speed) && c.speed >= 0) {
      speed = c.speed;
    } else if (prevAlong != null && st.lastFixTime) {
      var dt = (now - st.lastFixTime) / 1000;
      if (dt > 0) speed = Math.max(0, (st.along - prevAlong) / dt);
    }
    st.speed = speed;
    st.lastFixTime = now;

    offRouteCheck(deviation, now);

    // Marker at snapped point while raw deviation <= 15 m + accuracy, else raw
    var raw = { lat: c.latitude, lng: c.longitude };
    var mpos = (deviation <= 15 + acc) ? st.g.unproject(chosen.x, chosen.y) : raw;
    placeRunner(mpos, raw, acc);

    // Follow mode: panTo throttled to 1/s
    if (st.follow && now - st.lastPan >= 1000) {
      st.lastPan = now;
      try { RR.map.panTo(mpos); } catch (e) { /* ignore */ }
    }

    advanceAndCue(p, now);
    if (st && st.active) updateHud();
  }

  function offCopy(d) {
    return "You're off route — head back to the path (" + Math.round(d) + " m).";
  }

  function offRouteCheck(dev, now) {
    var banner = $("runOffroute");
    if (st.off) {
      if (dev <= 20) {
        st.off = false;
        st.offStreak = 0;
        if (banner) banner.hidden = true;
        speak("Back on route.");
      } else {
        if (banner) { banner.textContent = offCopy(dev); banner.hidden = false; }
        if (now - st.offSpokeAt >= 30000) {
          st.offSpokeAt = now;
          speak("You're off route.");
        }
      }
      return;
    }
    if (dev > 50) {
      if (!st.offStreak) st.offFirstAt = now;
      st.offStreak++;
      if (st.offStreak >= 3 && now - st.offFirstAt >= 5000) {
        st.off = true;
        if (banner) { banner.textContent = offCopy(dev); banner.hidden = false; }
        st.offSpokeAt = now;
        speak("You're off route.");
      }
    } else {
      st.offStreak = 0;
    }
  }

  function advanceAndCue(p, now) {
    var steps = st.g.steps;
    if (!steps.length) return;

    // Silent resync when fixes were rejected across a whole step
    while (st.cur < steps.length - 1 && st.along > steps[st.cur].endCum + 50) st.cur++;

    var toEnd = steps[st.cur].endCum - st.along;
    if (st.cur < steps.length - 1) {
      if (toEnd <= 25) {
        // Now-cue + step advance
        speak(steps[st.cur + 1].instr);
        st.cur++;
      } else if (!st.preCued[st.cur + 1] && toEnd <= Math.max(60, 15 * st.speed)) {
        st.preCued[st.cur + 1] = true;
        var d = Math.max(50, Math.round(toEnd / 50) * 50);
        speak("In " + d + " meters, " + steps[st.cur + 1].instr);
      }
    }

    // Stop reached (next stop in visit order, once per stop)
    if (st.nextStop < st.g.stops.length) {
      var s = st.g.stops[st.nextStop];
      var dx = p.x - s.x, dy = p.y - s.y;
      if (Math.sqrt(dx * dx + dy * dy) <= 25) {
        st.stopsReached++;
        speak("Reached " + s.name + ". Stop " + (st.nextStop + 1) + " of " + st.g.stops.length + ".");
        st.nextStop++;
        updateNextStop();
      }
    }

    // Finish: within 30 m of home AND along > 80% of total
    if (st.g.homeP && st.along > 0.8 * st.g.total) {
      var hx = p.x - st.g.homeP.x, hy = p.y - st.g.homeP.y;
      if (Math.sqrt(hx * hx + hy * hy) <= 30) finishRun();
    }
  }

  /* ---------------- HUD ---------------- */

  function updateHud() {
    var steps = st.g.steps;
    if (!steps.length) return;
    var along = st.along || 0;
    var cur = Math.min(st.cur, steps.length - 1);
    var toEnd = Math.max(0, steps[cur].endCum - along);
    var upcoming = steps[cur + 1] || steps[cur];
    var el;
    el = $("runDist"); if (el) el.textContent = fmtShortDist(toEnd);
    el = $("runInstr"); if (el) el.textContent = upcoming.instr;
    el = $("runArrow"); if (el) el.className = "run-arrow" + arrowClassFor(steps[cur + 1] ? upcoming.maneuver : "");
    var remain = Math.max(0, st.g.total - along);
    el = $("runRemain"); if (el) el.textContent = fmtShortDist(remain);
    el = $("runToGo"); if (el) el.textContent = fmtDuration((remain / 1000) * (RR.paceSecPerKm || 360));
  }

  function updateNextStop() {
    var el = $("runNext");
    if (!el) return;
    var n = st.g.stops.length;
    if (st.nextStop < n) {
      el.textContent = "Next stop: " + st.g.stops[st.nextStop].name + " (" + (st.nextStop + 1) + " of " + n + ")";
    } else {
      el.textContent = "";
    }
  }

  /* ---------------- run lifecycle ---------------- */

  function buildState(g) {
    st = {
      active: true, ended: false, g: g,
      cur: 0, along: null, seg: null, hasFix: false,
      speed: 0, lastFixTime: 0, lastPan: 0, follow: true,
      preCued: [], nextStop: 0, stopsReached: 0,
      off: false, offStreak: 0, offFirstAt: 0, offSpokeAt: 0,
      weakSince: null, gpsMsg: null,
      startedAt: Date.now(), endedAt: 0,
      marker: null, ring: null, dragListener: null,
      elapsedTimer: null, endTimer: null, endArmed: false, resumeBtn: null,
      voice: voicePref()
    };
    if (!RR.run) RR.run = {};
    RR.run.active = true;
    speechQ.length = 0;
    lastCueAt = {};
  }

  function enterRunUI() {
    if (isMobile() && window.RRSheet && RRSheet.setState) {
      try { RRSheet.setState("peek"); } catch (e) { /* ignore */ }
    }
    document.body.classList.add("run-active");
    var ui = $("runUI");
    if (ui) ui.hidden = false;

    try { RR.directionsRenderer.setOptions({ draggable: false }); } catch (e) { /* ignore */ }
    try { RR.map.setZoom(17); } catch (e) { /* ignore */ }
    try {
      st.dragListener = RR.map.addListener("dragstart", function () {
        if (!st || !st.active) return;
        st.follow = false;
        var rc = $("runRecenter");
        if (rc) rc.hidden = false;
      });
    } catch (e) { /* ignore */ }

    if (!("wakeLock" in navigator)) {
      var wb = $("runWake");
      if (wb) {
        wb.textContent = "Keep your screen on — guidance pauses if the phone locks.";
        wb.hidden = false;
      }
    }

    bindRunUI();
    paintVoiceBtn($("runVoiceBtn"), st.voice);
    resetEndButton();
    updateNextStop();
    updateHud();

    var et = $("runElapsed");
    if (et) et.textContent = "0:00";
    st.elapsedTimer = setInterval(function () {
      if (!st || !st.active) return;
      var el = $("runElapsed");
      if (el) el.textContent = fmtClock((Date.now() - st.startedAt) / 1000);
    }, 1000);
  }

  function bindRunUI() {
    if (runUiBound) return;
    runUiBound = true;
    var rc = $("runRecenter");
    if (rc) rc.addEventListener("click", function () {
      if (!st || !st.active) return;
      st.follow = true;
      rc.hidden = true;
      try {
        if (st.marker) { RR.map.panTo(st.marker.getPosition()); st.lastPan = Date.now(); }
      } catch (e) { /* ignore */ }
    });
    var vb = $("runVoiceBtn");
    if (vb) vb.addEventListener("click", function () {
      if (!st) return;
      st.voice = !st.voice;
      setVoicePref(st.voice);
      paintVoiceBtn(vb, st.voice);
      if (!st.voice) silenceSpeech(); // skip speaking, keep banners
    });
    var eb = $("runEndBtn");
    if (eb) eb.addEventListener("click", onEndTap);
  }

  function onEndTap() {
    if (!st || !st.active) return;
    var eb = $("runEndBtn");
    if (!eb) return;
    if (!st.endArmed) {
      st.endArmed = true;
      eb.textContent = "End run?";
      var resume = document.createElement("button");
      resume.type = "button";
      resume.className = "pill-btn secondary";
      resume.textContent = "Resume";
      resume.addEventListener("click", function () { resetEndButton(); });
      st.resumeBtn = resume;
      if (eb.parentNode) eb.parentNode.insertBefore(resume, eb);
      st.endTimer = setTimeout(function () { resetEndButton(); }, 5000);
    } else {
      confirmEnd();
    }
  }

  function resetEndButton() {
    if (st) {
      st.endArmed = false;
      if (st.endTimer) { clearTimeout(st.endTimer); st.endTimer = null; }
      if (st.resumeBtn && st.resumeBtn.parentNode) st.resumeBtn.parentNode.removeChild(st.resumeBtn);
      st.resumeBtn = null;
    }
    var eb = $("runEndBtn");
    if (eb) eb.textContent = "End";
  }

  function confirmEnd() {
    if (!st || !st.active) return;
    stopGuidance(true);
    showSummary();
  }

  function finishRun() {
    if (!st || !st.active || st.ended) return;
    var along = st.along || 0;
    var elapsed = (Date.now() - st.startedAt) / 1000;
    var msg = "Run complete. " + (along / 1000).toFixed(1) + " kilometers in " + fmtClock(elapsed) + ".";
    stopGuidance(false); // keep speech alive for the final cue
    preemptSpeak(msg);
    showSummary();
  }

  function stopGuidance(cancelSpeech) {
    if (!st) return;
    st.active = false;
    st.ended = true;
    st.endedAt = Date.now();
    if (RR.run) RR.run.active = false;
    stopWatch();
    releaseWakeLock();
    if (st.elapsedTimer) { clearInterval(st.elapsedTimer); st.elapsedTimer = null; }
    if (st.endTimer) { clearTimeout(st.endTimer); st.endTimer = null; }
    if (st.dragListener) {
      try { google.maps.event.removeListener(st.dragListener); } catch (e) { /* ignore */ }
      st.dragListener = null;
    }
    if (st.marker) { try { st.marker.setMap(null); } catch (e) { /* ignore */ } st.marker = null; }
    if (st.ring) { try { st.ring.setMap(null); } catch (e) { /* ignore */ } st.ring = null; }
    if (cancelSpeech) silenceSpeech();
  }

  function restoreUI() {
    document.body.classList.remove("run-active");
    var ui = $("runUI");
    if (ui) ui.hidden = true;
    var ids = ["runOffroute", "runGps", "runWake", "runRecenter"];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.hidden = true;
    }
    resetEndButton();
    try { RR.directionsRenderer.setOptions({ draggable: true }); } catch (e) { /* ignore */ }
  }

  /* ---------------- summary dialog ---------------- */

  function bindSummary() {
    if (sumBound) return;
    sumBound = true;
    var dlg = $("runSummary");
    if (!dlg) return;
    var done = $("sumDone");
    if (done) done.addEventListener("click", function () {
      try { if (dlg.open) dlg.close(); } catch (e) { /* ignore */ }
    });
    var save = $("sumSave");
    if (save) save.addEventListener("click", function () {
      openSaveAfter = true;
      try { if (dlg.open) dlg.close(); } catch (e) { /* ignore */ }
    });
    dlg.addEventListener("close", function () {
      restoreUI();
      st = null;
      if (openSaveAfter) {
        openSaveAfter = false;
        if (window.RRStore && RRStore.openSaveDialog) {
          try { RRStore.openSaveDialog(); } catch (e) { /* ignore */ }
        }
      }
    });
  }

  function showSummary() {
    var dlg = $("runSummary");
    if (!dlg || typeof dlg.showModal !== "function") {
      restoreUI();
      st = null;
      return;
    }
    bindSummary();
    var along = st ? (st.along || 0) : 0;
    var elapsed = st ? Math.max(0, (st.endedAt - st.startedAt) / 1000) : 0;
    var km = along / 1000;
    var el;
    el = $("sumDist"); if (el) el.textContent = km.toFixed(2) + " km";
    el = $("sumTime"); if (el) el.textContent = fmtClock(elapsed);
    el = $("sumPace");
    if (el) {
      if (km >= 0.01 && elapsed > 0) {
        var pace = Math.round(elapsed / km);
        var pm = Math.floor(pace / 60), ps = pace % 60;
        el.textContent = pm + ":" + (ps < 10 ? "0" : "") + ps + " /km";
      } else {
        el.textContent = "—";
      }
    }
    el = $("sumStops");
    if (el) el.textContent = (st ? st.stopsReached : 0) + " of " + (st && st.g ? st.g.stops.length : 0);
    var save = $("sumSave");
    if (save) save.hidden = !!RR.loadedRouteId;
    try { dlg.showModal(); } catch (e) { restoreUI(); st = null; }
  }

  /* ---------------- pre-run dialog ---------------- */

  function routeName() {
    if (RR.loadedRouteId) {
      try {
        var raw = localStorage.getItem("runroute_saved_v1");
        if (raw) {
          var arr = JSON.parse(raw);
          if (arr && arr.length) {
            for (var i = 0; i < arr.length; i++) {
              if (arr[i] && arr[i].id === RR.loadedRouteId && arr[i].name) return String(arr[i].name);
            }
          }
        }
      } catch (e) { /* corrupt or unavailable — fall through */ }
    }
    return "Running loop";
  }

  function applyPermState(state) {
    var body = $("preBody"), denied = $("preDenied");
    if (!body || !denied) return;
    var isDenied = state === "denied";
    body.hidden = isDenied;
    denied.hidden = !isDenied;
  }

  function queryPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "geolocation" }).then(
          function (status) {
            applyPermState(status.state);
            try {
              status.onchange = function () { applyPermState(status.state); };
            } catch (e) { /* ignore */ }
          },
          function () { applyPermState("prompt"); }
        );
        return;
      }
    } catch (e) { /* throw => treat as prompt */ }
    applyPermState("prompt");
  }

  function bindPrecheck() {
    if (preBound) return;
    preBound = true;
    var dlg = $("runPrecheck");
    function closeDlg() {
      try { if (dlg && dlg.open) dlg.close(); } catch (e) { /* ignore */ }
    }
    var el;
    el = $("preCancel"); if (el) el.addEventListener("click", closeDlg);
    el = $("preClose"); if (el) el.addEventListener("click", closeDlg);
    el = $("preToSim");
    if (el) el.addEventListener("click", function () {
      closeDlg();
      if (window.RRSim && RRSim.open) { try { RRSim.open(); } catch (e) { /* ignore */ } }
    });
    el = $("preVoice");
    if (el) el.addEventListener("click", function () {
      var on = !voicePref();
      setVoicePref(on);
      paintVoiceBtn(el, on);
    });
    el = $("preStart");
    if (el) el.addEventListener("click", function () {
      if (st && st.active) return;
      var g = buildGuidance();
      if (!g) {
        closeDlg();
        if (typeof toast === "function") toast("Build a route first.");
        return;
      }
      buildState(g);
      // §6.3 trusted-gesture sequence, verbatim discipline:
      try {
        if (speechOk()) {
          var u = new SpeechSynthesisUtterance(" "); // single space, NOT empty string
          u.volume = 0;
          window.speechSynthesis.speak(u);           // unlocks iOS + Chromium speech
        }
      } catch (e) { /* ignore */ }
      requestWakeLock();                             // -> RR.run.wakeLock when granted
      startWatch();                                  // fires the geolocation prompt
      closeDlg();
      enterRunUI();
    });
  }

  function open() {
    if (typeof window.RR === "undefined" || !RR.directionsRenderer) return;
    if (st && st.active) return;
    var dir = null;
    try { dir = RR.directionsRenderer.getDirections(); } catch (e) { /* ignore */ }
    if (!RR.hasRoute || !dir || !dir.routes || !dir.routes[0]) {
      if (typeof toast === "function") toast("Build a route first.");
      return;
    }
    var dlg = $("runPrecheck");
    if (!dlg) return;
    bindPrecheck();

    var sum = $("preSummary");
    if (sum) {
      var km = (RR.routeMeters || 0) / 1000;
      sum.textContent = routeName() + " · " + km.toFixed(1) + " km · " +
        fmtDuration(km * (RR.paceSecPerKm || 360));
    }
    paintVoiceBtn($("preVoice"), voicePref());
    applyPermState("prompt"); // show the normal body until the query answers
    queryPermission();
    try { if (typeof dlg.showModal === "function" && !dlg.open) dlg.showModal(); } catch (e) { /* ignore */ }
  }

  /* ---------------- page lifecycle ---------------- */

  document.addEventListener("visibilitychange", function () {
    if (!st || !st.active) return;
    if (document.visibilityState === "visible") {
      requestWakeLock(); // re-request the lock
      startWatch();      // never trust the old watch — clearWatch + re-issue
    }
  });

  window.addEventListener("pagehide", function () {
    if (!st || !st.active) return;
    stopWatch();
    releaseWakeLock();
    silenceSpeech();
  });

  return { open: open, retheme: retheme };

})();
