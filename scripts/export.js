/* ============================================================
   RunRoute — printable directions document (spec §8)
   Builds a standalone black-on-white HTML document in a new tab
   from the current route; the user prints / saves as PDF there.
   Depends on app.js globals: RR, toast(), escapeHtml(),
   fmtShortDist(), fmtDuration(), CAT_COLOR.
   ============================================================ */

"use strict";

(function () {

  var NEUTRAL_DOT = "#8a90a6"; // cat null -> neutral gray dot

  function fmtPace(secPerKm) {
    var m = Math.floor(secPerKm / 60);
    var s = Math.round(secPerKm % 60);
    return m + ":" + (s < 10 ? "0" : "") + s + " /km";
  }

  function fmtDocDate(d) {
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return d.toDateString();
    }
  }

  /* Saved route name if the loaded route id matches a stored record. */
  function savedRouteName() {
    if (!RR.loadedRouteId) return null;
    var raw = null;
    try { raw = localStorage.getItem("runroute_saved_v1"); } catch (e) { return null; }
    if (!raw) return null;
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { return null; }
    if (!arr || !arr.length) return null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === RR.loadedRouteId && arr[i].name) return String(arr[i].name);
    }
    return null;
  }

  /* Meters for a leg or step: prefer .distance.value, fallback to path length. */
  function pathMeters(path) {
    try {
      if (path && google.maps.geometry && google.maps.geometry.spherical) {
        return google.maps.geometry.spherical.computeLength(path);
      }
    } catch (e) { /* geometry unavailable */ }
    return 0;
  }

  function legMeters(leg) {
    if (leg.distance && typeof leg.distance.value === "number") return leg.distance.value;
    var m = 0;
    if (leg.steps) {
      for (var i = 0; i < leg.steps.length; i++) m += stepMeters(leg.steps[i]);
    }
    return m;
  }

  function stepMeters(step) {
    if (step.distance && typeof step.distance.value === "number") return step.distance.value;
    return pathMeters(step.path);
  }

  function stepDistText(step) {
    if (step.distance && step.distance.text) return step.distance.text;
    var m = stepMeters(step);
    return m ? fmtShortDist(m) : "";
  }

  function dotHtml(cat) {
    var known = cat && CAT_COLOR[cat];
    var color = known ? CAT_COLOR[cat] : NEUTRAL_DOT;
    return '<span class="dot" style="background:' + color + '" aria-hidden="true"></span>' +
      (known ? '<span class="cat-label">' + escapeHtml(cat) + '</span> ' : '');
  }

  function buildDoc(route) {
    var legs = route.legs || [];
    var order = route.waypoint_order;

    /* Stops in request order (RR.selected iterates in the same insertion
       order calculateRoute() used to build waypointNames). */
    var reqStops = [];
    RR.selected.forEach(function (s) {
      reqStops.push({ name: s.name, cat: s.cat || null });
    });
    /* Names from RR.waypointNames (authoritative per §8.2); cats ride along
       by the same index when the arrays agree. */
    function stopAt(reqIdx) {
      var name = (RR.waypointNames && RR.waypointNames[reqIdx] != null)
        ? RR.waypointNames[reqIdx]
        : (reqStops[reqIdx] ? reqStops[reqIdx].name : "Stop " + (reqIdx + 1));
      var cat = reqStops[reqIdx] ? reqStops[reqIdx].cat : null;
      return { name: String(name), cat: cat };
    }

    /* Visit-order stop list: leg i (i < legs.length-1) arrives at
       stop order[i]; the final leg returns to Start. */
    var visitStops = [];
    var i;
    for (i = 0; i < legs.length - 1; i++) {
      var reqIdx = (order && order.length > i) ? order[i] : i;
      visitStops.push(stopAt(reqIdx));
    }

    var name = savedRouteName() || "Running loop";
    var totalMeters = RR.routeMeters || 0;
    if (!totalMeters) {
      for (i = 0; i < legs.length; i++) totalMeters += legMeters(legs[i]);
    }
    var km = totalMeters / 1000;
    var pace = RR.paceSecPerKm || 360;
    var address = (RR.home && RR.home.address) ? RR.home.address : "";

    var html = [];
    html.push("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    html.push("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    html.push("<title>RunRoute directions — " + escapeHtml(name) + "</title>");
    html.push("<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">");
    html.push("<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>");
    html.push("<link href=\"https://fonts.googleapis.com/css2?family=Raleway:wght@400;600;700;800&family=Montserrat+Subrayada:wght@700&display=swap\" rel=\"stylesheet\">");
    html.push("<style>");
    html.push("html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}");
    html.push("body{background:#ffffff;color:#000000;font-family:'Raleway',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:32px 36px;max-width:760px;}");
    html.push(".topline{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px;}");
    html.push(".wordmark{font-family:'Montserrat Subrayada',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;letter-spacing:1px;color:#4353f0;}");
    html.push(".print-btn{font:600 13px/1 'Raleway',Arial,sans-serif;color:#ffffff;background:#4353f0;border:none;border-radius:999px;padding:10px 18px;cursor:pointer;}");
    html.push("h1{font-size:24px;font-weight:800;margin:6px 0 2px;}");
    html.push(".meta{color:#333333;margin:0 0 2px;}");
    html.push(".start{color:#333333;margin:0 0 18px;}");
    html.push("ol.stops{margin:0 0 24px;padding-left:22px;}");
    html.push("ol.stops li{margin:3px 0;break-inside:avoid;}");
    html.push(".dot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:baseline;margin:0 5px 0 8px;}");
    html.push(".cat-label{color:#555555;font-size:12.5px;margin-right:6px;}");
    html.push(".stop-at{color:#555555;}");
    html.push("h2{font-size:15.5px;font-weight:800;margin:22px 0 6px;break-inside:avoid;break-after:avoid;display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #dddddd;padding-bottom:5px;}");
    html.push("h2 .leg-stats{font-weight:600;font-size:13px;color:#333333;white-space:nowrap;}");
    html.push("ol.steps{margin:0;padding-left:22px;font-size:13px;line-height:1.5;}");
    html.push("ol.steps li{break-inside:avoid;margin:4px 0;display:flex;justify-content:space-between;gap:14px;list-style-position:outside;}");
    html.push("ol.steps li .instr{flex:1 1 auto;min-width:0;}");
    html.push("ol.steps li .instr div{margin-top:1px;}");
    html.push("ol.steps li .d{flex:none;color:#555555;white-space:nowrap;}");
    html.push(".footer{margin-top:28px;padding-top:10px;border-top:1px solid #dddddd;font-size:12px;color:#555555;}");
    html.push("@media print{.print-btn{display:none;}body{padding:0;}}");
    html.push("</style></head><body>");

    html.push("<div class=\"topline\"><span class=\"wordmark\">RUNROUTE</span>");
    html.push("<button class=\"print-btn\" type=\"button\" onclick=\"window.print()\">Print / Save as PDF</button></div>");

    html.push("<h1>" + escapeHtml(name) + "</h1>");
    html.push("<p class=\"meta\">" + escapeHtml(fmtDocDate(new Date())) +
      " · " + km.toFixed(2) + " km (" + (km * 0.621371).toFixed(2) + " mi)" +
      " · " + escapeHtml(fmtDuration(km * pace)) + " at " + escapeHtml(fmtPace(pace)) + "</p>");
    if (address) {
      html.push("<p class=\"start\">Start &amp; finish: " + escapeHtml(address) + "</p>");
    }

    /* Stop overview, visit order, cumulative distance at each stop. */
    if (visitStops.length) {
      html.push("<ol class=\"stops\">");
      var cum = 0;
      for (i = 0; i < visitStops.length; i++) {
        cum += legMeters(legs[i]);
        html.push("<li>" + escapeHtml(visitStops[i].name) + dotHtml(visitStops[i].cat) +
          "<span class=\"stop-at\">at " + (cum / 1000).toFixed(1) + " km</span></li>");
      }
      html.push("</ol>");
    }

    /* One section per leg. */
    for (i = 0; i < legs.length; i++) {
      var leg = legs[i];
      var fromName = (i === 0) ? "Start" : visitStops[i - 1].name;
      var toName = (i === legs.length - 1) ? "back to Start"
        : (visitStops[i] ? visitStops[i].name : "Stop " + (i + 1));
      var lm = legMeters(leg);
      var legDist = (leg.distance && leg.distance.text) ? leg.distance.text : (lm ? fmtShortDist(lm) : "");
      var legTime = lm ? fmtDuration((lm / 1000) * pace) : "";
      var stats = legDist && legTime ? legDist + " · " + legTime : (legDist || legTime);

      html.push("<h2><span>Leg " + (i + 1) + " — " + escapeHtml(fromName) +
        " → " + escapeHtml(toName) + "</span>" +
        (stats ? "<span class=\"leg-stats\">" + escapeHtml(stats) + "</span>" : "") + "</h2>");

      html.push("<ol class=\"steps\">");
      var steps = leg.steps || [];
      for (var j = 0; j < steps.length; j++) {
        /* step.instructions is Google-produced HTML, injected as-is per §8.3
           (its embedded Destination <div> renders as its own line). */
        var instr = steps[j].instructions || "";
        var d = stepDistText(steps[j]);
        html.push("<li><span class=\"instr\">" + instr + "</span>" +
          (d ? "<span class=\"d\">" + escapeHtml(d) + "</span>" : "") + "</li>");
      }
      html.push("</ol>");
    }

    html.push("<p class=\"footer\">Generated by runroute.app · Walking directions are approximate — follow signs and conditions.</p>");
    html.push("</body></html>");
    return html.join("");
  }

  function openExport() {
    if (!window.RR || !RR.directionsRenderer || typeof escapeHtml !== "function") return;

    var dir = null;
    try { dir = RR.directionsRenderer.getDirections(); } catch (e) { dir = null; }
    var route = dir && dir.routes && dir.routes[0];
    if (!route || !route.legs || !route.legs.length) {
      toast("Build a route first.");
      return;
    }

    /* Synchronous open inside the click handler keeps popup blockers happy. */
    var doc = window.open("", "_blank");
    if (!doc) {
      toast("Allow pop-ups for runroute.app to export directions.");
      return;
    }

    var html;
    try {
      html = buildDoc(route);
    } catch (e) {
      try { doc.close(); } catch (e2) { /* ignore */ }
      toast("Couldn't build the directions document.");
      return;
    }

    doc.document.write(html);
    doc.document.close();
  }

  window.RRExport = { open: openExport };

})();
