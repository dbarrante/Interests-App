// tests/card-anchor-title-tools.test.js — structural checks for three fixes:
//   1. refreshing anything on a card must not scroll away from that card
//   2. Title-issues rows open the page on double-click (so the extension can
//      recapture it), stamping ia_last_opened the way impOpen does
//   3. Title-issues rows can have their title written by hand
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

function fnBody(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return null;
  const j = src.indexOf("\n}", i);
  return j < 0 ? null : src.slice(i, j + 2);
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  /* ---- 1. scroll anchoring ---- */
  t(label + ": anchorImpOnCard captures all three anchor fields together", () => {
    const b = fnBody(src, "anchorImpOnCard");
    assert.ok(b, "anchorImpOnCard not found");
    // restoreImpScroll falls back to _impScrollY when the anchored card is gone,
    // so capturing only two of the three restores against a stale scrollY from
    // some earlier interaction.
    for (const f of ["_impScrollY", "_impAnchorId", "_impAnchorTop"]) {
      assert.ok(b.indexOf(f) >= 0, "must set " + f);
    }
  });
  t(label + ": refreshing a card's TITLE anchors before re-rendering", () => {
    const b = fnBody(src, "impRefreshTitle") || /async function impRefreshTitle\(idx\)\{[\s\S]*?\n\}/.exec(src)[0];
    assert.ok(b, "impRefreshTitle not found");
    const iAnchor = b.indexOf("anchorImpOnCard(it)");
    const iRender = b.indexOf("renderImported()");
    assert.ok(iAnchor >= 0, "must anchor — this was the bug: it restored a stale anchor and jumped away");
    assert.ok(iRender >= 0 && iAnchor < iRender,
      "must anchor BEFORE the re-render, while the old DOM is still measurable");
  });
  t(label + ": every card re-render path anchors through the shared helper", () => {
    // The capture used to be copy-pasted inline at four sites and simply missing
    // at a fifth. One helper means a new call site can't half-implement it.
    const inline = (src.replace(fnBody(src, "anchorImpOnCard") || "", "")
      .match(/_impAnchorTop\s*=\s*(_ael|el)\s*\?/g) || []).length;
    assert.strictEqual(inline, 0, "found " + inline + " inline anchor capture(s) that should use anchorImpOnCard");
    assert.ok((src.match(/anchorImpOnCard\(/g) || []).length >= 5,
      "helper should be used by the open/photo-refresh/title-refresh/edit-save/paste paths");
  });

  /* ---- 2. double-click to open (then recapture) ---- */
  t(label + ": Title-issues rows open the page on double-click of the photo AND the title", () => {
    const region = /\/\/ Double-click the picture or the title[\s\S]*?&#8635;<\/button>/.exec(src);
    assert.ok(region, "title-issues row markup not found");
    const hits = (region[0].match(/ondblclick="titleOpenOriginal\(this\)"/g) || []).length;
    assert.strictEqual(hits, 2, "both the thumbnail and the title must carry it, got " + hits);
  });
  t(label + ": opening from Title issues stamps ia_last_opened so a capture matches back", () => {
    const b = fnBody(src, "titleOpenOriginal");
    assert.ok(b, "titleOpenOriginal not found");
    assert.match(b, /Store\.kvSet\("ia_last_opened"/,
      "without this the extension's capture can't be matched to this card — that IS the feature");
    assert.match(b, /if\(!it\.id\)\{ it\.id = newId\(\)/,
      "a card with no id would make the stamp point at nothing");
    assert.match(b, /\^https\?:/, "must refuse a card with no real web page");
  });
  t(label + ": double-clicking inside the suggestion input doesn't open the page", () => {
    const region = /\/\/ Double-click the picture or the title[\s\S]*?&#8635;<\/button>/.exec(src)[0];
    assert.match(region, /class="title-suggest-input"[^>]*ondblclick="event\.stopPropagation\(\)"/,
      "double-click selects a word while editing — it must not bubble into open-the-article");
  });

  /* ---- 3. manual per-row title edit ---- */
  t(label + ": Title-issues rows expose a manual title editor", () => {
    const region = /\/\/ Double-click the picture or the title[\s\S]*?&#8635;<\/button>/.exec(src)[0];
    assert.match(region, /onclick="editTitleManually\('\$\{esc\(key\)\}'\)"/, "per-row edit button missing");
  });
  t(label + ": manual edit seeds the existing suggestion input rather than adding a write path", () => {
    const b = fnBody(src, "editTitleManually");
    assert.ok(b, "editTitleManually not found");
    assert.match(b, /_titleSuggestions\[key\] = hit\.card\.title/,
      "seeding the current title reuses applyTitleSuggestions' verified persistence");
    assert.doesNotMatch(b, /putCards|putSaved|persistCards/,
      "must NOT persist directly — Apply owns the write, so there's only one path to keep correct");
  });
  t(label + ": the row-key resolver handles both scopes and a missing card", () => {
    const b = fnBody(src, "titleRowCard");
    assert.ok(b, "titleRowCard not found");
    assert.match(b, /scope==="saved" \? saved : imported/, "must pick the right collection");
    assert.match(b, /return card \? \{card, scope, list\} : null/, "must return null for a card that's gone");
  });
}

t("the new card/title helpers are byte-identical between web and pwa (binding parity)", () => {
  for (const fn of ["anchorImpOnCard", "titleRowCard", "titleOpenOriginal", "editTitleManually"]) {
    assert.strictEqual(fnBody(html, fn), fnBody(pwaHtml, fn), fn + " has drifted between web/ and pwa/");
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
