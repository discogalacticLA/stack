// Small progressive enhancements. Every feature also works without JavaScript.
(function () {
  "use strict";

  // 1. Restore browsing position when returning to a results page.
  var key = "scroll:" + location.pathname + location.search;
  if (document.body && document.querySelector("[data-restore-scroll]")) {
    try {
      var y = sessionStorage.getItem(key);
      if (y) window.scrollTo(0, Number(y));
    } catch (e) {}
    window.addEventListener("pagehide", function () {
      try { sessionStorage.setItem(key, String(window.scrollY)); } catch (e) {}
    });
  }

  // 2. Focus the error summary so screen-reader and keyboard users land on it.
  var summary = document.getElementById("error-summary");
  if (summary) summary.focus();

  // 3. Collection bulk selection helpers.
  var form = document.getElementById("bulk-form");
  if (form) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll("input[name=ids][form=bulk-form]"));
    var pageToggle = document.getElementById("select-page");
    var countEl = document.getElementById("selected-count");
    var scopeSelected = document.getElementById("scope-selected");
    var update = function () {
      var n = boxes.filter(function (b) { return b.checked; }).length;
      if (countEl) countEl.textContent = String(n);
      if (pageToggle) {
        pageToggle.checked = n > 0 && n === boxes.length;
        pageToggle.indeterminate = n > 0 && n < boxes.length;
      }
    };
    boxes.forEach(function (b) {
      b.addEventListener("change", function () {
        if (scopeSelected) scopeSelected.checked = true;
        update();
      });
    });
    if (pageToggle) {
      pageToggle.addEventListener("change", function () {
        boxes.forEach(function (b) { b.checked = pageToggle.checked; });
        var pageScope = document.getElementById("scope-page");
        if (pageToggle.checked && pageScope) pageScope.checked = true;
        update();
      });
    }
    update();
  }

  // 4. YouTube previews load only after an explicit click (no third-party requests before).
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-embed-src]");
    if (!btn) return;
    var frame = document.createElement("iframe");
    frame.className = "listen-embed";
    frame.src = btn.getAttribute("data-embed-src");
    frame.title = btn.getAttribute("data-embed-title") || "YouTube video";
    frame.allow = "encrypted-media; picture-in-picture";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.setAttribute("allowfullscreen", "");
    btn.replaceWith(frame);
    frame.focus();
  });
})();
