// core/images.js — one .jpg file per picture under storeDir/images.
// Replaces IndexedDB ia_img; removes the ~512 MB single-string ceiling.
const fs = require("fs");
const path = require("path");

function imagesDir(storeDir) {
  return path.join(storeDir, "images");
}
function imgPath(storeDir, id) {
  return path.join(imagesDir(storeDir), id + ".jpg");
}

// Decode a data: URL's base64 payload to a Buffer. Accepts "data:<mime>;base64,<b64>".
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const i = s.indexOf("base64,");
  const b64 = i >= 0 ? s.slice(i + 7) : s;
  return Buffer.from(b64, "base64");
}

function putImg(storeDir, id, dataUrl) {
  const dir = imagesDir(storeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(imgPath(storeDir, id), decodeDataUrl(dataUrl));
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

module.exports = { imagesDir, imgPath, putImg, getImg, hasImg, delImg, imageCount, listImageIds };
