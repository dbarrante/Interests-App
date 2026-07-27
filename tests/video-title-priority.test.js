// tests/video-title-priority.test.js — the AI title pipeline must read a video's
// BURNED-IN caption before falling back to the post's description.
//
// Why: a social video's on-screen text is the creator's own title for it
// ("Junkyard 1970s Ford F600 Uhaul sitting for years. Will it run?"), while the
// post description is usually the sharer's blurb, a hashtag dump, or platform
// boilerplate. For this one card type the normal description-beats-OCR order
// picks the worse signal.
//
// looksLikeVideo is a pure function, so it is evaluated for real rather than
// regex-matched; the tier ORDER is checked structurally (it depends on the DOM,
// Tesseract, and a live AI key).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

function extractFn(src, name) {
  const re = new RegExp("function " + name + "\\(card\\)\\{[\\s\\S]*?\\n\\}");
  const m = re.exec(src);
  assert.ok(m, name + " not found");
  return m[0];
}

const CASES = [
  // The screenshot that prompted this: a Facebook page video whose frame carries
  // the creator's title.
  ["https://www.facebook.com/NoNonsenseKnowHow/videos/1234567890/", null, true, "FB page video"],
  ["https://fb.watch/abc123/", null, true, "fb.watch share link"],
  ["https://www.facebook.com/reel/998877", null, true, "FB reel"],
  ["https://www.instagram.com/reel/Cxyz/", null, true, "IG reel"],
  ["https://www.instagram.com/tv/Cxyz/", null, true, "IGTV"],
  ["https://www.youtube.com/watch?v=abc", null, true, "YouTube watch"],
  ["https://youtu.be/abc", null, true, "youtu.be short link"],
  ["https://www.tiktok.com/@someone/video/1", null, true, "TikTok"],
  ["https://vimeo.com/12345", null, true, "Vimeo"],
  // Non-videos keep the cheap text-first order — OCR is expensive and their
  // images rarely carry a title.
  ["https://example.com/blog/how-to-weld", null, false, "plain article"],
  ["https://www.pinterest.com/pin/12345/", null, false, "Pinterest pin"],
  ["https://example.com/x", "Shop layout ideas for a two-car garage", false, "article with no video words"],
  // Text signal, with word boundaries so substrings don't false-positive.
  ["https://example.com/x", "Video: welding basics", true, "title says video"],
  ["https://example.com/x", "Shortbread recipe", false, "'short' inside a word"],
  ["https://example.com/x", "Watchmaking guide", false, "'watch' inside a word"],
  ["", null, false, "card with no url or title"],
];

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  const looksLikeVideo = new Function(extractFn(src, "looksLikeVideo") + "; return looksLikeVideo;")();

  t(label + ": looksLikeVideo classifies real card shapes correctly", () => {
    for (const [url, title, want, why] of CASES) {
      const card = {};
      if (url) card.url = url;
      if (title) card.title = title;
      assert.strictEqual(looksLikeVideo(card), want, why + " → expected " + want);
    }
  });
  t(label + ": looksLikeVideo tolerates a missing/!object card", () => {
    assert.strictEqual(looksLikeVideo({}), false);
    assert.strictEqual(looksLikeVideo(null), false);
    assert.strictEqual(looksLikeVideo(undefined), false);
  });

  t(label + ": videos OCR the frame BEFORE using the description", () => {
    const m = /async function generateUniqueTitle\(card, extraAvoid, allowVision=true\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "generateUniqueTitle not found");
    const body = m[1];
    const videoOcr = body.indexOf("if(looksLikeVideo(card)){");
    // generateUniqueTitle returns { title, failReason } (Task 4 Finding B), so
    // the description tier's return is now `return { title: await
    // titleFromSignal(...), failReason: "" }` rather than a bare
    // `return titleFromSignal(...)` -- same tier, same ordering, just wrapped.
    const descTier = body.indexOf("if(description) return { title: await titleFromSignal");
    assert.ok(videoOcr >= 0, "the video branch is missing");
    assert.ok(descTier >= 0, "the description tier is missing");
    assert.ok(videoOcr < descTier,
      "the burned-in caption must be read BEFORE the description — that ordering is the whole feature");
  });
  t(label + ": the burned-in text is flagged as OCR, not passed off as a description", () => {
    assert.match(src, /const burned = await ocrExtractText\(card\);\s*\r?\n\s*if\(burned\) return \{ title: await titleFromSignal\(card, \{description:burned, ocr:true,/,
      "must set ocr:true so the prompt knows the text came from an image, not the page");
  });
  t(label + ": a video does not run OCR twice", () => {
    assert.match(src, /const ocrText = looksLikeVideo\(card\) \? null : await ocrExtractText\(card\);/,
      "the lower OCR tier must skip video cards — they already tried above, and Tesseract is expensive");
  });
}

t("the video-title path is byte-identical between web and pwa (binding parity)", () => {
  assert.strictEqual(extractFn(html, "looksLikeVideo"), extractFn(pwaHtml, "looksLikeVideo"),
    "looksLikeVideo has drifted between web/ and pwa/");
  const re = /async function generateUniqueTitle\(card, extraAvoid, allowVision=true\)\{[\s\S]*?\n\}/;
  assert.strictEqual(re.exec(html)[0], re.exec(pwaHtml)[0],
    "generateUniqueTitle has drifted between web/ and pwa/");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
