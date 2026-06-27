// tests/img-traversal.test.js — path-traversal hardening for core/images.js.
// safeImgId / imgPath / getImg / putImg / delImg must reject ids that could
// escape the images dir ('..', '/', '\\', a leading dot). A normal id works.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const images = require("../core/images");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-trav-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

// 1x1 jpeg
const PIX_DATAURL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const BAD_IDS = [
  "..",
  "../evil",
  "..\\evil",
  "foo/bar",
  "foo\\bar",
  "a/../b",
  ".hidden",
  ".",
  "/abs",
  "\\abs",
  "a.b",        // dots disallowed (the .jpg extension is appended by us)
  "",
  "a b",        // space not in the allowed set
];

const GOOD_IDS = ["abc", "c1", "Abc_123-XYZ", "0", "a-b_c"];

t("safeImgId is exported", () => {
  assert.strictEqual(typeof images.safeImgId, "function");
});

t("safeImgId accepts normal ids, rejects dangerous ones", () => {
  for (const id of GOOD_IDS) {
    assert.strictEqual(images.safeImgId(id), id, "should accept " + JSON.stringify(id));
  }
  for (const id of BAD_IDS) {
    assert.throws(() => images.safeImgId(id), "should reject " + JSON.stringify(id));
  }
});

t("imgPath throws on dangerous ids; works for a normal id", () => {
  const dir = tmpStore();
  for (const id of BAD_IDS) {
    assert.throws(() => images.imgPath(dir, id), "imgPath should reject " + JSON.stringify(id));
  }
  assert.strictEqual(images.imgPath(dir, "abc"), path.join(dir, "images", "abc.jpg"));
});

t("getImg throws on dangerous ids; null for a normal missing id", () => {
  const dir = tmpStore();
  for (const id of BAD_IDS) {
    assert.throws(() => images.getImg(dir, id), "getImg should reject " + JSON.stringify(id));
  }
  assert.strictEqual(images.getImg(dir, "missing"), null);
});

t("putImg throws on dangerous ids and never writes outside images/", () => {
  const dir = tmpStore();
  // Sentinel target a traversal would hit: <store>/secret.jpg (one level up from images/).
  const sentinel = path.join(dir, "secret.jpg");
  assert.throws(() => images.putImg(dir, "../secret", PIX_DATAURL));
  assert.strictEqual(fs.existsSync(sentinel), false, "traversal must not create the file outside images/");
  // normal id still works
  images.putImg(dir, "abc", PIX_DATAURL);
  assert.strictEqual(images.hasImg(dir, "abc"), true);
});

t("delImg throws on dangerous ids and does not delete outside images/", () => {
  const dir = tmpStore();
  // plant a file one level up that a traversal would target
  const victim = path.join(dir, "victim.jpg");
  fs.writeFileSync(victim, "keep me");
  assert.throws(() => images.delImg(dir, "../victim"));
  assert.strictEqual(fs.existsSync(victim), true, "traversal must not delete a file outside images/");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
