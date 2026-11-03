/* ============================================================
   RunRoute — application logic
   Loop-route planner: pick a start, pick nearby places,
   get a door-to-door running route.
   ============================================================ */

"use strict";

var RR = {
  map: null,
  geocoder: null,
  placesService: null,
  directionsService: null,
  directionsRenderer: null,
  searchBox: null,
  home: null,            // { location: LatLng, address: string }
  homeMarker: null,
  results: new Map(),    // place_id -> place (current search results)
  markers: new Map(),    // place_id -> Marker (current search results)
  selected: new Map(),   // place_id -> { id, name, location }
  hasRoute: false,
  paceSecPerKm: 360,
  searchToken: 0,
  restoring: false,
  mapsLoaded: false
};

var MAX_WAYPOINTS = 10;
var DEFAULT_CENTER = { lat: 43.6532, lng: -79.3852 }; // Toronto

/* ---------------- Small helpers ---------------- */

function $(id) { return document.getElementById(id); }

function toast(msg, ms) {
  var el = $("toast");
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
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

// Friendly message if the API key / billing is rejected at runtime.
window.gm_authFailure = function () {
  showMapError(
    "The map couldn't start",
    "Google Maps rejected the site's access key. This is on us, not you — please try again later, or let us know via the contact page."
  );
};

// Watchdog: script blocked / failed to load entirely.
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

function boot() {
  RR.map = new google.maps.Map($("map"), {
    center: DEFAULT_CENTER,
    zoom: 14,
    mapTypeControl: true,
    mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
    styles: [
      { featureType: "poi.business", stylers: [{ visibility: "off" }] },
      { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] }
    ]
  });

  RR.geocoder = new google.maps.Geocoder();
  RR.placesService = new google.maps.places.PlacesService(RR.map);
  RR.directionsService = new google.maps.DirectionsService();
  RR.directionsRenderer = new google.maps.DirectionsRenderer({
    draggable: true,
    polylineOptions: { strokeColor: "#4353f0", strokeWeight: 5, strokeOpacity: 0.85 }
  });

  RR.directionsRenderer.addListener("directions_changed", updateStats);

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
    input.value = p.formatted_address || p.name;
    setHome(p.geometry.location, input.value);
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
  var chips = document.querySelectorAll(".chip");
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      var on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      runSearch();
    });
  });

  // --- Stats bar ---
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

  $("gpxBtn").addEventListener("click", downloadGPX);
  $("shareBtn").addEventListener("click", copyShareLink);
  $("clearBtn").addEventListener("click", clearSelections);

  restoreFromHash();
}

/* ---------------- Home / geolocation ---------------- */

function setHome(latLng, address) {
  RR.home = {
    location: latLng,
    address: address,
    lat: latLng.lat(),
    lng: latLng.lng()
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
  RR.homeMarker.setMap(RR.hasRoute ? null : RR.map);

  if (!RR.restoring) {
    clearSelections(true);
    runSearch();
  }
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
        setHome(latLng, addr);
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
          resolve(results);
        } else {
          resolve([]); // ZERO_RESULTS and errors both resolve empty; errors reported by caller heuristic
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
    return;
  }

  list.innerHTML = '<li class="hint">Searching within ' + radius + " m&hellip;</li>";

  Promise.all(types.map(function (t) {
    return nearbyByType(t, radius, RR.home.location);
  })).then(function (lists) {
    if (token !== RR.searchToken) return; // stale search

    RR.results.clear();
    lists.forEach(function (arr) {
      arr.forEach(function (place) {
        if (place.place_id && place.geometry && place.geometry.location && !RR.results.has(place.place_id)) {
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

    var meta = [];
    if (place.rating) meta.push("★ " + place.rating.toFixed(1));
    if (place.vicinity) meta.push(place.vicinity);

    li.innerHTML =
      '<span class="place-check" aria-hidden="true">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 8.5 3.5 3.5 7.5-8"/></svg>' +
      "</span>" +
      '<span class="place-body">' +
        '<span class="place-name">' + escapeHtml(place.name) + "</span>" +
        '<span class="place-meta">' + escapeHtml(meta.join(" · ")) + "</span>" +
      "</span>" +
      '<span class="place-dist">' + fmtShortDist(item.dist) + "</span>";

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
}

/* ---------------- Result markers ---------------- */

function markerIcon(selected) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 8,
    fillColor: selected ? "#4353f0" : "#ffffff",
    fillOpacity: 1,
    strokeColor: "#4353f0",
    strokeWeight: 2.5
  };
}

function addResultMarker(place) {
  var id = place.place_id;
  var m = new google.maps.Marker({
    position: place.geometry.location,
    map: RR.map,
    title: place.name,
    icon: markerIcon(RR.selected.has(id)),
    zIndex: RR.selected.has(id) ? 30 : 20
  });
  m.addListener("click", function () { togglePlace(id); });
  RR.markers.set(id, m);
}

function clearResultMarkers() {
  RR.markers.forEach(function (m) { m.setMap(null); });
  RR.markers.clear();
}

/* ---------------- Selection & routing ---------------- */

function togglePlace(id) {
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
      location: place.geometry.location
    });
  }
  syncSelectionUI(id);
  if (RR.selected.size) {
    calculateRoute();
  } else {
    clearRouteDisplay();
  }
}

function syncSelectionUI(id) {
  var li = document.querySelector('li.place[data-place-id="' + id + '"]');
  if (li) li.setAttribute("aria-selected", RR.selected.has(id) ? "true" : "false");
  var m = RR.markers.get(id);
  if (m) {
    m.setIcon(markerIcon(RR.selected.has(id)));
    m.setZIndex(RR.selected.has(id) ? 30 : 20);
  }
}

function calculateRoute() {
  if (!RR.home || !RR.selected.size) return;

  var waypts = [];
  RR.selected.forEach(function (s) {
    waypts.push({ location: s.location, stopover: true });
  });

  RR.directionsService.route(
    {
      origin: RR.home.location,
      destination: RR.home.location,
      waypoints: waypts,
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.WALKING
    },
    function (response, status) {
      if (status === "OK") {
        RR.hasRoute = true;
        if (RR.homeMarker) RR.homeMarker.setMap(null);
        RR.directionsRenderer.setMap(RR.map);
        RR.directionsRenderer.setDirections(response); // fires directions_changed -> updateStats
      } else if (status === "ZERO_RESULTS" || status === "NOT_FOUND") {
        toast("Couldn't route through that stop — try a different one.");
      } else {
        toast("Route request failed (" + status + "). Please try again.");
      }
    }
  );
}

function clearRouteDisplay() {
  RR.hasRoute = false;
  RR.directionsRenderer.setMap(null);
  if (RR.homeMarker && RR.home) RR.homeMarker.setMap(RR.map);
  $("statsbar").hidden = true;
}

function clearSelections(silent) {
  var had = RR.selected.size;
  RR.selected.forEach(function (_, id) {
    RR.selected.delete(id);
    syncSelectionUI(id);
  });
  RR.selected.clear();
  document.querySelectorAll('li.place[aria-selected="true"]').forEach(function (li) {
    li.setAttribute("aria-selected", "false");
  });
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

  var km = meters / 1000;
  $("statDistance").textContent = km.toFixed(2) + " km";
  $("statMiles").textContent = (km * 0.621371).toFixed(2) + " mi";
  $("statTime").textContent = fmtDuration(km * RR.paceSecPerKm);
  $("statsbar").hidden = false;
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

  // Radius + categories first, so the search uses them.
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
  setHome(new google.maps.LatLng(lat, lng), address);
  runSearch();

  var ids = (params.get("w") || "").split(",").filter(Boolean).slice(0, MAX_WAYPOINTS);
  if (!ids.length) { RR.restoring = false; return; }

  var pending = ids.length;
  ids.forEach(function (id) {
    RR.placesService.getDetails(
      { placeId: id, fields: ["place_id", "name", "geometry"] },
      function (place, status) {
        pending--;
        if (status === google.maps.places.PlacesServiceStatus.OK &&
            place && place.geometry && place.geometry.location) {
          RR.selected.set(id, { id: id, name: place.name, location: place.geometry.location });
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
