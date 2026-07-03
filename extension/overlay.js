// extension/overlay.js — the StumbleUpon-style bar injected onto each stumbled
// page by the service worker (chrome.scripting.executeScript). Idempotent: a
// re-injection on the reused tab replaces the old bar. Buttons message the SW,
// which records the vote/save and advances the same tab.
(function () {
  if (window.__iaBstumbleInjected) { try { document.getElementById("ia-bstumble-bar").remove(); } catch (e) {} }
  window.__iaBstumbleInjected = true;

  var send = function (msg) { try { chrome.runtime.sendMessage(msg); } catch (e) {} };
  var flash = function (label) { status.textContent = label; };

  var bar = document.createElement("div");
  bar.id = "ia-bstumble-bar";
  bar.style.cssText = [
    "position:fixed", "left:50%", "top:12px", "transform:translateX(-50%)",
    "z-index:2147483647", "display:flex", "gap:8px", "align-items:center",
    "background:rgba(26,24,21,.97)", "color:#f6f5f3", "padding:8px 12px",
    "border-radius:12px", "box-shadow:0 6px 24px rgba(0,0,0,.45)",
    "border:1px solid rgba(255,255,255,.12)",
    "font:600 13px/1 system-ui,sans-serif", "pointer-events:auto"
  ].join(";");

  function mkBtn(label, title, bg, onClick) {
    var b = document.createElement("button");
    b.textContent = label; b.title = title;
    b.style.cssText = "border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit;background:" + bg + ";color:#fff";
    b.addEventListener("click", onClick);
    return b;
  }

  var status = document.createElement("span");
  status.style.cssText = "min-width:70px;text-align:center;color:#cbe8dc";
  status.textContent = "Stumble";

  bar.appendChild(mkBtn("👍", "Like — more like this", "#0d9488", function () { send({ action: "bstumbleVote", vote: 1 }); flash("Liked →"); }));
  bar.appendChild(mkBtn("👎", "Not for me — fewer like this", "#7c2d2d", function () { send({ action: "bstumbleVote", vote: -1 }); flash("Skipped →"); }));
  bar.appendChild(mkBtn("★ Save", "Save to Interests", "#b45309", function () { send({ action: "bstumbleSave" }); flash("Saved ✓"); }));
  bar.appendChild(mkBtn("Stumble ⟳", "Next page", "#334155", function () { send({ action: "bstumbleNext" }); flash("Finding…"); }));
  var x = mkBtn("✕", "Hide this bar", "transparent", function () { bar.remove(); });
  x.style.color = "#9a958d";
  bar.appendChild(status);
  bar.appendChild(x);

  (document.body || document.documentElement).appendChild(bar);
})();
