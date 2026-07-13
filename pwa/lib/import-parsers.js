// Import parsers + the pure dedupe core (dual browser/Node, route-capture.js
// pattern). DOM-free, Store-free: everything here is a pure transform from raw
// export text (or parsed JSON) to import items, plus the pure decision half of
// ingestImported (which incoming items are new vs duplicates). The impure half
// — array mutation, Store persistence, toasts, renders — stays in index.html
// and calls dedupeImported() here.
//
// Two host-provided helpers are injected once at boot via configure(), so the
// module needs no globals and no DOM:
//   fixTxt(s)  — the host's mojibake fixer (used by clean + fbExtractText)
//   decode(s)  — HTML-entity decode (index.html uses a <textarea>; tests pass a
//                pure decoder). Only parsePinterestSAR needs it.
//
// CSV: parseCSV uses splitCsvLine — the CORRECT doubled-quote ("") algorithm
// copied from web/import-google-saved.js — replacing index.html's old splitCsv
// which mishandled "" (a doubled quote just toggled quote state, dropping the
// literal quote). VISIBLE EFFECT: YouTube/CSV titles containing quotes now
// import with their quotes intact instead of mangled.
(function (root) {
  "use strict";

  var _fixTxt = function (s) { return s; };
  var _decode = function (s) { return s; };
  function configure(opts) {
    opts = opts || {};
    if (typeof opts.fixTxt === "function") _fixTxt = opts.fixTxt;
    if (typeof opts.decode === "function") _decode = opts.decode;
  }

  // normalize a timestamp (Unix seconds/ms or a date string) to ms, or null
  function normTs(v) {
    if (v == null || v === "") return null;
    var n = typeof v === "number" ? v : (Date.parse(v) || Number(v));
    if (!n || isNaN(n)) return null;
    if (n < 1e12) n *= 1000;                       // seconds -> ms
    if (n < 9.46e11 || n > 4.1e12) return null;    // sanity: ~2000..2100
    return n;
  }

  function clean(i) {
    var title = _fixTxt(i.title).replace(/^Watched\s+/, "").trim();
    var o = { title: title.slice(0, 250), url: i.url || null, ts: Date.now() };
    var sd = normTs(i.ts); if (sd) o.sdate = sd;   // real "date saved" from the export (only when known)
    if (i.img) o.img = i.img;
    if (i.desc) o.desc = _fixTxt(i.desc).trim().slice(0, 220);
    return o;
  }

  function harvest(node, out, depth) {
    depth = depth || 0; if (depth > 12 || !node) return;
    if (Array.isArray(node)) { node.forEach(function (n) { harvest(n, out, depth + 1); }); return; }
    if (typeof node === "object") {
      var title = typeof node.title === "string" ? node.title : (typeof node.name === "string" ? node.name : null);
      var img = ["image", "img", "thumbnail"].map(function (k) { return node[k]; }).find(function (v) { return typeof v === "string" && /^https?:\/\//.test(v); }) || null;
      var desc = ["desc", "description", "details"].map(function (k) { return node[k]; }).find(function (v) { return typeof v === "string" && v.trim().length > 10; }) || null;
      var url = ["url", "link", "canonical", "href"].map(function (k) { return node[k]; }).find(function (v) { return typeof v === "string" && /^https?:\/\//.test(v); }) || null;
      if (!url) for (var k in node) { var v = node[k]; if (typeof v === "string" && /^https?:\/\//.test(v) && v !== img) { url = v; break; } }
      var ts = null;
      var tkeys = ["timestamp", "time", "date", "created", "created_time", "createdAt", "saved", "saved_time", "added", "creation_time", "pin_creation_time"];
      for (var ki = 0; ki < tkeys.length; ki++) { var tk = tkeys[ki]; if (node[tk] != null) { var t = normTs(node[tk]); if (t) { ts = t; break; } } }
      if (title && title.trim().length > 5 && title.length < 400 && !/^https?:\/\//i.test(title.trim())) out.push({ title: title.trim(), url: url, img: img, desc: desc, ts: ts });
      for (var k2 in node) harvest(node[k2], out, depth + 1);
    }
  }

  // CORRECT CSV split (doubled-quote aware) — copied from web/import-google-saved.js.
  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } continue; }
      if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseCSV(text) {
    var items = [], ids = [];
    var lines = (text || "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return { items: items, ids: ids };
    var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    var tIdx = head.findIndex(function (h) { return h.includes("channel title"); });
    var vIdx = head.findIndex(function (h) { return h.includes("video id"); });
    lines.slice(1).forEach(function (l) {
      var cols = splitCsvLine(l);
      if (tIdx > -1 && cols[tIdx] && cols[tIdx].length > 2) { items.push({ title: "YouTube channel: " + cols[tIdx] }); }
      else if (vIdx > -1 && /^[\w-]{8,16}$/.test(cols[vIdx] || "")) { ids.push(cols[vIdx]); }
      else if (tIdx === -1 && vIdx === -1) {
        var t = cols.find(function (c) { return c && c.length > 10 && !/^https?:/.test(c); });
        var u = cols.find(function (c) { return /^https?:\/\//.test(c); });
        if (t) items.push({ title: t, url: u || null });
      }
    });
    return { items: items, ids: ids };
  }

  function parsePinterestSAR(text) {
    var items = [];
    var parts = text.split(/<a href="(https:\/\/www\.pinterest\.com\/pin\/\d+\/)">/);
    for (var i = 1; i < parts.length; i += 2) {
      var pinUrl = parts[i], body = parts[i + 1].slice(0, 4000);
      var fld = function (n) {
        var m = body.match(new RegExp(n + ":\\s*([\\s\\S]*?)\\s*<br>"));
        if (!m) return null;
        var v = _decode(m[1].replace(/<[^>]+>/g, "")).trim();
        return (v === "No data" || !v) ? null : v;
      };
      if (fld("Alive") === "No") continue;
      var title = fld("Title"), details = fld("Details"), alt = fld("Alt Text"), img = fld("Image");
      var canon = (body.match(/Canonical Link:\s*<a href="([^"]+)"/) || [])[1] || null;
      var t = title || (details ? details.slice(0, 120) : null) || alt;
      if (!t || t.length < 6) continue;
      var it = { title: t, url: canon || pinUrl, src: "pinterest" };
      if (details && details !== t) it.desc = details;
      if (img && /^[0-9a-f]{32}$/.test(img)) it.img = "https://i.pinimg.com/564x/" + img.slice(0, 2) + "/" + img.slice(2, 4) + "/" + img.slice(4, 6) + "/" + img + ".jpg";
      items.push(it);
    }
    return items;
  }

  function fbDeepName(o) {
    if (Array.isArray(o)) { for (var vi = 0; vi < o.length; vi++) { var r = fbDeepName(o[vi]); if (r) return r; } return null; }
    if (o && typeof o === "object") {
      if (o.label === "Name") return o.value || null;
      for (var k in o) { var r2 = fbDeepName(o[k]); if (r2) return r2; }
    }
    return null;
  }

  function fbExtractMedia(node, imgs) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(function (n) { fbExtractMedia(n, imgs); }); return; }
    var uri = node.uri || node.url || node.src;
    if (typeof uri === "string" && /^https?:\/\//.test(uri) && /\.(jpg|jpeg|png|gif|webp)/i.test(uri)) imgs.push(uri);
    if (typeof uri === "string" && /scontent|fbcdn/.test(uri)) imgs.push(uri);
    for (var k in node) fbExtractMedia(node[k], imgs);
  }

  function fbExtractText(entry) {
    var texts = [];
    if (entry.data) (Array.isArray(entry.data) ? entry.data : [entry.data]).forEach(function (d) {
      if (d.post) texts.push(d.post);
      if (d.comment && d.comment.comment) texts.push(d.comment.comment);
      if (d.text) texts.push(d.text);
    });
    if (entry.title && !/saved|shared|liked/i.test(entry.title)) texts.push(entry.title);
    return texts.map(function (t) { return _fixTxt(String(t)).trim(); }).filter(function (t) { return t.length > 10; }).join(" · ").slice(0, 220);
  }

  function parseFacebookJSON(p) {
    var items = [];
    if (p && Array.isArray(p.saves_v2)) {
      p.saves_v2.forEach(function (e) {
        var imgs = [];
        fbExtractMedia(e, imgs);
        var postText = fbExtractText(e);
        var ts = normTs(e.timestamp);              // original "date saved" (Unix seconds)
        var before = items.length;
        (e.attachments || []).forEach(function (a) {
          (a.data || []).forEach(function (d) {
            var ec = d.external_context;
            if (ec && ec.name && ec.name.length > 5) {
              var it = { title: String(ec.name).trim() };
              if (/^https?:/.test(ec.source || "")) it.url = ec.source;
              if (imgs.length) it.img = imgs[0];
              if (postText && postText.slice(0, 80) !== it.title.slice(0, 80)) it.desc = postText;
              if (ts) it.ts = ts;
              items.push(it);
            }
            if (d.event && d.event.name) items.push({ title: "Event: " + d.event.name, ts: ts || undefined });
          });
        });
        if (items.length === before || !(e.attachments || []).some(function (a) { return (a.data || []).some(function (d) { return d.external_context; }); })) {
          if (postText && postText.length > 10) {
            var it2 = { title: postText.slice(0, 120) };
            if (imgs.length) it2.img = imgs[0];
            if (postText.length > 120) it2.desc = postText;
            if (ts) it2.ts = ts;
            items.push(it2);
          }
        }
      });
      return items;
    }
    if (Array.isArray(p) && p.length && p[0] && Array.isArray(p[0].label_values)) {
      p.forEach(function (col) {
        var cname = "";
        (col.label_values || []).forEach(function (lv) { if (lv.label === "Title") cname = lv.value || ""; });
        (col.label_values || []).forEach(function (lv) {
          if (lv.title !== "Saves" || !Array.isArray(lv.dict)) return;
          lv.dict.forEach(function (item) {
            var url = null, f = {}, group = null, author = null, img = null, ts = normTs(item.timestamp);
            (item.dict || []).forEach(function (ent) {
              if (ent.label === "URL" && /^https?:/.test(ent.value || "")) url = ent.value;
              else if (["Name", "Title", "Description", "Message"].includes(ent.label)) f[ent.label] = ent.value || "";
              else if (ent.label === "Photo" || ent.label === "Image" || ent.label === "Thumbnail") {
                if (/^https?:/.test(ent.value || "")) img = ent.value;
              }
              else if (/^(date|time|saved|created|timestamp)$/i.test(ent.label || "")) { var t = normTs(ent.value || ent.timestamp); if (t) ts = t; }
              else if (ent.timestamp && !ts) { var t2 = normTs(ent.timestamp); if (t2) ts = t2; }
              else if (ent.title === "Group") group = fbDeepName(ent);
              else if (ent.title === "Author") author = fbDeepName(ent);
              else if (!img) { var is = []; fbExtractMedia(ent, is); if (is.length) img = is[0]; }
            });
            if (!url) return;
            var title = f.Title || f.Name || (f.Message || "").slice(0, 120) || (f.Description || "").slice(0, 120);
            if (!title || title.length < 6) title = (group ? group + " post" : "Facebook post") + (author ? " by " + author : "");
            var it = { title: title.trim(), url: url };
            if (img) it.img = img;
            if (ts) it.ts = ts;
            var desc = f.Description || f.Message;
            if (desc && desc.trim() && desc.slice(0, 120) !== title.slice(0, 120)) it.desc = desc.trim();
            else if (group) it.desc = "Saved from " + group + (cname ? " · " + cname : "");
            else if (cname) it.desc = "From your '" + cname + "' Facebook collection";
            items.push(it);
          });
        });
      });
    }
    return items;
  }

  // PURE dedupe core of ingestImported. Decides which `found` items enrich an
  // existing card vs get appended as new — by url identity (else title). Does
  // NOT mutate `existing`, persist, toast, or render: it returns a plan the
  // caller applies. New items get an id via opts.newId (required for appends).
  //
  //   found     incoming items ({title,url,img,desc,sdate,...})
  //   existing  the current `imported` array (read-only here)
  //   opts.newId  () => string, used to stamp appended cards
  // Returns { enrich:[{idx, patch}], append:[card], added, updated }
  //   enrich[].patch = the fields to copy onto existing[idx] (img/desc/url/sdate)
  function dedupeImported(found, existing, opts) {
    opts = opts || {};
    var newId = opts.newId || function () { return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); };
    existing = existing || [];
    var byTitle = new Map(existing.map(function (it, i) { return [it.title.toLowerCase(), i]; }));
    var byUrl = new Map(); existing.forEach(function (it, i) { if (it.url) byUrl.set(it.url, i); });
    var junk = /^(like|comment|share|save|home|menu|profile|settings|see more|watch|reels?|marketplace|groups?|notifications?)$/i;
    var added = 0, updated = 0;
    var enrich = [], append = [];
    var seenThis = new Set();
    // running append count so byTitle/byUrl point at post-append indices, matching
    // index.html's original in-loop map maintenance (imported.length-1).
    var appendBase = existing.length;
    (found || []).forEach(function (i) {
      if (!i || !i.title) return;
      var k = i.title.toLowerCase();
      if (junk.test(k) || /^https?:\/\//i.test(i.title)) return;
      var dk = i.url || ("t:" + k);
      if (seenThis.has(dk)) return;
      seenThis.add(dk);
      var existIdx = i.url ? (byUrl.has(i.url) ? byUrl.get(i.url) : -1)
                           : (byTitle.has(k) ? byTitle.get(k) : -1);
      if (existIdx >= 0) {
        // The match may be a card appended EARLIER IN THIS SAME BATCH (byTitle/
        // byUrl track post-append indices) — resolve those against `append`, not
        // the immutable pre-append `existing`. The old inline code mutated the
        // live array, so same-batch enrichment landed on the just-appended card;
        // that end state is the contract.
        var isAppended = existIdx >= appendBase;
        var ex = isAppended ? append[existIdx - appendBase] : existing[existIdx];
        var patch = {}; var changed = false;
        if (i.img && !ex.img) { patch.img = i.img; changed = true; }
        if (i.desc && (!ex.desc || ex.desc.startsWith("Saved from") || ex.desc.startsWith("From your"))) { patch.desc = i.desc; changed = true; }
        if (i.url && !ex.url) { patch.url = i.url; changed = true; }
        var sd = normTs(i.sdate); if (sd && ex.sdate !== sd) { patch.sdate = sd; changed = true; }
        if (changed) {
          // Appended entries are enriched IN PLACE (the plan's enrich list only
          // ever indexes `existing`, so the applier can't miss same-batch targets
          // regardless of its enrich-vs-append ordering).
          if (isAppended) Object.assign(ex, patch);
          else enrich.push({ idx: existIdx, patch: patch });
          updated++;
        }
      } else {
        if (!i.id) i.id = newId();
        var newIdx = appendBase + append.length;
        append.push(i); added++;
        byTitle.set(k, newIdx);
        if (i.url) byUrl.set(i.url, newIdx);
      }
    });
    return { enrich: enrich, append: append, added: added, updated: updated };
  }

  var api = {
    configure: configure,
    normTs: normTs, clean: clean, harvest: harvest,
    splitCsvLine: splitCsvLine, parseCSV: parseCSV,
    parsePinterestSAR: parsePinterestSAR, parseFacebookJSON: parseFacebookJSON,
    fbDeepName: fbDeepName, fbExtractMedia: fbExtractMedia, fbExtractText: fbExtractText,
    dedupeImported: dedupeImported
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Browser: attach the bare names so index.html's existing calls keep working.
  if (root) {
    root.IA_IMPORT = api;
    root.normTs = normTs;
    root.clean = clean;
    root.harvest = harvest;
    root.parseCSV = parseCSV;
    root.parsePinterestSAR = parsePinterestSAR;
    root.parseFacebookJSON = parseFacebookJSON;
    root.fbDeepName = fbDeepName;
    root.fbExtractMedia = fbExtractMedia;
    root.fbExtractText = fbExtractText;
    root.dedupeImported = dedupeImported;
  }
})(typeof self !== "undefined" ? self : this);
