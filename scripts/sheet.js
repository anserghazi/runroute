/* ============================================================
   RunRoute — mobile bottom sheet controller (peek / half / full)
   The .panel becomes a bottom sheet at ≤860px. Dragging lives on
   the handle ONLY (touch-action:none there), so list scrolling
   and sheet dragging can never contend. Exposes window.RRSheet.
   ============================================================ */

"use strict";

(function () {
  var STATES = ["peek", "half", "full"];
  var mql = window.matchMedia ? window.matchMedia("(max-width: 860px)") : null;
  var panel = null, handle = null, peekRow = null, probe = null;
  var state = "half";
  var map = null;
  var installed = false;

  function isMobile() { return mql ? mql.matches : false; }

  var settledFns = [];

  // #mapwrap's bottom edge follows data-sheet in CSS; the map must re-measure afterwards.
  // `settled` listeners run once the map has re-measured (after a state change only).
  function kickMap(notify) {
    if (map && window.google && google.maps && google.maps.event) {
      setTimeout(function () {
        google.maps.event.trigger(map, "resize");
        if (notify) {
          settledFns.forEach(function (fn) {
            try { fn(state); } catch (err) { /* a listener must not break the sheet */ }
          });
        }
      }, 300);
    }
  }

  function setState(next) {
    if (STATES.indexOf(next) === -1) return;
    var changed = next !== state;
    state = next;
    if (!isMobile()) return;
    document.body.setAttribute("data-sheet", next);
    if (panel) panel.style.transform = "";
    kickMap(changed);
  }

  function getState() { return state; }

  function install() {
    if (installed) return;
    installed = true;
    document.body.setAttribute("data-sheet", state);
  }

  function uninstall() {
    installed = false;
    document.body.removeAttribute("data-sheet");
    if (panel) panel.style.transform = "";
  }

  function onModeChange() {
    if (isMobile()) install(); else uninstall();
    kickMap();
  }

  /* ---- Pixel positions for dragging (CSS calc governs at rest) ---- */

  // Resolves the same 48svh and env(safe-area-inset-bottom) the CSS rest positions use,
  // which innerHeight and a bare 88px cannot.
  function ensureProbe() {
    if (probe) return probe;
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    var s = probe.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.width = "0";
    s.boxSizing = "content-box";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    s.height = "48vh";
    s.height = "48svh"; // ignored where svh is unsupported, leaving the vh fallback
    s.paddingBottom = "env(safe-area-inset-bottom, 0px)";
    document.body.appendChild(probe);
    return probe;
  }

  function positions() {
    var H = panel.offsetHeight;
    var halfPx = Math.round(window.innerHeight * 0.48);
    var inset = 0;
    try {
      var cs = window.getComputedStyle(ensureProbe());
      var h = parseFloat(cs.height);
      var pb = parseFloat(cs.paddingBottom);
      if (h > 0) halfPx = h;
      if (pb > 0) inset = pb;
    } catch (err) { /* keep innerHeight fallback */ }
    return {
      full: 0,
      half: Math.max(0, H - halfPx),
      peek: Math.max(0, H - 88 - inset)
    };
  }

  // translateY actually applied right now (matrix m42 / matrix3d m42), or null.
  function computedTY() {
    var t;
    try { t = window.getComputedStyle(panel).transform; } catch (err) { return null; }
    if (!t || t === "none") return t === "none" ? 0 : null;
    var m = t.match(/^matrix(3d)?\(([^)]+)\)$/);
    if (!m) return null;
    var v = m[2].split(",");
    var ty = parseFloat(m[1] ? v[13] : v[5]);
    return isFinite(ty) ? ty : null;
  }

  function bindDrag() {
    var startPointerY = 0, startTY = 0, dragging = false, lastY = 0, lastT = 0, velocity = 0;
    var dragPos = null;

    handle.addEventListener("pointerdown", function (e) {
      if (!isMobile()) return;
      dragging = true;
      startPointerY = e.clientY;
      lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      dragPos = positions();
      var real = computedTY(); // read before transition:none so a mid-animation grab starts in place
      startTY = real != null ? real : (dragPos[state] != null ? dragPos[state] : dragPos.half);
      panel.style.transition = "none";
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dy = e.clientY - startPointerY;
      var pos = dragPos || positions();
      var ty = Math.min(Math.max(startTY + dy, pos.full), Math.max(pos.peek, startTY));
      panel.style.transform = "translateY(" + ty + "px)";
      var dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientY - lastY) / dt; // px per ms, + = down
      lastY = e.clientY;
      lastT = e.timeStamp;
    });

    function release(e) {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      var dy = e.clientY - startPointerY;
      var next = state;
      var idx = STATES.indexOf(state);
      if (dy <= -40 || velocity <= -0.5) {
        next = STATES[Math.min(idx + 1, 2)];        // moved up → expand
      } else if (dy >= 40 || velocity >= 0.5) {
        next = STATES[Math.max(idx - 1, 0)];        // moved down → collapse
      } else if (Math.abs(dy) < 6) {
        next = state === "peek" ? "half" : state === "full" ? "half" : "peek"; // tap
      }
      panel.style.transform = "";
      setState(next);
    }

    handle.addEventListener("pointerup", release);
    handle.addEventListener("pointercancel", function (e) { release(e); });

    handle.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setState(state === "peek" ? "half" : state === "full" ? "half" : "peek");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setState(STATES[Math.min(STATES.indexOf(state) + 1, 2)]);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setState(STATES[Math.max(STATES.indexOf(state) - 1, 0)]);
      }
    });
  }

  function bind() {
    panel = document.querySelector(".panel");
    handle = document.getElementById("sheetHandle");
    peekRow = document.getElementById("sheetSummary");
    if (!panel || !handle) return;

    bindDrag();

    if (peekRow) {
      peekRow.addEventListener("click", function () { setState("half"); });
    }

    if (mql) {
      if (mql.addEventListener) mql.addEventListener("change", onModeChange);
      else if (mql.addListener) mql.addListener(onModeChange);
    }
    onModeChange();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.RRSheet = {
    setState: setState,
    getState: getState,
    // fn(state) runs after a state change, once the map has been resized to the new size.
    onSettled: function (fn) {
      if (typeof fn === "function") settledFns.push(fn);
    },
    raiseForInput: function () {
      if (isMobile() && state === "peek") setState("half");
    },
    onMapReady: function (m) {
      map = m;
      m.addListener("click", function () {
        if (isMobile() && state !== "peek") setState("peek");
      });
    }
  };
})();
