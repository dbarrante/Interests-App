// Pure decision for YouTube's save UI: is this click a real "add to a playlist"?
// Dual browser/Node (like web/route-capture.js) so it gets a real unit test.
// Rules: an opener never fires (it just opens the dialog); a one-click "Save to
// Watch later" fires; a playlist row fires only when it's in the dialog AND
// currently UN-checked (about to toggle on). Unknown checked-state = no fire.
(function (root) {
  "use strict";
  function ytShouldFireAdd(o) {
    o = o || {};
    if (o.isSavePlaylistOpener) return false;
    if (o.isWatchLaterMenuItem) return true;
    if (o.inPlaylistDialog && o.ariaChecked === false) return true;
    return false;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { ytShouldFireAdd: ytShouldFireAdd };
  if (root) root.ytShouldFireAdd = ytShouldFireAdd;
})(typeof self !== "undefined" ? self : this);
