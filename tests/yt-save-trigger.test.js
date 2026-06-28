const assert = require("assert");
const { ytShouldFireAdd } = require("../extension/yt-save-trigger");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

test("playlist row toggling ON fires", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true, ariaChecked: false }), true);
});
test("playlist row already checked (a remove/un-tick) does NOT fire", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true, ariaChecked: true }), false);
});
test("one-click 'Save to Watch later' fires", () => {
  assert.strictEqual(ytShouldFireAdd({ isWatchLaterMenuItem: true }), true);
});
test("the 'Save'/'Save to playlist' opener does NOT fire", () => {
  assert.strictEqual(ytShouldFireAdd({ isSavePlaylistOpener: true }), false);
});
test("opener wins over other flags (it only opens the dialog)", () => {
  assert.strictEqual(ytShouldFireAdd({ isSavePlaylistOpener: true, isWatchLaterMenuItem: true }), false);
});
test("a dialog click with unknown checked-state does NOT fire (conservative)", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true }), false);
});
test("a non-dialog, non-watch-later click does not fire", () => {
  assert.strictEqual(ytShouldFireAdd({}), false);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
