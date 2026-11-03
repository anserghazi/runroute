/* ============================================================
   RunRoute — saved routes (spec §7)
   localStorage-backed saved routes: save dialog, collapsible
   list, two-step delete, fresh/stale load with the Google ToS
   30-day coordinate valve.
   Relies on app.js globals: RR, $, toast, currentRadius,
   activeTypes, clearSelections, syncSelectionUI, setHome,
   runSearch, calculateRoute, isMobile.
   ============================================================ */

"use strict";

(function () {

  var KEY = "runroute_saved_v1";
  var CORRUPT_KEY = "runroute_saved_v1_corrupt";
  var MAX_SAVED = 30;
  var FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  var TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>' +
    "</svg>";

  var persistAsked = false;
  var bound = false;
  var confirmState = null; // { id, timer, onDoc }

  /* ---------------- Storage ---------------- */

  function readSaved() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      return [];
    }
    if (raw === null || raw === "") return [];
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      rescueCorrupt(raw);
      return [];
    }
    if (Object.prototype.toString.call(parsed) !== "[object Array]") {
      rescueCorrupt(raw);
      return [];
    }
    return parsed;
  }

  function findIndexById(arr, id) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return i;
    }
    return -1;
  }

  function rescueCorrupt(raw) {
    try {
      localStorage.setItem(CORRUPT_KEY, raw);
    } catch (e) { /* storage unavailable — nothing more we can do */ }
  }

  function writeSaved(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      if (typeof toast === "function") {
        toast("Couldn't save — this browser's storage for runroute.app is full.");
      }
      return false;
    }
  }

  function askPersistOnce() {
    if (persistAsked) return;
    persistAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(null, function () { /* silent */ });
      }
    } catch (e) { /* silent */ }
  }

  function makeId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- Formatting ---------------- */

  function shortDate(d) {
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) {
      return (d.getMonth() + 1) + "/" + d.getDate();
    }
  }

  function defaultName() {
    return "Run " + shortDate(new Date());
  }

  function metaText(rec) {
    var km = ((rec.distanceM || 0) / 1000).toFixed(1) + " km";
    var n = (rec.stops && rec.stops.length) || 0;
    var stops = n + (n === 1 ? " stop" : " stops");
    var when = rec.savedAt ? shortDate(new Date(rec.savedAt)) : "";
    return km + " · " + stops + (when ? " · " + when : "");
  }

  /* ---------------- List rendering ---------------- */

  function updateCount(n) {
    var el = $("savedCount");
    if (!el) return;
    el.textContent = n ? "(" + n + ")" : "";
  }

  function expandSection() {
    var toggle = $("savedToggle");
    var listEl = $("savedList");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (listEl) listEl.hidden = false;
  }

  function clearConfirm(rerender) {
    if (!confirmState) return;
    clearTimeout(confirmState.timer);
    document.removeEventListener("click", confirmState.onDoc, true);
    confirmState = null;
    if (rerender) renderList();
  }

  function renderList() {
    var listEl = $("savedList");
    if (!listEl) return;
    var routes = readSaved();

    listEl.innerHTML = "";
    updateCount(routes.length);

    if (!routes.length) {
      var hint = document.createElement("li");
      hint.className = "hint";
      hint.textContent = "No saved routes yet. Build a loop and tap Save.";
      listEl.appendChild(hint);
      return;
    }

    var frag = document.createDocumentFragment();
    routes.forEach(function (rec) {
      if (!rec || typeof rec !== "object" || !rec.id) return;
      frag.appendChild(buildRow(rec));
    });
    listEl.appendChild(frag);
  }

  function buildRow(rec) {
    var li = document.createElement("li");
    li.className = "saved-row";
    li.dataset.id = rec.id;

    var main = document.createElement("button");
    main.className = "saved-main";
    main.type = "button";

    var nm = document.createElement("span");
    nm.className = "saved-name";
    nm.textContent = rec.name || "Running loop";

    var meta = document.createElement("span");
    meta.className = "saved-meta";
    meta.textContent = metaText(rec);

    main.appendChild(nm);
    main.appendChild(meta);
    main.addEventListener("click", function () {
      // The row may be stale (another tab, or a refresh that finished since render).
      var current = readSaved();
      var idx = findIndexById(current, rec.id);
      if (idx === -1) {
        renderList();
        if (typeof toast === "function") toast("That route is no longer saved on this device.");
        return;
      }
      loadRoute(current[idx]);
    });

    var del = document.createElement("button");
    del.className = "saved-del";
    del.type = "button";
    del.setAttribute("aria-label", "Delete saved route");
    del.innerHTML = TRASH_SVG;
    del.addEventListener("click", function () {
      if (confirmState && confirmState.id === rec.id) {
        performDelete(rec);
      } else {
        enterConfirm(rec, li, del);
      }
    });

    // Re-render while a confirm is pending keeps that row armed.
    if (confirmState && confirmState.id === rec.id) {
      li.classList.add("confirm");
      del.textContent = "Delete";
    }

    li.appendChild(main);
    li.appendChild(del);
    return li;
  }

  function enterConfirm(rec, row, btn) {
    clearConfirm(true); // revert any other armed row first
    row.classList.add("confirm");
    btn.textContent = "Delete";
    var onDoc = function (e) {
      if (!btn.contains(e.target)) clearConfirm(true);
    };
    confirmState = {
      id: rec.id,
      timer: setTimeout(function () { clearConfirm(true); }, 5000),
      onDoc: onDoc
    };
    document.addEventListener("click", onDoc, true);
  }

  function performDelete(rec) {
    clearConfirm(false);
    var current = readSaved();
    var next = [];
    current.forEach(function (r) {
      if (!r || r.id !== rec.id) next.push(r);
    });
    if (next.length !== current.length) writeSaved(next);
    if (window.RR && RR.loadedRouteId === rec.id) RR.loadedRouteId = null;
    renderList();
    if (typeof toast === "function") {
      toast("Deleted '" + (rec.name || "Running loop") + "'.");
    }
  }

  /* ---------------- Save flow ---------------- */

  function openSaveDialog() {
    if (!window.RR || typeof toast !== "function") return;
    if (!RR.hasRoute) {
      toast("Build a route first.");
      return;
    }
    var dlg = $("saveDialog");
    var input = $("saveName");
    if (!dlg || !input || typeof dlg.showModal !== "function") return;

    var name = defaultName();
    if (RR.loadedRouteId) {
      var routes = readSaved();
      for (var i = 0; i < routes.length; i++) {
        if (routes[i] && routes[i].id === RR.loadedRouteId) {
          name = routes[i].name || name;
          break;
        }
      }
    }
    input.value = name;
    if (!dlg.open) dlg.showModal();
    input.focus();
    input.select();
  }

  function doSave() {
    var dlg = $("saveDialog");
    var input = $("saveName");
    if (!window.RR || !RR.hasRoute || !RR.home) {
      if (dlg && dlg.open) dlg.close();
      return;
    }

    var routes = readSaved();
    var existingIdx = RR.loadedRouteId ? findIndexById(routes, RR.loadedRouteId) : -1;

    if (existingIdx === -1 && routes.length >= MAX_SAVED) {
      if (dlg && dlg.open) dlg.close();
      if (typeof toast === "function") {
        toast("You've hit 30 saved routes — delete one first.");
      }
      return;
    }

    var name = input ? input.value.replace(/^\s+|\s+$/g, "") : "";
    if (!name) name = defaultName();

    var now = Date.now();
    // The record's coordinate age is its oldest stop's: re-saving a loaded route
    // must not restart the 30-day Places valve (spec §7.5).
    var oldest = now;
    var stops = [];
    RR.selected.forEach(function (s) {
      if (!s || !s.location) return;
      stops.push({
        placeId: s.id,
        name: s.name,
        lat: s.location.lat(),
        lng: s.location.lng(),
        cat: s.cat || null
      });
      var at = typeof s.refreshedAt === "number" ? s.refreshedAt : now;
      if (at < oldest) oldest = at;
    });

    var label = typeof RR.home.saveLabel === "string" ? RR.home.saveLabel : RR.home.address;

    var rec = {
      id: existingIdx !== -1 ? routes[existingIdx].id : makeId(),
      name: name,
      savedAt: now,
      coordsRefreshedAt: oldest,
      home: {
        lat: RR.home.lat,
        lng: RR.home.lng,
        address: label || "",
        placeId: null
      },
      radiusM: typeof currentRadius === "function" ? currentRadius() : 0,
      types: typeof activeTypes === "function" ? activeTypes() : [],
      stops: stops,
      paceSecPerKm: RR.paceSecPerKm,
      distanceM: RR.routeMeters
    };

    if (existingIdx !== -1) routes[existingIdx] = rec;
    else routes.push(rec);

    if (dlg && dlg.open) dlg.close();

    if (!writeSaved(routes)) return; // writeSaved already toasted

    RR.loadedRouteId = rec.id;
    askPersistOnce();
    renderList();
    expandSection();
    if (typeof toast === "function") toast("Saved on this device.");
  }

  /* ---------------- Load flow (§7.5) ---------------- */

  function loadRoute(rec) {
    if (!window.RR || !rec || !rec.home) return;
    if (!window.google || !window.google.maps || !RR.map) return;
    if (RR.run && RR.run.active) {
      if (typeof toast === "function") toast("End the run to change stops.");
      return;
    }

    if (typeof clearSelections === "function") clearSelections(true);
    RR.loadedRouteId = rec.id;

    // Pace
    var sel = $("paceSelect");
    if (rec.paceSecPerKm) {
      var v = String(rec.paceSecPerKm);
      if (sel && sel.querySelector('option[value="' + v + '"]')) {
        sel.value = v;
        try { localStorage.setItem("runroute_pace", v); } catch (e) { /* ignore */ }
      }
      RR.paceSecPerKm = rec.paceSecPerKm;
    }

    // Radius
    if (rec.radiusM) {
      var ri = $("radiusInput");
      var rs = $("radiusSlider");
      if (ri) ri.value = rec.radiusM;
      if (rs) rs.value = Math.min(Math.max(rec.radiusM, 100), 3000);
    }

    // Chips
    var types = rec.types || [];
    document.querySelectorAll(".chip").forEach(function (chip) {
      chip.setAttribute(
        "aria-pressed",
        types.indexOf(chip.getAttribute("data-type")) !== -1 ? "true" : "false"
      );
    });

    // Home — preserve:true keeps the selection we are about to rebuild
    setHome(
      new google.maps.LatLng(rec.home.lat, rec.home.lng),
      rec.home.address || "",
      { preserve: true, saveLabel: rec.home.address || "" }
    );

    // No runSearch() here: a fresh load must make zero Places calls (spec §7.5).
    // Invalidate any search still in flight so it can't overwrite the stop list.
    RR.searchToken++;

    var fresh = rec.coordsRefreshedAt &&
      (Date.now() - rec.coordsRefreshedAt) <= FRESH_MS;

    if (fresh || !RR.placesService) {
      var stored = rec.stops || [];
      var missing = 0;
      stored.forEach(function (st) {
        if (st && st.placeId && (typeof st.lat !== "number" || typeof st.lng !== "number")) missing++;
      });
      applyStops(rec, stored, missing);
    } else {
      refreshStops(rec);
    }
  }

  function applyStops(rec, stops, failed) {
    if (RR.loadedRouteId !== rec.id) return; // another route was loaded/cleared meanwhile

    // Show the saved stops as the place list + colored markers straight from
    // stored data (zero API calls). Tapping a category chip searches for more.
    var refreshedAt = typeof rec.coordsRefreshedAt === "number" ? rec.coordsRefreshedAt : 0;
    RR.results.clear();
    stops.forEach(function (st) {
      if (!st || !st.placeId) return;
      if (typeof st.lat !== "number" || typeof st.lng !== "number") return; // failed refresh: placeId kept, no coords
      var loc = new google.maps.LatLng(st.lat, st.lng);
      RR.selected.set(st.placeId, {
        id: st.placeId,
        name: st.name,
        location: loc,
        cat: st.cat || null,
        refreshedAt: refreshedAt
      });
      RR.results.set(st.placeId, {
        place_id: st.placeId,
        name: st.name,
        geometry: { location: loc },
        rrCat: st.cat || null
      });
    });
    if (typeof renderResults === "function") renderResults();
    var countEl = $("placeCount");
    if (countEl && RR.results.size) countEl.textContent = "saved stops";
    var listEl = $("places");
    if (listEl && RR.results.size) {
      var hint = document.createElement("li");
      hint.className = "hint";
      hint.textContent = "Tap a category above to find more places nearby.";
      listEl.appendChild(hint);
    }

    if (RR.selected.size && typeof calculateRoute === "function") {
      calculateRoute(function (ok) {
        if (ok && typeof isMobile === "function" && isMobile() && window.RRSheet) {
          RRSheet.setState("peek");
        }
      });
    }

    if (typeof toast === "function") {
      if (failed) toast(failed + " stop(s) could no longer be found.", 4000);
      else toast("Loaded '" + (rec.name || "Running loop") + "'.");
    }
  }

  function refreshStops(rec) {
    var stops = rec.stops || [];
    if (!stops.length) {
      applyStops(rec, [], 0);
      return;
    }
    if (typeof toast === "function") toast("Refreshing stops…");

    var pending = stops.length;
    var failed = 0;
    var refreshed = new Array(stops.length);

    stops.forEach(function (st, i) {
      st = st || {};
      RR.placesService.getDetails(
        { placeId: st.placeId, fields: ["geometry", "name"] },
        function (place, status) {
          var ok = status === google.maps.places.PlacesServiceStatus.OK &&
            place && place.geometry && place.geometry.location;
          // A failed stop keeps placeId/name/cat (storable indefinitely) but drops its
          // expired coordinates, so later fresh loads exclude it (spec §7.5).
          refreshed[i] = {
            placeId: st.placeId,
            name: (ok && place.name) ? place.name : st.name,
            lat: ok ? place.geometry.location.lat() : null,
            lng: ok ? place.geometry.location.lng() : null,
            cat: st.cat || null
          };
          if (!ok) failed++;
          pending--;
          if (pending === 0) finishRefresh(rec, refreshed, failed);
        }
      );
    });
  }

  function finishRefresh(rec, refreshed, failed) {
    var at = Date.now();
    // Re-read: other tabs, deletes and saves may have changed storage while
    // getDetails was in flight. Merge only this record's stops, by id.
    var current = readSaved();
    var idx = findIndexById(current, rec.id);
    if (idx !== -1 && current[idx].savedAt === rec.savedAt) { // not re-saved meanwhile
      current[idx].stops = refreshed;
      current[idx].coordsRefreshedAt = at;
      writeSaved(current);
    }
    renderList();
    rec.stops = refreshed;
    rec.coordsRefreshedAt = at;
    applyStops(rec, refreshed, failed);
  }

  /* ---------------- Init ---------------- */

  function init() {
    if (!window.RR || typeof $ !== "function") return;

    renderList();

    if (bound) return;
    bound = true;

    // Another tab or PWA window changed the saved routes (key null = storage cleared).
    window.addEventListener("storage", function (e) {
      if (e.key === KEY || e.key === null) renderList();
    });

    var toggle = $("savedToggle");
    var listEl = $("savedList");
    if (toggle && listEl) {
      toggle.addEventListener("click", function () {
        var open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
        listEl.hidden = open;
      });
    }

    var dlg = $("saveDialog");
    var cancel = $("saveCancel");
    var confirm = $("saveConfirm");
    var input = $("saveName");
    if (cancel && dlg) {
      cancel.addEventListener("click", function () {
        if (dlg.open) dlg.close();
      });
    }
    if (confirm) confirm.addEventListener("click", doSave);
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          doSave();
        }
      });
    }
  }

  window.RRStore = {
    init: init,
    openSaveDialog: openSaveDialog
  };

})();
