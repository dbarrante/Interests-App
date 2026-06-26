const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const images = require("../core/images");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-img-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

// 1x1 red pixel JPEG, base64
const PIX_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const PIX_DATAURL = "data:image/jpeg;base64," + PIX_B64;

t("imagesDir and imgPath build the expected paths", () => {
  const dir = tmpStore();
  assert.strictEqual(images.imagesDir(dir), path.join(dir, "images"));
  assert.strictEqual(images.imgPath(dir, "abc"), path.join(dir, "images", "abc.jpg"));
});

t("putImg decodes the data URL and writes <id>.jpg with the decoded bytes", () => {
  const dir = tmpStore();
  const file = images.putImg(dir, "abc", PIX_DATAURL);
  assert.strictEqual(file, "abc.jpg");
  const onDisk = fs.readFileSync(path.join(dir, "images", "abc.jpg"));
  assert.deepStrictEqual(onDisk, Buffer.from(PIX_B64, "base64"));
});

t("getImg returns the bytes; null when absent", () => {
  const dir = tmpStore();
  assert.strictEqual(images.getImg(dir, "missing"), null);
  images.putImg(dir, "abc", PIX_DATAURL);
  assert.deepStrictEqual(images.getImg(dir, "abc"), Buffer.from(PIX_B64, "base64"));
});

t("hasImg reflects presence", () => {
  const dir = tmpStore();
  assert.strictEqual(images.hasImg(dir, "abc"), false);
  images.putImg(dir, "abc", PIX_DATAURL);
  assert.strictEqual(images.hasImg(dir, "abc"), true);
});

t("delImg removes the file (idempotent on missing)", () => {
  const dir = tmpStore();
  images.putImg(dir, "abc", PIX_DATAURL);
  images.delImg(dir, "abc");
  assert.strictEqual(images.hasImg(dir, "abc"), false);
  images.delImg(dir, "abc"); // no throw
});

t("imageCount and listImageIds report the .jpg files (ids without extension)", () => {
  const dir = tmpStore();
  assert.strictEqual(images.imageCount(dir), 0);
  images.putImg(dir, "a", PIX_DATAURL);
  images.putImg(dir, "b", PIX_DATAURL);
  assert.strictEqual(images.imageCount(dir), 2);
  assert.deepStrictEqual(images.listImageIds(dir).sort(), ["a", "b"]);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
