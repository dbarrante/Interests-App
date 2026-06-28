const assert = require("assert");
const { mergeSnapshots } = require("../core/merge");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

const L = (cards, saved, tombs) => ({ cards: cards || {}, saved: saved || {}, tombstones: tombs || {} });
const peer = (id, cards, saved, tombs, imageIds) =>
  ({ deviceId: id, dir: "/dbx/" + id, cards: cards || [], saved: saved || [], tombstones: tombs || [], imageIds: imageIds || [] });

test("newest updatedAt wins (peer newer -> upsert)", () => {
  const local = L({ c_1: { id: "c_1", url: "old", updatedAt: 100 } });
  const peers = [peer("B", [{ id: "c_1", url: "new", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  const up = r.upserts.find(u => u.kind === "card" && u.item.id === "c_1");
  assert.ok(up && up.item.url === "new" && up.updatedAt === 200);
});

test("local newer -> no upsert", () => {
  const local = L({ c_1: { id: "c_1", url: "local", updatedAt: 300 } });
  const peers = [peer("B", [{ id: "c_1", url: "peer", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(!r.upserts.some(u => u.item.id === "c_1"), "older peer does not overwrite");
});

test("identical item already local -> no upsert (idempotent)", () => {
  const local = L({ c_1: { id: "c_1", url: "x", updatedAt: 200 } });
  const peers = [peer("B", [{ id: "c_1", url: "x", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  assert.strictEqual(r.upserts.length, 0);
});

test("tombstone newer than item -> delete (no resurrect)", () => {
  const local = L({ c_1: { id: "c_1", url: "x", updatedAt: 100 } });
  const peers = [peer("B", [], [], [{ id: "c_1", kind: "card", deletedAt: 500 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.deletes.some(d => d.kind === "card" && d.id === "c_1"));
  assert.ok(!r.upserts.some(u => u.item.id === "c_1"));
});

test("edit newer than delete -> item survives (un-delete)", () => {
  const local = L({}, {}, { "card:c_1": 100 });                       // locally tombstoned at 100
  const peers = [peer("B", [{ id: "c_1", url: "revived", updatedAt: 500 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.upserts.some(u => u.item.id === "c_1"), "later edit beats older delete");
  assert.ok(!r.deletes.some(d => d.id === "c_1"));
});

test("image follows the winning peer item", () => {
  const local = L({ c_1: { id: "c_1", url: "old", img: "idb:c_1", updatedAt: 100 } });
  const peers = [peer("B", [{ id: "c_1", url: "new", img: "idb:c_1", updatedAt: 200 }], [], [], ["c_1"])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.imageCopies.some(ic => ic.id === "c_1" && ic.fromDir === "/dbx/B"));
});

test("empty peers -> no ops", () => {
  const r = mergeSnapshots(L({ c_1: { id: "c_1", updatedAt: 1 } }), []);
  assert.strictEqual(r.upserts.length + r.deletes.length + r.imageCopies.length, 0);
});

test("multi-peer convergence: newest across peers wins", () => {
  const local = L({ c_1: { id: "c_1", url: "v1", updatedAt: 100 } });
  const peers = [
    peer("B", [{ id: "c_1", url: "v2", updatedAt: 200 }]),
    peer("C", [{ id: "c_1", url: "v3", updatedAt: 300 }]),
  ];
  const r = mergeSnapshots(local, peers);
  const up = r.upserts.find(u => u.item.id === "c_1");
  assert.ok(up && up.item.url === "v3" && up.updatedAt === 300);
});

test("conflicts counts real overwrites only", () => {
  const local = L({ c_1: { id: "c_1", url: "mine", updatedAt: 100 }, c_2: { id: "c_2", url: "same", updatedAt: 100 } });
  const peers = [peer("B",
    [{ id: "c_1", url: "theirs", updatedAt: 200 },   // real conflict (content differs)
     { id: "c_3", url: "brandnew", updatedAt: 200 }] // first add, not a conflict
  )];
  const r = mergeSnapshots(local, peers);
  assert.strictEqual(r.conflicts, 1);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
