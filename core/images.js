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

// Sniff an image's MIME type from its leading magic bytes. Pure function over
// a Buffer — used both by the manifest (which reads only the first 16 bytes
// per file) and by GET /api/img/:id (which already has the full buffer in
// hand). Defaults to image/jpeg when nothing matches — that mirrors the prior
// hardcoded behavior for genuinely-JPEG files and any unrecognized format.
function sniffImageType(buf) {
  if (!buf || buf.length < 3) return "image/jpeg";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 4 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  return "image/jpeg";
}

// Enumerate every stored image as {id, size, type} for a future phone client
// to diff against its local cache. Reads only the first 16 bytes of each file
// (open/read/close) for sniffing — never the full image — and statSync for
// size. A file that vanishes mid-scan (deleted concurrently) is silently
// omitted rather than failing the whole manifest.
function imageManifest(storeDir) {
  const ids = listImageIds(storeDir);
  const out = [];
  const head = Buffer.alloc(16);
  for (const id of ids) {
    let p;
    try { p = imgPath(storeDir, id); } catch (e) { continue; }
    let fd;
    try {
      const st = fs.statSync(p);
      fd = fs.openSync(p, "r");
      const bytesRead = fs.readSync(fd, head, 0, 16, 0);
      const type = sniffImageType(head.subarray(0, bytesRead));
      out.push({ id, size: st.size, type });
    } catch (e) {
      // vanished mid-scan or unreadable — omit this id
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
    }
  }
  return out;
}

module.exports = { imagesDir, imgPath, safeImgId, putImg, getImg, hasImg, delImg, imageCount, listImageIds, sniffImageType, imageManifest };
