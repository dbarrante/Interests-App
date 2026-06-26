const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildContext } = require("../core/appctx");
const db = require("../core/db");

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log("  ok  "+name); }catch(e){ fail++; console.log("  FAIL "+name+" — "+e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-appctx-"));

t("buildContext opens a real DB at the given store dir", () => {
  const ctx = buildContext(dir);
  assert.ok(ctx.db, "ctx.db should be set");
  assert.strictEqual(ctx.storeDir, dir);
  assert.ok(fs.existsSync(path.join(dir, "interests.db")), "interests.db created");
  const c = db.counts(ctx.db);
  assert.strictEqual(c.cards, 0);
  assert.strictEqual(c.saved, 0);
});

t("reopen() rebinds ctx.db to a working handle", () => {
  const ctx = buildContext(dir);
  const before = ctx.db;
  const after = ctx.reopen();
  assert.ok(after, "reopen returns a handle");
  assert.strictEqual(ctx.db, after, "ctx.db rebound");
  assert.notStrictEqual(after, before, "a new handle");
  assert.strictEqual(db.counts(ctx.db).cards, 0, "reopened handle works");
});

t("getStorePath/setStorePath are passed through", () => {
  const ctx = buildContext(dir);
  assert.strictEqual(typeof ctx.getStorePath, "function");
  assert.strictEqual(typeof ctx.setStorePath, "function");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
