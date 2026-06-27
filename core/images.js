// core/images.js — one .jpg file per picture under storeDir/images.
// Replaces IndexedDB ia_img; removes the ~512 MB single-string ceiling.
const fs = require("fs");
const path = require("path");

function imagesDir(storeDir) {
  return path.join(storeDir, "images");
}

// Reject any id that could escape the images dir. The id becomes a filename
// (<id>.jpg), so it must contain only [A-Za-z0-9_-] — no dots (so no ".." and
// no extra extensions), no slashes/backslashes, and not be empty. Throws on a
// bad id; returns the id unchanged when it is safe.
function safeImgId(id) {
  if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) return id;
  const err = new Error("invalid image id");
  err.code = "INVALID_IMG_ID";
  throw err;
}

function imgPath(storeDir, id) {
  const safe = safeImgId(id);
  const p = path.join(imagesDir(storeDir), safe + ".jpg");
  // Belt-and-suspenders: even with a validated id, confirm the resolved path is
  // contained within the images dir before any fs op touches it.
  const root = path.resolve(imagesDir(storeDir)) + path.sep;
  if (!path.resolve(p).startsWith(root)) {
    const err = new Error("image path escapes store");
    err.code = "INVALID_IMG_ID";
    throw err;
  }
  return p;
}

// Decode a data: URL's base64 payload to a Buffer. Accepts "data:<mime>;base64,<b64>".
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const i = s.indexOf("base64,");
  const b64 = i >= 0 ? s.slice(i + 7) : s;
  return Buffer.from(b64, "base64");
}

function putImg(storeDir, id, dataUrl) {
  const p = imgPath(storeDir, id);   // validates id first; throws on a bad id
  fs.mkdirSync(imagesDir(storeDir), { recursive: true });
  fs.writeFileSync(p, decodeDataUrl(dataUrl));
  return id + ".jpg";
}

function getImg(storeDir, id) {
  const p = imgPath(storeDir, id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function hasImg(storeDir, id) {
  return fs.existsSync(imgPath(storeDir, id));
}

function delImg(storeDir, id) {
  const p = imgPath(storeDir, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function listImageIds(storeDir) {
  const dir = imagesDir(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).map(f => f.slice(0, -4));
}

function imageCount(storeDir) {
  return listImageIds(storeDir).length;
}

module.exports = { imagesDir, imgPath, safeImgId, putImg, getImg, hasImg, delImg, imageCount, listImageIds };
