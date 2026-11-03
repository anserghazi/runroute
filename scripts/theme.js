/* ============================================================
   RunRoute — theme state machine (Auto / Light / Dark)
   Loads on every page, before app scripts. Exposes window.RRTheme.
   The anti-FOUC inline <head> script has already set
   documentElement.dataset.theme from localStorage before paint.
   ============================================================ */

"use strict";

(function () {
  var KEY = "rr-theme";
  var LIGHT_META = "#feffeb";
  var DARK_META = "#12141f";
  var listeners = [];
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  // Remember each theme-color meta's authored per-media value so Auto can restore it.
  var metas = [];
  function collectMetas() {
    metas = [];
    var nodes = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < nodes.length; i++) {
      metas.push({ el: nodes[i], original: nodes[i].getAttribute("content") });
    }
  }

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (e) { return null; }
  }

  function normMode(m) {
    return m === "light" || m === "dark" ? m : "auto";
  }

  /* The page's mode lives here, not in storage: when localStorage throws,
     set() can't persist, and re-reading storage would undo the choice. */
  var current = normMode(stored() || document.documentElement.dataset.theme);

  function manual() {
    return current === "auto" ? null : current;
  }

  function effective() {
    var s = manual();
    if (s) return s;
    return media && media.matches ? "dark" : "light";
  }

  // A page's own authored light/dark theme-color (marketing pages use the navy header color).
  function authoredMeta(mode) {
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i].el.getAttribute("media") || "";
      if (m.indexOf(mode) !== -1 && metas[i].original) return metas[i].original;
    }
    return mode === "dark" ? DARK_META : LIGHT_META;
  }

  function syncMetas() {
    if (!metas.length) collectMetas();
    var s = manual();
    for (var i = 0; i < metas.length; i++) {
      if (s) {
        metas[i].el.setAttribute("content", authoredMeta(s));
      } else if (metas[i].original != null) {
        metas[i].el.setAttribute("content", metas[i].original);
      }
    }
  }

  function applyDom() {
    var s = manual();
    if (s) {
      document.documentElement.dataset.theme = s;
    } else {
      delete document.documentElement.dataset.theme;
    }
    syncMetas();
    updateToggles();
  }

  function notify() {
    var eff = effective();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](eff); } catch (e) { /* listener error must not break theming */ }
    }
  }

  function set(mode) {
    current = normMode(mode);
    try {
      if (mode === "light" || mode === "dark") localStorage.setItem(KEY, mode);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage unavailable: still apply for this page */ }
    if (mode === "light" || mode === "dark") {
      document.documentElement.dataset.theme = mode;
    } else {
      delete document.documentElement.dataset.theme;
    }
    syncMetas();
    updateToggles();
    notify();
  }

  function modeNow() {
    return current;
  }

  function labelFor(mode) {
    return mode === "light" ? "Theme: Light" : mode === "dark" ? "Theme: Dark" : "Theme: Auto";
  }

  function updateToggles() {
    var label = labelFor(modeNow());
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-label", label);
      btns[i].setAttribute("title", label);
    }
  }

  function cycle() {
    var next = { auto: "light", light: "dark", dark: "auto" }[modeNow()];
    set(next);
    if (typeof window.toast === "function") {
      window.toast(next === "auto" ? "Theme: Auto (follows your device)" : labelFor(next));
    }
  }

  function bind() {
    collectMetas();
    applyDom();
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", cycle);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  // Another tab changed the theme.
  window.addEventListener("storage", function (e) {
    if (e.key === KEY) { current = normMode(stored()); applyDom(); notify(); }
  });

  // OS theme changed while in Auto.
  if (media) {
    var onMedia = function () { if (current === "auto") { syncMetas(); notify(); } };
    if (media.addEventListener) media.addEventListener("change", onMedia);
    else if (media.addListener) media.addListener(onMedia);
  }

  window.RRTheme = {
    stored: stored,
    effective: effective,
    set: set,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
