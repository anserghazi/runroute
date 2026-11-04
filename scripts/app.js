/* ============================================================
   RunRoute — application core
   Search, categories, route calculation, stats, GPX, share.
   Feature modules (sheet.js, store.js, export.js, sim.js, run.js)
   build on the globals defined here: RR, RRTheme, $, toast(),
   CAT, calculateRoute(), setHome(), runSearch(), updateStats().
   ============================================================ */

"use strict";

var RR = {
  map: null,
  geocoder: null,
  placesService: null,
  directionsService: null,
  directionsRenderer: null,
  searchBox: null,
  home: null,            // { location: LatLng, address, lat, lng, saveLabel }
  typedQuery: "",        // what the user last typed into #homeloc (spec §7.2 save label)
  homeMarker: null,
  results: new Map(),    // place_id -> place (current search results)
  markers: new Map(),    // place_id -> Marker
  selected: new Map(),   // place_id -> { id, name, location, cat, refreshedAt }
  hasRoute: false,
  routeMeters: 0,
  paceSecPerKm: 360,
  searchToken: 0,
  routeToken: 0,         // invalidates in-flight Directions responses
  visitStops: [],        // selected stops in optimized VISIT order, snapshotted at route time
  restoring: false,
  mapsLoaded: false,
  loadedRouteId: null,   // id of the saved route currently loaded (store.js)
  waypointNames: [],     // stop names in route-request order (export.js)
  run: {}                // run.js scratch space
};

var MAX_WAYPOINTS = 10;
var DEFAULT_CENTER = { lat: 43.6532, lng: -79.3852 }; // Toronto

/* Canonical category mapping — JS and CSS must agree (see app.css). */
var CAT = {
  park: { key: "park", color: "#0d7f52", label: "Parks" },
  tourist_attraction: { key: "sight", color: "#dd6394", label: "Sights" },
  cafe: { key: "cafe", color: "#c98500", label: "Cafés" },
  gym: { key: "gym", color: "#0b9fd6", label: "Gyms" }
};

var CAT_COLOR = { park: "#0d7f52", sight: "#dd6394", cafe: "#c98500", gym: "#0b9fd6" };

/* Darkened category fills that carry white text at >= 4.5:1 — mirrors the light-theme
   --cat-*-fill tokens in theme.css. Used for the numbered stop badges on the map. */
var CAT_FILL = { park: "#0d7f52", sight: "#b8326a", cafe: "#8a5a00", gym: "#06729b" };

/* Map styles (legacy raster styles array — never add a mapId). */
var MAP_STYLE_BASE = [
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] }
];

var MAP_STYLE_NIGHT = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] }
].concat(MAP_STYLE_BASE);

/* ---------------- Small helpers ---------------- */

function $(id) { return document.getElementById(id); }

function toast(msg, ms) {
  var el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove("show"); }, ms || 2600);
}

function debounce(fn, ms) {
  var t;
  return function () {
    clearTimeout(t);
    var args = arguments, self = this;
    t = setTimeout(function () { fn.apply(self, args); }, ms);
  };
}

function haversineMeters(a, b) {
  var R = 6371000;
  var dLat = (b.lat - a.lat) * Math.PI / 180;
  var dLng = (b.lng - a.lng) * Math.PI / 180;
  var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtShortDist(m) {
  return m < 950 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1) + " km";
}

function fmtDuration(totalSec) {
  var min = Math.round(totalSec / 60);
  if (min < 60) return "~" + min + " min";
  var h = Math.floor(min / 60), r = min % 60;
  return "~" + h + " h " + (r < 10 ? "0" : "") + r + " min";
}

function fmtClock(totalSec) {
  totalSec = Math.max(0, Math.round(totalSec));
  var m = Math.floor(totalSec / 60), s = totalSec % 60;
  var h = Math.floor(m / 60);
  if (h) { m = m % 60; return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function isMobile() {
  return window.matchMedia && window.matchMedia("(max-width: 860px)").matches;
}

function catFromTypes(types) {
  if (!types) return null;
  var order = ["park", "tourist_attraction", "cafe", "gym"];
  for (var i = 0; i < order.length; i++) {
    if (types.indexOf(order[i]) !== -1) return CAT[order[i]].key;
  }
  return null;
}

/* ---------------- Boot ---------------- */

window.initMap = function () {
  RR.mapsLoaded = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
};

window.gm_authFailure = function () {
  showMapError(
    "The map couldn't start",
    "Google Maps rejected the site's access key. This is on us, not you — please try again later, or let us know via the contact page."
  );
};

window.addEventListener("load", function () {
  setTimeout(function () {
    if (!RR.mapsLoaded) {
      showMapError(
        "The map didn't load",
        "Google Maps couldn't be reached. Check your connection (or content blocker) and reload the page."
      );
    }
  }, 4000);
});

function showMapError(title, body) {
  var box = $("mapError");
  if (!box) return;
  box.querySelector("h2").textContent = title;
  box.querySelector("p").textContent = body;
  box.hidden = false;
}

function applyMapTheme(theme) {
  if (!RR.map) return;
  RR.map.setOptions({ styles: theme === "dark" ? MAP_STYLE_NIGHT : MAP_STYLE_BASE });
  RR.directionsRenderer.setOptions({
    polylineOptions: {
      strokeColor: theme === "dark" ? "#8e99ff" : "#4353f0",
      strokeWeight: 5,
      strokeOpacity: 0.85
    }
  });
  if (RR.hasRoute) {
    var dir = RR.directionsRenderer.getDirections();
    if (dir) RR.directionsRenderer.setDirections(dir);
  }
  // Maps JS takes backgroundColor only at construction; repaint its containers for live swaps.
  var bg = theme === "dark" ? "#242f3e" : "#e8eaf2";
  var div = RR.map.getDiv();
  if (div) {
    div.style.backgroundColor = bg;
    if (div.firstElementChild) div.firstElementChild.style.backgroundColor = bg;
  }
  if (window.RRRun && RR.run && RR.run.active && typeof window.RRRun.retheme === "function") {
    window.RRRun.retheme(theme);
  }
}

function boot() {
  RR.map = new google.maps.Map($("map"), {
    center: DEFAULT_CENTER,
    zoom: 14,
    mapTypeControl: true,
    mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
    streetViewControl: false,
    fullscreenControl: !isMobile(),
    clickableIcons: false,
    backgroundColor: (window.RRTheme && RRTheme.effective() === "dark") ? "#242f3e" : "#e8eaf2"
  });

  RR.geocoder = new google.maps.Geocoder();
  RR.placesService = new google.maps.places.PlacesService(RR.map);
  RR.directionsService = new google.maps.DirectionsService();
  // The renderer's own A/B/C pins sat on top of our stop markers and hid the line; stops
  // are drawn as numbered badges (markerIcon) and RR.homeMarker is the start/finish. The
  // pins are made invisible and inert through markerOptions rather than suppressMarkers:
  // suppressMarkers also removes the white via-point handle a line drag leaves behind,
  // and without it a dragged route can never be re-adjusted. clickable/draggable false
  // keep the invisible pins from catching taps meant for the stop badges.
  RR.directionsRenderer = new google.maps.DirectionsRenderer({
    draggable: true,
    preserveViewport: true,
    markerOptions: { opacity: 0, clickable: false, draggable: false, zIndex: 1 }
  });

  RR.directionsRenderer.addListener("directions_changed", updateStats);

  // Marker size follows zoom and phone/desktop layout.
  RR.map.addListener("zoom_changed", refreshMarkers);
  trackAutoFit();
  if (window.matchMedia) {
    var mobileMql = window.matchMedia("(max-width: 860px)");
    if (mobileMql.addEventListener) mobileMql.addEventListener("change", refreshMarkers);
    else if (mobileMql.addListener) mobileMql.addListener(refreshMarkers);
  }

  applyMapTheme(window.RRTheme ? RRTheme.effective() : "light");
  if (window.RRTheme) RRTheme.onChange(applyMapTheme);

  // --- Search box ---
  var input = $("homeloc");
  RR.searchBox = new google.maps.places.SearchBox(input);
  RR.map.addListener("bounds_changed", function () {
    RR.searchBox.setBounds(RR.map.getBounds());
  });

  RR.searchBox.addListener("places_changed", function () {
    var places = RR.searchBox.getPlaces();
    if (!places || !places.length || !places[0].geometry) return;
    var p = places[0];
    var label = RR.typedQuery || input.value;
    input.value = p.formatted_address || p.name;
    setHome(p.geometry.location, input.value, { saveLabel: label });
  });

  // Only trusted events: SearchBox and our own code set input.value programmatically.
  input.addEventListener("input", function (e) {
    if (e.isTrusted === false) return;
    RR.typedQuery = input.value;
  });

  input.addEventListener("focus", function () {
    input.select();
    if (window.RRSheet) RRSheet.raiseForInput();
  });

  // --- Geolocation ---
  $("geolocate").addEventListener("click", useMyLocation);

  // --- Radius controls ---
  var slider = $("radiusSlider");
  var number = $("radiusInput");
  var debouncedSearch = debounce(runSearch, 450);

  slider.addEventListener("input", function () {
    number.value = slider.value;
    debouncedSearch();
  });
  number.addEventListener("input", function () {
    var v = parseInt(number.value, 10);
    if (!isNaN(v)) slider.value = Math.min(Math.max(v, slider.min), slider.max);
    debouncedSearch();
  });

  // --- Category chips ---
  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      runSearch();
    });
  });

  // --- Pace ---
  var paceSel = $("paceSelect");
  try {
    var saved = localStorage.getItem("runroute_pace");
    if (saved && paceSel.querySelector('option[value="' + saved + '"]')) paceSel.value = saved;
  } catch (e) { /* storage unavailable */ }
  RR.paceSecPerKm = parseInt(paceSel.value, 10);

  paceSel.addEventListener("change", function () {
    RR.paceSecPerKm = parseInt(paceSel.value, 10);
    try { localStorage.setItem("runroute_pace", paceSel.value); } catch (e) { /* ignore */ }
    updateStats();
  });

  // --- Actions ---
  $("gpxBtn").addEventListener("click", downloadGPX);
  $("shareBtn").addEventListener("click", copyShareLink);
  $("clearBtn").addEventListener("click", function () { clearSelections(false); });

  $("startRunBtn").addEventListener("click", function () {
    if (window.RRRun) RRRun.open();
  });
  $("previewBtn").addEventListener("click", function () {
    if (window.RRSim) RRSim.open();
  });
  $("saveRouteBtn").addEventListener("click", function () {
    if (window.RRStore) RRStore.openSaveDialog();
  });
  $("dirDocBtn").addEventListener("click", function () {
    if (window.RRExport) RRExport.open();
  });

  bindMenu();

  if (window.RRStore) RRStore.init();
  if (window.RRSheet) RRSheet.onMapReady(RR.map);
  // Phone: while the camera is still the automatic route fit, refit whenever the sheet
  // settles in a new state, so collapsing to peek shows the route larger in the freed-up
  // map and raising to half again keeps it clear of the sheet. A pan or zoom by the user
  // ends the automatic fit (see trackAutoFit), and a live run owns the camera.
  if (window.RRSheet && RRSheet.onSettled) {
    RRSheet.onSettled(function (state) {
      if (state === "full" || !RR.hasRoute || !RR.autoFit) return;
      if (RR.run && RR.run.active) return;
      if (!isMobile()) return;
      fitRouteBounds();
    });
  }

  updatePeekSummary();
  restoreFromHash();
}

/* ---------------- Overflow menu ---------------- */

function bindMenu() {
  var btn = $("moreBtn");
  var menu = $("moreMenu");
  if (!btn || !menu) return;

  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }

  function openMenu() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var first = menu.querySelector("button");
    if (first) first.focus();
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else close(false);
  });

  menu.addEventListener("click", function (e) {
    if (e.target.closest("button")) close(false);
  });

  menu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll("button"));
    var idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === "Escape") {
      close(true);
    }
  });

  document.addEventListener("click", function (e) {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !menu.hidden && !menu.contains(document.activeElement)) close(false);
  });
}

/* ---------------- Home / geolocation ---------------- */

function setHome(latLng, address, opts) {
  opts = opts || {};
  RR.home = {
    location: latLng,
    address: address,
    lat: latLng.lat(),
    lng: latLng.lng(),
    saveLabel: typeof opts.saveLabel === "string" ? opts.saveLabel : null
  };

  RR.map.setCenter(latLng);
  if (RR.map.getZoom() < 14) RR.map.setZoom(15);

  if (!RR.homeMarker) {
    RR.homeMarker = new google.maps.Marker({
      position: latLng,
      map: RR.map,
      title: "Start & finish",
      zIndex: 50
    });
  } else {
    RR.homeMarker.setPosition(latLng);
  }
  // Always shown: the renderer's own pins are invisible, so this pin is the start/finish.
  RR.homeMarker.setMap(RR.map);

  var input = $("homeloc");
  input.title = address || "";
  input.scrollLeft = 0;
  var cap = $("homeCaption");
  if (cap) {
    $("homeCaptionText").textContent = address || "";
    cap.hidden = !address;
  }

  if (!RR.restoring && !opts.preserve) {
    RR.loadedRouteId = null;
    clearSelections(true);
    runSearch();
  }
  updatePeekSummary();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    toast("Your browser doesn't support geolocation.");
    return;
  }
  var btn = $("geolocate");
  btn.classList.add("busy");
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var latLng = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
      RR.geocoder.geocode({ location: latLng }, function (results, status) {
        btn.classList.remove("busy");
        var addr = (status === "OK" && results && results[0])
          ? results[0].formatted_address
          : pos.coords.latitude.toFixed(5) + ", " + pos.coords.longitude.toFixed(5);
        $("homeloc").value = addr;
        setHome(latLng, addr, { saveLabel: "My location" });
      });
    },
    function () {
      btn.classList.remove("busy");
      toast("Couldn't get your location — check the browser permission.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ---------------- Nearby search ---------------- */

function activeTypes() {
  var out = [];
  document.querySelectorAll('.chip[aria-pressed="true"]').forEach(function (c) {
    out.push(c.getAttribute("data-type"));
  });
  return out;
}

function currentRadius() {
  var v = parseInt($("radiusInput").value, 10);
  if (isNaN(v)) v = 800;
  return Math.min(Math.max(v, 100), 5000);
}

function nearbyByType(type, radius, location) {
  return new Promise(function (resolve) {
    RR.placesService.nearbySearch(
      { location: location, radius: radius, type: type },
      function (results, status) {
        if (status === google.maps.places.PlacesServiceStatus.OK && results) {
          resolve({ type: type, results: results });
        } else {
          resolve({ type: type, results: [] });
        }
      }
    );
  });
}

function runSearch() {
  if (!RR.home) return;
  var token = ++RR.searchToken;
  var radius = currentRadius();
  var types = activeTypes();

  var list = $("places");
  if (!types.length) {
    RR.results.clear();
    clearResultMarkers();
    list.innerHTML = '<li class="hint">Pick at least one category above to find places near you.</li>';
    $("placeCount").textContent = "";
    updatePeekSummary();
    return;
  }

  list.innerHTML = '<li class="hint">Searching within ' + radius + " m&hellip;</li>";

  Promise.all(types.map(function (t) {
    return nearbyByType(t, radius, RR.home.location);
  })).then(function (lists) {
    if (token !== RR.searchToken) return; // stale search

    RR.results.clear();
    lists.forEach(function (group) {
      group.results.forEach(function (place) {
        if (place.place_id && place.geometry && place.geometry.location && !RR.results.has(place.place_id)) {
          place.rrCat = CAT[group.type] ? CAT[group.type].key : null; // first category wins
          RR.results.set(place.place_id, place);
        }
      });
    });

    renderResults();
  });
}

function renderResults() {
  var list = $("places");
  var countEl = $("placeCount");
  clearResultMarkers();
  list.innerHTML = "";

  var items = [];
  RR.results.forEach(function (place) {
    var loc = place.geometry.location;
    items.push({
      place: place,
      dist: haversineMeters(
        { lat: RR.home.lat, lng: RR.home.lng },
        { lat: loc.lat(), lng: loc.lng() }
      )
    });
  });
  items.sort(function (a, b) { return a.dist - b.dist; });

  countEl.textContent = items.length ? items.length + " found" : "";

  if (!items.length) {
    list.innerHTML = '<li class="hint">No places found within ' + currentRadius() +
      " m.<br><strong>Try a bigger radius or more categories.</strong></li>";
    updatePeekSummary();
    return;
  }

  var frag = document.createDocumentFragment();
  items.forEach(function (item) {
    var place = item.place;
    var id = place.place_id;
    var li = document.createElement("li");
    li.className = "place";
    li.setAttribute("role", "option");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-selected", RR.selected.has(id) ? "true" : "false");
    li.dataset.placeId = id;
    if (place.rrCat) li.dataset.cat = place.rrCat;
    li.title = place.name + (place.vicinity ? " — " + place.vicinity : "");

    li.innerHTML =
      '<span class="place-check" aria-hidden="true">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 8.5 3.5 3.5 7.5-8"/></svg>' +
      "</span>" +
      '<span class="place-body">' +
        '<span class="place-name"><span class="cat-dot" aria-hidden="true"></span>' + escapeHtml(place.name) + "</span>" +
        (place.vicinity ? '<span class="place-meta">' + escapeHtml(place.vicinity) + "</span>" : "") +
      "</span>" +
      '<span class="place-side">' +
        '<span class="place-dist">' + fmtShortDist(item.dist) + "</span>" +
        (place.rating ? '<span class="place-rating">★ ' + place.rating.toFixed(1) + "</span>" : "") +
      "</span>";

    li.addEventListener("click", function () { togglePlace(id); });
    li.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePlace(id);
      }
    });

    frag.appendChild(li);
    addResultMarker(place);
  });
  list.appendChild(frag);
  updatePeekSummary();
}

/* ---------------- Result markers ---------------- */

/* Marker look, by state (D = visible diameter in CSS px at zoom 15; scaled by zoom):
     browsing, not picked ......... solid category dot, white ring (D 16 desktop / 13 phone)
     route exists, not picked ..... small translucent dot so the line reads through (11 / 9)
     picked stop .................. numbered visit-order badge on the darkened category
                                    fill, white ring (24 / 20); un-numbered while routing
   Icons are SVG data URLs drawn at 2x for sharp phones; on touch layouts a transparent
   hit circle keeps small dots tappable (see hitD below). */
var MARKER_ICON_CACHE = {};

function markerZoomFactor() {
  var z = (RR.map && RR.map.getZoom) ? RR.map.getZoom() : 15;
  if (typeof z !== "number") z = 15;
  if (z >= 17) return 1.15;
  if (z >= 16) return 1.08;
  if (z >= 15) return 1;
  if (z >= 14) return 0.9;
  return 0.8;
}

function markerIcon(selected, catKey, order) {
  var mobile = isMobile();
  var k = markerZoomFactor();
  var d, fill, fillOpacity, ring, ringW, text = "";
  if (selected) {
    d = Math.max(18, Math.round((mobile ? 20 : 24) * Math.max(k, 0.9)));
    fill = CAT_FILL[catKey] || "#4353f0";
    fillOpacity = 1;
    ring = "#ffffff";
    ringW = 2;
    if (order) text = String(order);
  } else if (RR.hasRoute) {
    d = Math.max(7, Math.round((mobile ? 9 : 11) * k));
    fill = CAT_COLOR[catKey] || "#4353f0";
    fillOpacity = 0.55;
    ring = "#ffffff";
    ringW = 1.5;
  } else {
    d = Math.max(10, Math.round((mobile ? 13 : 16) * k));
    fill = CAT_COLOR[catKey] || "#ffffff";
    fillOpacity = 1;
    ring = CAT_COLOR[catKey] ? "#ffffff" : "#4353f0";
    ringW = 2;
  }
  // Touch hit area: picked badges get >= 28 px and browse dots >= 24 px (WCAG 2.2 target
  // size). The faint unpicked dots shown while a route exists are not tappable on touch
  // layouts at all (markerClickable), so they get no padding.
  var hitD = d + 4;
  if (mobile) {
    if (selected) hitD = Math.max(d + 4, 28);
    else if (!RR.hasRoute) hitD = Math.max(d + 4, 24);
  }
  var box = Math.max(d + 4, hitD);
  var key = [d, fill, fillOpacity, ring, ringW, text, box, hitD].join("|");
  if (MARKER_ICON_CACHE[key]) return MARKER_ICON_CACHE[key];

  var c = box / 2;
  var r = d / 2 - ringW / 2;
  var fs = text.length > 1 ? Math.round(d * 0.46) : Math.round(d * 0.55);
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + box * 2 + '" height="' + box * 2 +
    '" viewBox="0 0 ' + box + " " + box + '">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="' + fill +
    '" fill-opacity="' + fillOpacity + '" stroke="' + ring + '" stroke-width="' + ringW + '"/>' +
    (text
      ? '<text x="' + c + '" y="' + (c + fs * 0.36) + '" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="' +
        fs + '" font-weight="700" fill="#ffffff">' + text + "</text>"
      : (selected ? '<circle cx="' + c + '" cy="' + c + '" r="' + (d * 0.14) + '" fill="#ffffff"/>' : "")) +
    "</svg>";

  var icon = {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    size: new google.maps.Size(box, box),
    scaledSize: new google.maps.Size(box, box),
    anchor: new google.maps.Point(c, c),
    rrShape: { type: "circle", coords: [c, c, Math.max(d / 2, hitD / 2)] }
  };
  MARKER_ICON_CACHE[key] = icon;
  return icon;
}

// Visit-order number (1-based) per picked stop id, from the last routed snapshot.
function stopOrderMap() {
  var out = {};
  if (!RR.hasRoute) return out;
  (RR.visitStops || []).forEach(function (s, i) { if (s && s.id) out[s.id] = i + 1; });
  return out;
}

/* Phone + route: the faint unpicked dots are display-only. The map around them is where a
   tap collapses the sheet, and the browser's touch adjustment snaps a finger onto any
   marker within ~20 px of it whatever its shape (measured: a tap 18-21 px off an 8 px dot
   with a 2 px hit circle still selected it), so ~1 in 3 "collapse" taps added a stop.
   Stops are added from the list, which stays open; browse dots, picked badges and every
   desktop marker stay clickable. */
function markerClickable(sel) {
  if (window.RRSim && RRSim.isOpen && RRSim.isOpen()) return false;
  if (RR.run && RR.run.active) return false; // run.js turns marker taps off for a live run
  return sel || !RR.hasRoute || !isMobile();
}

function styleMarker(id, m, orders) {
  var sel = RR.selected.has(id);
  var order = sel ? (orders || stopOrderMap())[id] : 0;
  var icon = markerIcon(sel, m.rrCat, order);
  m.setIcon(icon);
  m.setShape(icon.rrShape);
  var clickable = markerClickable(sel);
  if (m.getClickable() !== clickable) m.setClickable(clickable);
  m.setZIndex(sel ? 30 : (RR.hasRoute ? 10 : 20));
  if (m.rrName) m.setTitle(order ? "Stop " + order + ": " + m.rrName : m.rrName);
}

/* Start/finish: Google's default red pin while browsing (it marks the searched address);
   once a loop exists, a compact navy flag badge — the tall pin sat on the first and last
   legs and hid them, and with the renderer's pins invisible it is the only S/F mark. */
function homeIcon() {
  if (!RR.hasRoute) return null;
  var mobile = isMobile();
  var d = Math.max(18, Math.round((mobile ? 22 : 26) * Math.max(markerZoomFactor(), 0.9)));
  var key = "home|" + d;
  if (MARKER_ICON_CACHE[key]) return MARKER_ICON_CACHE[key];
  var box = d + 4, c = box / 2, u = d / 22;
  function p(x, y) { return (c + x * u).toFixed(2) + "," + (c + y * u).toFixed(2); }
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + box * 2 + '" height="' + box * 2 +
    '" viewBox="0 0 ' + box + " " + box + '">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + (d / 2 - 1.25) + '" fill="#222632" stroke="#ffffff" stroke-width="2.5"/>' +
    '<path d="M' + p(-3.2, 5.5) + "L" + p(-3.2, -5.5) + '" stroke="#ffffff" stroke-width="' + (1.8 * u).toFixed(2) + '" stroke-linecap="round"/>' +
    '<path d="M' + p(-3.2, -5.5) + "L" + p(5.2, -2.6) + "L" + p(-3.2, 0.3) + 'Z" fill="#ffffff"/>' +
    "</svg>";
  var icon = {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    size: new google.maps.Size(box, box),
    scaledSize: new google.maps.Size(box, box),
    anchor: new google.maps.Point(c, c)
  };
  MARKER_ICON_CACHE[key] = icon;
  return icon;
}

function refreshMarkers() {
  if (RR.homeMarker) {
    RR.homeMarker.setIcon(homeIcon());
    RR.homeMarker.setZIndex(RR.hasRoute ? 25 : 50);
  }
  if (!RR.markers || !RR.markers.size) return;
  var orders = stopOrderMap();
  RR.markers.forEach(function (m, id) { styleMarker(id, m, orders); });
}

function addResultMarker(place) {
  var id = place.place_id;
  var m = new google.maps.Marker({
    position: place.geometry.location,
    map: RR.map,
    title: place.name
  });
  m.addListener("click", function () { togglePlace(id); });
  m.rrCat = place.rrCat;
  m.rrName = place.name;
  styleMarker(id, m);
  RR.markers.set(id, m);
}

function clearResultMarkers() {
  RR.markers.forEach(function (m) { m.setMap(null); });
  RR.markers.clear();
}

/* ---------------- Selection & routing ---------------- */

function togglePlace(id) {
  if (window.RRSim && RRSim.isOpen && RRSim.isOpen()) { toast("Close the preview to change stops."); return; }
  if (RR.run && RR.run.active) { toast("End the run to change stops."); return; }
  if (RR.selected.has(id)) {
    RR.selected.delete(id);
  } else {
    if (RR.selected.size >= MAX_WAYPOINTS) {
      toast("Max " + MAX_WAYPOINTS + " stops per route.");
      return;
    }
    var place = RR.results.get(id);
    if (!place) return;
    RR.selected.set(id, {
      id: id,
      name: place.name,
      location: place.geometry.location,
      cat: place.rrCat || null,
      refreshedAt: Date.now()
    });
  }
  syncSelectionUI(id);
  if (RR.selected.size) {
    calculateRoute();
  } else {
    clearRouteDisplay();
  }
  updatePeekSummary();
}

function syncSelectionUI(id) {
  var li = document.querySelector('li.place[data-place-id="' + id + '"]');
  if (li) li.setAttribute("aria-selected", RR.selected.has(id) ? "true" : "false");
  var m = RR.markers.get(id);
  if (m) styleMarker(id, m);
}

function calculateRoute(onDone) {
  if (RR.run && RR.run.active) return;
  if (!RR.home || !RR.selected.size) return;

  var waypts = [];
  var names = [];
  var reqStops = [];
  RR.selected.forEach(function (s) {
    waypts.push({ location: s.location, stopover: true });
    names.push(s.name);
    reqStops.push(s);
  });
  var token = ++RR.routeToken;

  RR.directionsService.route(
    {
      origin: RR.home.location,
      destination: RR.home.location,
      waypoints: waypts,
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.WALKING
    },
    function (response, status) {
      // A newer request, a deselect-to-empty, or a Clear happened while this was in flight.
      if (token !== RR.routeToken || !RR.selected.size) {
        if (typeof onDone === "function") onDone(false);
        return;
      }
      if (status === "OK") {
        // Snapshot stop names in visit order NOW: a later drag makes the renderer
        // re-request, and its result's waypoint_order no longer maps to `names`.
        var order = response.routes[0].waypoint_order;
        if (!order || order.length !== reqStops.length) {
          order = reqStops.map(function (_, i) { return i; });
        }
        RR.waypointNames = names;
        RR.visitStops = order.map(function (i) { return reqStops[i]; });
        RR.hasRoute = true;
        RR.directionsRenderer.setMap(RR.map);
        RR.directionsRenderer.setDirections(response); // fires directions_changed -> updateStats
        refreshMarkers();
        // Mobile: the sheet deliberately stays where it is (normally half) so the list
        // remains open for more stops; the stats bar sits above the sheet either way.
        fitRouteBounds(response.routes[0].bounds);
        if (typeof onDone === "function") onDone(true);
      } else if (status === "ZERO_RESULTS" || status === "NOT_FOUND") {
        toast("Couldn't route through that stop — try a different one.");
        if (typeof onDone === "function") onDone(false);
      } else {
        toast("Route request failed (" + status + "). Please try again.");
        if (typeof onDone === "function") onDone(false);
      }
    }
  );
}

function clearRouteDisplay() {
  RR.routeToken++;
  RR.hasRoute = false;
  RR.routeMeters = 0;
  RR.visitStops = [];
  RR.autoFit = false;
  RR.directionsRenderer.setMap(null);
  if (RR.homeMarker && RR.home) RR.homeMarker.setMap(RR.map);
  $("statsbar").hidden = true;
  refreshMarkers();
  updatePeekSummary();
}

/* Fit the route into the part of the map a person can actually see. On a phone that is
   #mapwrap (which already ends at the sheet's top edge, peek or half) minus the map-type
   control at its top and the stats bar floating at its bottom — measured, not assumed,
   so it is right in whichever sheet state the route lands. With no bounds argument it
   refits the current route (store.js calls this after collapsing the sheet). */
/* RR.autoFit: true while the camera is the one fitRouteBounds() chose. Camera moves made
   by fitRouteBounds itself are bracketed by RR.fittingRoute (until the map is idle, or
   1.5 s if the fit changed nothing and no idle comes); any other zoom, or a drag, is the
   user taking over the view, and the sheet stops refitting (app init, RRSheet.onSettled). */
RR.autoFit = false;
RR.fittingRoute = false;

function trackAutoFit() {
  RR.map.addListener("dragstart", function () { RR.autoFit = false; });
  RR.map.addListener("zoom_changed", function () {
    if (!RR.fittingRoute) RR.autoFit = false;
  });
}

var routeFitSeq = 0;

function routeFitBegin() {
  RR.autoFit = true;
  RR.fittingRoute = true;
  var seq = ++routeFitSeq;
  // Only the latest fit may close the bracket: an earlier fit's timer must not end it
  // while a newer fit is still animating.
  function end() { if (seq === routeFitSeq) RR.fittingRoute = false; }
  google.maps.event.addListenerOnce(RR.map, "idle", end);
  setTimeout(end, 1500);
}

function fitRouteBounds(bounds) {
  if (!RR.map) return;
  if (!bounds) {
    var dir = RR.hasRoute ? RR.directionsRenderer.getDirections() : null;
    bounds = dir && dir.routes && dir.routes[0] && dir.routes[0].bounds;
  }
  if (!bounds) return;
  routeFitBegin();
  if (!isMobile()) {
    RR.map.fitBounds(bounds, 48);
    return;
  }
  var wrap = $("mapwrap");
  var wr = wrap ? wrap.getBoundingClientRect() : null;
  if (!wr || wr.height < 80) {
    RR.map.fitBounds(bounds, { top: 80, left: 24, right: 24, bottom: 160 });
    return;
  }
  var top = 58; // the app page has no top bar on phones; clear the map-type control (TOP_RIGHT)
  var bottom = 20;
  var bar = $("statsbar");
  if (bar && !bar.hidden) {
    var br = bar.getBoundingClientRect();
    if (br.height > 0 && br.top < wr.bottom) bottom = (wr.bottom - br.top) + 14;
  }
  // Leave at least ~120 px of map for the route; padding larger than the map makes
  // fitBounds zoom out to the world.
  var room = wr.height - top - bottom;
  if (room < 120) {
    var cut = 120 - room;
    top = Math.max(8, top - cut);
  }
  RR.map.fitBounds(bounds, { top: Math.round(top), left: 28, right: 28, bottom: Math.round(bottom) });
}

function clearSelections(silent) {
  if (RR.run && RR.run.active) return;
  var had = RR.selected.size;
  var ids = Array.from(RR.selected.keys());
  RR.selected.clear();
  ids.forEach(function (id) { syncSelectionUI(id); });
  document.querySelectorAll('li.place[aria-selected="true"]').forEach(function (li) {
    li.setAttribute("aria-selected", "false");
  });
  RR.loadedRouteId = null;
  clearRouteDisplay();
  if (!silent && had) toast("Route cleared.");
}

/* ---------------- Stats ---------------- */

function updateStats() {
  if (!RR.hasRoute) return;
  var dir = RR.directionsRenderer.getDirections();
  if (!dir || !dir.routes || !dir.routes[0]) return;

  var meters = 0;
  dir.routes[0].legs.forEach(function (leg) {
    if (leg.distance) meters += leg.distance.value;
  });
  RR.routeMeters = meters;

  var km = meters / 1000;
  $("statDistance").textContent = km.toFixed(2) + " km";
  $("statMiles").textContent = (km * 0.621371).toFixed(2) + " mi";
  $("statTime").textContent = fmtDuration(km * RR.paceSecPerKm);
  $("statsbar").hidden = false;
  updatePeekSummary();
}

/* ---------------- Sheet peek summary ---------------- */

function updatePeekSummary() {
  var el = $("sheetSummary");
  if (!el) return;
  var text;
  if (RR.hasRoute && RR.routeMeters) {
    text = (RR.routeMeters / 1000).toFixed(1) + " km loop · " + RR.selected.size +
      (RR.selected.size === 1 ? " stop" : " stops");
  } else if (RR.home && RR.results.size) {
    text = RR.results.size + " places · " + RR.selected.size +
      (RR.selected.size === 1 ? " stop picked" : " stops picked");
  } else {
    text = "Search your address to start";
  }
  el.textContent = text;
}

/* ---------------- GPX export ---------------- */

function downloadGPX() {
  var dir = RR.directionsRenderer.getDirections();
  if (!dir || !dir.routes || !dir.routes[0]) {
    toast("Build a route first.");
    return;
  }
  var pts = dir.routes[0].overview_path.map(function (p) {
    return '    <trkpt lat="' + p.lat().toFixed(6) + '" lon="' + p.lng().toFixed(6) + '"></trkpt>';
  }).join("\n");

  var gpx =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="RunRoute - runroute.app" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    "  <metadata><name>RunRoute loop</name><time>" + new Date().toISOString() + "</time></metadata>\n" +
    "  <trk><name>RunRoute loop</name><trkseg>\n" + pts + "\n  </trkseg></trk>\n" +
    "</gpx>\n";

  var blob = new Blob([gpx], { type: "application/gpx+xml" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "runroute-loop.gpx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  toast("GPX downloaded — import it to your watch or app.");
}

/* ---------------- Share link ---------------- */

function copyShareLink() {
  if (!RR.home || !RR.selected.size) {
    toast("Build a route first.");
    return;
  }
  var params = new URLSearchParams();
  params.set("h", RR.home.lat.toFixed(6) + "," + RR.home.lng.toFixed(6));
  params.set("a", RR.home.address || "");
  params.set("r", String(currentRadius()));
  params.set("t", activeTypes().join(","));
  params.set("w", Array.from(RR.selected.keys()).join(","));

  var url = location.origin + location.pathname + "#" + params.toString();

  function done() { toast("Link copied — it rebuilds this exact loop."); }
  function fail() { window.prompt("Copy this link:", url); }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, fail);
  } else {
    fail();
  }
}

function restoreFromHash() {
  var hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  var params;
  try { params = new URLSearchParams(hash); } catch (e) { return; }
  var h = params.get("h");
  if (!h) return;

  var parts = h.split(",");
  var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return;

  RR.restoring = true;

  var r = parseInt(params.get("r"), 10);
  if (!isNaN(r)) {
    $("radiusInput").value = r;
    $("radiusSlider").value = Math.min(Math.max(r, 100), 3000);
  }
  var t = (params.get("t") || "").split(",").filter(Boolean);
  if (t.length) {
    document.querySelectorAll(".chip").forEach(function (chip) {
      chip.setAttribute("aria-pressed", t.indexOf(chip.getAttribute("data-type")) !== -1 ? "true" : "false");
    });
  }

  var address = params.get("a") || lat.toFixed(4) + ", " + lng.toFixed(4);
  $("homeloc").value = address;
  setHome(new google.maps.LatLng(lat, lng), address, { saveLabel: address });
  runSearch();

  var ids = (params.get("w") || "").split(",").filter(Boolean).slice(0, MAX_WAYPOINTS);
  if (!ids.length) { RR.restoring = false; return; }

  var pending = ids.length;
  ids.forEach(function (id) {
    RR.placesService.getDetails(
      { placeId: id, fields: ["place_id", "name", "geometry", "types"] },
      function (place, status) {
        pending--;
        if (status === google.maps.places.PlacesServiceStatus.OK &&
            place && place.geometry && place.geometry.location) {
          RR.selected.set(id, {
            id: id,
            name: place.name,
            location: place.geometry.location,
            cat: catFromTypes(place.types),
            refreshedAt: Date.now()
          });
          syncSelectionUI(id);
        }
        if (pending === 0) {
          RR.restoring = false;
          if (RR.selected.size) {
            calculateRoute();
            toast("Shared route loaded.");
          }
        }
      }
    );
  });
}
