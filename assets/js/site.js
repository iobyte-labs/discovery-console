/* Shared by the Hugo pages. The console at /app/ is self-contained and repeats the little
   it needs, so that it keeps working if this file ever fails to load. */
(function () {
  "use strict";
  var K = { tok: "dc.token", repo: "dc.repo", who: "dc.login", theme: "dc.theme" };

  function read(k) {
    // The token may live in either store: sessionStorage by default, localStorage only
    // when the reader asked to stay signed in.
    try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch (e) { return null; }
  }
  function drop(k) {
    try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {}
  }

  var saved = (function () { try { return localStorage.getItem(K.theme); } catch (e) { return null; } })();
  if (saved) document.documentElement.setAttribute("data-theme", saved);

  window.toggleTheme = function () {
    var dark = matchMedia("(prefers-color-scheme: dark)").matches;
    var current = document.documentElement.getAttribute("data-theme") || (dark ? "dark" : "light");
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(K.theme, next); } catch (e) {}
  };

  function paintSession() {
    var box = document.getElementById("sessionBox");
    if (!box) return;
    var who = read(K.who);
    box.textContent = "";
    if (!who) return;
    var chip = document.createElement("span");
    chip.textContent = who;
    var out = document.createElement("button");
    out.className = "ghost";
    out.type = "button";
    out.textContent = "Sign out";
    out.addEventListener("click", function () {
      drop(K.tok); drop(K.who);
      paintSession();
      if (location.pathname.indexOf("/app") === 0) location.reload();
    });
    box.append(chip, out);
  }
  document.addEventListener("DOMContentLoaded", paintSession);
  // Signing out in one tab should not leave another tab looking signed in.
  window.addEventListener("storage", paintSession);
})();
