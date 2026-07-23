const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../core/db");
const queue = require("../core/capture-queue");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); }
}
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-queue-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

t("validCapture accepts the producer shape and rejects nested/unbounded data", () => {
  assert.strictEqual(queue.validCapture({ url: "https://example.com/p", screenshot: "data:image/jpeg;base64,AAAA", force: true }), true);
  assert.strictEqual(queue.validCapture({ url: "https://example.com/p", meta: { nested: true } }), false);
  assert.strictEqual(queue.validCapture({ url: "https://example.com/p", title: "x".repeat(4097) }), false);
  assert.strictEqual(queue.validCapture({ title: "missing url" }), false);
});

t("claim is bounded and lease acknowledgements are exact", () => {
  const d = db.openDb(store());
  try {
    for (let i = 0; i < queue.MAX_CLAIM + 5; i++) queue.enqueue(d, { url: "https://example.com/" + i });
    const claimed = queue.claim(d, 1000);
    assert.strictEqual(claimed.length, queue.MAX_CLAIM);
    assert.strictEqual(queue.ack(d, [{ id: claimed[0]._captureId, lease: "wrong" }]), 0);
    assert.strictEqual(queue.ack(d, [{ id: claimed[0]._captureId, lease: claimed[0]._captureLease }]), 1);
  } finally { d.close(); }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
