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
  var panel = null, handle = null, peekRow = null;
  var state = "half";
  var map = null;
  var installed = false;

  function isMobile() { return mql ? mql.matches : false; }

  function setState(next) {
    if (STATES.indexOf(next) === -1) return;
    state = next;
    if (!isMobile()) return;
    document.body.setAttribute("data-sheet", next);
    if (panel) panel.style.transform = "";
    if (map && window.google && google.maps && google.maps.event) {
      setTimeout(function () { google.maps.event.trigger(map, "resize"); }, 300);
    }
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
  }

  /* ---- Pixel positions for dragging (CSS calc governs at rest) ---- */

  function positions() {
    var H = panel.offsetHeight;
    var vh = window.innerHeight;
    return {
      full: 0,
      half: Math.max(0, H - Math.round(vh * 0.48)),
      peek: Math.max(0, H - 88)
    };
  }

  function bindDrag() {
    var startPointerY = 0, startTY = 0, dragging = false, lastY = 0, lastT = 0, velocity = 0;

    function currentTY() {
      var pos = positions();
      return pos[state] != null ? pos[state] : pos.half;
    }

    handle.addEventListener("pointerdown", function (e) {
      if (!isMobile()) return;
      dragging = true;
      startPointerY = e.clientY;
      lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      startTY = currentTY();
      panel.style.transition = "none";
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dy = e.clientY - startPointerY;
      var pos = positions();
      var ty = Math.min(Math.max(startTY + dy, pos.full), pos.peek);
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
