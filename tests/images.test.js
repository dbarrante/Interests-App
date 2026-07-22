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

t("copyImg preserves source bytes under the keeper id and verifies the copy", () => {
  const dir = tmpStore();
  images.putImg(dir, "source", PIX_DATAURL);
  assert.strictEqual(images.copyImg(dir, "source", "keeper"), true);
  assert.deepStrictEqual(images.getImg(dir, "keeper"), images.getImg(dir, "source"));
  assert.strictEqual(images.copyImg(dir, "missing", "other"), false);
});

t("putImg throws EMPTY_IMAGE on an empty decoded payload instead of writing a corrupt 0-byte file", () => {
  const dir = tmpStore();
  assert.throws(() => images.putImg(dir, "abc", "data:image/jpeg;base64,"), (e) => e.code === "EMPTY_IMAGE");
  assert.strictEqual(fs.existsSync(path.join(dir, "images", "abc.jpg")), false, "no file must be written on rejection");
});

t("getImg treats a 0-byte file on disk as missing (returns null, not an empty Buffer)", () => {
  const dir = tmpStore();
  // Simulate pre-existing corruption by writing directly, bypassing putImg's new guard.
  fs.writeFileSync(images.imgPath(dir, "corrupt"), Buffer.alloc(0));
  assert.strictEqual(images.getImg(dir, "corrupt"), null);
});

t("imageCount and listImageIds report the .jpg files (ids without extension)", () => {
  const dir = tmpStore();
  assert.strictEqual(images.imageCount(dir), 0);
  images.putImg(dir, "a", PIX_DATAURL);
  images.putImg(dir, "b", PIX_DATAURL);
  assert.strictEqual(images.imageCount(dir), 2);
  assert.deepStrictEqual(images.listImageIds(dir).sort(), ["a", "b"]);
});

// --- sniffImageType (Task 3, v1.10.0 iPhone-sync prep) ---
t("sniffImageType: JPEG magic bytes -> image/jpeg", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.strictEqual(images.sniffImageType(buf), "image/jpeg");
});

t("sniffImageType: PNG magic bytes -> image/png", () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.strictEqual(images.sniffImageType(buf), "image/png");
});

t("sniffImageType: GIF magic bytes -> image/gif", () => {
  const buf = Buffer.from("GIF89a", "ascii");
  assert.strictEqual(images.sniffImageType(buf), "image/gif");
});

t("sniffImageType: WebP (RIFF....WEBP) -> image/webp", () => {
  const buf = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // file size (irrelevant to sniff)
    Buffer.from("WEBP", "ascii"),
  ]);
  assert.strictEqual(images.sniffImageType(buf), "image/webp");
});

t("sniffImageType: garbage bytes default to image/jpeg", () => {
  const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  assert.strictEqual(images.sniffImageType(buf), "image/jpeg");
  assert.strictEqual(images.sniffImageType(Buffer.alloc(0)), "image/jpeg");
});

// --- imageManifest ---
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

t("imageManifest: empty store -> []", () => {
  const dir = tmpStore();
  assert.deepStrictEqual(images.imageManifest(dir), []);
});

t("imageManifest: JPEG and PNG-bytes-under-.jpg-name both reported correctly", () => {
  const dir = tmpStore();
  images.putImg(dir, "jpegid", PIX_DATAURL); // real JPEG bytes
  // Write PNG bytes directly under <id>.jpg, bypassing putImg's decode path,
  // to simulate the "PNG stored under a .jpg filename" case from the review.
  const pngPath = images.imgPath(dir, "pngid");
  fs.writeFileSync(pngPath, PNG_HEADER);

  const manifest = images.imageManifest(dir).sort((a, b) => a.id.localeCompare(b.id));
  assert.strictEqual(manifest.length, 2);

  const jpegEntry = manifest.find((m) => m.id === "jpegid");
  assert.strictEqual(jpegEntry.type, "image/jpeg");
  assert.strictEqual(jpegEntry.size, Buffer.from(PIX_B64, "base64").length);

  const pngEntry = manifest.find((m) => m.id === "pngid");
  assert.strictEqual(pngEntry.type, "image/png");
  assert.strictEqual(pngEntry.size, PNG_HEADER.length);
});

t("imageManifest: a file that vanishes mid-scan is omitted, not thrown", () => {
  const dir = tmpStore();
  images.putImg(dir, "keep", PIX_DATAURL);
  images.putImg(dir, "vanish", PIX_DATAURL);
  // Delete the file right after listImageIds would have seen it, by monkey-
  // patching statSync just for this id to simulate the race.
  const origStat = fs.statSync;
  fs.statSync = function (p, ...rest) {
    if (String(p).indexOf("vanish.jpg") !== -1) {
      const err = new Error("ENOENT simulated");
      err.code = "ENOENT";
      throw err;
    }
    return origStat.call(fs, p, ...rest);
  };
  let manifest;
  try {
    manifest = images.imageManifest(dir);
  } finally {
    fs.statSync = origStat;
  }
  assert.strictEqual(manifest.length, 1);
  assert.strictEqual(manifest[0].id, "keep");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
