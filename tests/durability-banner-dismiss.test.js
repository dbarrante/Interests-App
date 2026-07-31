// tests/durability-banner-dismiss.test.js — code review follow-up on commit
// 7e3d5be's self-caught durability-banner fix: the banner's "Back up now"
// button was changed from `if(res) b.remove()` to guard against undefined
// (re-entrancy-guard rejection or a thrown error), but that guard alone
// still dismissed the banner on a genuine, truthy backup failure --
// backupNow()/doBackup() resolve `{ok:false, reason:...}` (a truthy object,
// not undefined) on documented failure paths in core/backup.js (missing db,
// verification failure, etc). That is exactly the scenario the durability
// banner exists to warn about ("backups can't run right now"), so clicking
// "Back up now" while it's failing must NOT make the warning disappear.
// Fix: `if(res && res.ok!==false) b.remove()`, matching the `res.ok===false`
// idiom doBackup() itself already uses one line above.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); pass++; console.log("  ok  " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
}
function fnSrc(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found in source");
  return m;
}

// Minimal DOM stand-in covering exactly what showDurabilityBanner touches:
// document.getElementById("durBanner") (presence check), document.createElement("div")
// (the banner itself), banner.querySelector("button") (to wire the onclick),
// and document.querySelector("main") (to prepend it). No jsdom dependency needed.
function makeFakeDom() {
  let removed = false;
  const button = { onclick: null };
  const banner = {
    className: null, id: null, innerHTML: null,
    querySelector: function (sel) { return sel === "button" ? button : null; },
    remove: function () { removed = true; },
  };
  const main = { prepend: function () {} };
  const document = {
    getElementById: function (id) { return null; }, // banner not already present -> proceeds to build one
    createElement: function (tag) { return banner; },
    querySelector: function (sel) { return sel === "main" ? main : null; },
  };
  return { document, button, isRemoved: () => removed };
}

function loadShowDurabilityBanner(src, document, backupNow) {
  const body = fnSrc(src, "showDurabilityBanner") + "\nreturn showDurabilityBanner;";
  const factory = new Function("document", "backupNow", body);
  return factory(document, backupNow);
}

async function run() {
  for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
    await t(label + ": clicking \"Back up now\" does NOT dismiss the banner when backupNow() resolves a truthy {ok:false} failure", async () => {
      const dom = makeFakeDom();
      const showDurabilityBanner = loadShowDurabilityBanner(src, dom.document, function () {
        return Promise.resolve({ ok: false, reason: "service unreachable" });
      });

      showDurabilityBanner("lapsed");
      await dom.button.onclick();

      assert.strictEqual(dom.isRemoved(), false, "banner must stay visible -- the backup genuinely did not happen");
    });

    await t(label + ": clicking \"Back up now\" does NOT dismiss the banner when backupNow() resolves undefined (guard-rejected or threw)", async () => {
      const dom = makeFakeDom();
      const showDurabilityBanner = loadShowDurabilityBanner(src, dom.document, function () {
        return Promise.resolve(undefined);
      });

      showDurabilityBanner("connected");
      await dom.button.onclick();

      assert.strictEqual(dom.isRemoved(), false, "banner must stay visible -- no backup result was reported");
    });

    await t(label + ": clicking \"Back up now\" DOES dismiss the banner when backupNow() resolves a genuine success", async () => {
      const dom = makeFakeDom();
      const showDurabilityBanner = loadShowDurabilityBanner(src, dom.document, function () {
        return Promise.resolve({ ok: true });
      });

      showDurabilityBanner("connected");
      await dom.button.onclick();

      assert.strictEqual(dom.isRemoved(), true, "banner must be dismissed on genuine success -- the fix must not overcorrect into never dismissing");
    });
  }

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

run();
