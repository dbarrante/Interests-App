// extension/options.js — interests picker. Reads categories from the running
// Interests app (loopback port scan, same range as background.js) and saves the
// selected category keys to chrome.storage.local for the stumble loop to send.
var PORTS = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];
var list = document.getElementById("list");
var status = document.getElementById("status");

async function findPort() {
  for (var i = 0; i < PORTS.length; i++) {
    try {
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 500);
      var r = await fetch("http://127.0.0.1:" + PORTS[i] + "/api/ping", { signal: ctl.signal });
      clearTimeout(tm);
      if (r && r.ok) { var j = await r.json(); if (j && j.app === "interests") return PORTS[i]; }
    } catch (e) {}
  }
  return null;
}

async function load() {
  var port = await findPort();
  if (port == null) { list.innerHTML = '<span class="err">Open the Interests app, then reopen this page.</span>'; return; }
  var cats = [];
  try { var r = await fetch("http://127.0.0.1:" + port + "/api/categories"); var j = await r.json(); cats = j.categories || []; } catch (e) {}
  var sel = [];
  try { var s = await chrome.storage.local.get("ia_bstumble_interests"); sel = s.ia_bstumble_interests || []; } catch (e) {}
  if (!cats.length) { list.innerHTML = '<span class="err">No categories found yet.</span>'; return; }
  list.innerHTML = "";
  cats.forEach(function (c) {
    var lab = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = c.key; cb.checked = sel.indexOf(c.key) >= 0;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c.name));
    list.appendChild(lab);
  });
}

document.getElementById("saveBtn").addEventListener("click", async function () {
  var keys = [].slice.call(list.querySelectorAll("input[type=checkbox]")).filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
  try { await chrome.storage.local.set({ ia_bstumble_interests: keys }); status.className = "status"; status.textContent = "Saved " + keys.length + " interest(s)."; }
  catch (e) { status.className = "status err"; status.textContent = "Could not save."; }
});

load();
