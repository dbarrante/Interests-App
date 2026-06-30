# og:image URL Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Core finds a card's `og:image` but can't download it server-side ("Preview image wouldn't download"), return the image URL so the app stores and displays it directly via `<img>` — making "Retry all" / "Capture missing" / enrich-on-open actually fix those cards.

**Architecture:** Three thin layers. (1) `core/capturemeta.js` adds an `imageUrl` fallback to each result when the download failed but a valid `http(s)` og URL exists. (2) `core/server.js` `/api/capture-meta` passes `imageUrl` through and treats it as success (clears `reason`). (3) `web/index.html` applies `imageUrl` like a (URL-based) successful capture in both `startBatchCapture` and `enrichOnOpen`.

**Tech Stack:** Node (no framework) for Core + tests; vanilla JS renderer.

## Global Constraints

- Purely additive / non-destructive: only fills an image where there was none; prefers the downloaded copy first, uses the URL only as a fallback.
- `http(s)` only — never `data:`/`javascript:`; guarded at BOTH the Core and the server layers.
- Does NOT change behavior for `social` (Instagram skipped — no `abs`), `no-image` (no og), or `unreachable` cards.
- Tests use plain `node`, no real network: stub `global.fetch` and `require("../core/linkcheck")._setLookup(async()=>[{address:"93.184.216.34",family:4}])`; restore both after.
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: `capturemeta.js` returns the `imageUrl` fallback

**Files:**
- Modify: `core/capturemeta.js` (the result-building block in `captureMetaChunk`, ~lines 113–124)
- Test: `tests/capturemeta-fetch.test.js` (extend)

**Interfaces:**
- Produces: each `captureMetaChunk` result gains `imageUrl: string` — the absolute og URL when `imageDataUrl` is empty AND that URL is `http(s)`; otherwise `""`.

- [ ] **Step 1: Extend the failing test** — in `tests/capturemeta-fetch.test.js`, add these assertions inside the existing `"captureMetaChunk: reason = social / unreachable / no-image / image-failed"` test, right after the line `assert.strictEqual(by.imgfail.reason, "image-failed");` (~line 70):

```js
    assert.strictEqual(by.imgfail.imageUrl, "https://img.test/x.png");   // download failed -> return the og URL
    assert.strictEqual(by.noimg.imageUrl, "");                            // no og -> no fallback url
```

And in the FIRST test (`"captureMetaChunk: page with og:image -> data URL ..."`, ~line 10), after the `imageDataUrl` assertion (~line 18), add:

```js
    assert.strictEqual(out[0].imageUrl, "");   // download succeeded -> no fallback url needed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capturemeta-fetch.test.js`
Expected: FAIL — `imageUrl` is `undefined`, not the expected string.

- [ ] **Step 3: Implement.** In `core/capturemeta.js`, replace this block (~lines 113–124):

```js
        var imageDataUrl = "";
        if (og.image) {
          var abs; try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
          if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
        }
        var reason = "";
        if (!imageDataUrl) {
          if (!page.html) reason = "unreachable";
          else if (og.image) reason = "image-failed";
          else reason = "no-image";
        }
        results[idx] = { id: it.id, imageDataUrl: imageDataUrl, title: og.title, description: og.description, reason: reason };
```

with (hoist `abs` so it's available after the download attempt; add `imageUrl`):

```js
        var imageDataUrl = "";
        var abs = "";
        if (og.image) {
          try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
          if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
        }
        var reason = "";
        if (!imageDataUrl) {
          if (!page.html) reason = "unreachable";
          else if (og.image) reason = "image-failed";
          else reason = "no-image";
        }
        // When the image couldn't be downloaded server-side but a valid http(s) og:image URL was found,
        // return it so the renderer can display it directly via <img> (the browser loads it where the
        // server-side fetch was blocked by hotlink/referer protection). http(s) only.
        var imageUrl = (!imageDataUrl && /^https?:\/\//i.test(abs)) ? abs : "";
        results[idx] = { id: it.id, imageDataUrl: imageDataUrl, imageUrl: imageUrl, title: og.title, description: og.description, reason: reason };
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capturemeta-fetch.test.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add core/capturemeta.js tests/capturemeta-fetch.test.js
git commit -m "feat(capturemeta): return og:image URL fallback when the server download is blocked"
```

---

### Task 2: `/api/capture-meta` passes `imageUrl` through (and treats it as success)

**Files:**
- Modify: `core/server.js` (the `POST /api/capture-meta` result map, ~lines 447–454)
- Test: `tests/capture-meta-endpoint.test.js` (extend)

**Interfaces:**
- Consumes: `r.imageUrl` from Task 1.
- Produces: endpoint result `{ id, hasImage, imageUrl, title, description, reason }`; `imageUrl` is `http(s)` only and only when not `hasImage`; `reason` is `""` when there's any image (downloaded OR url).

- [ ] **Step 1: Write the failing test** — in `tests/capture-meta-endpoint.test.js`, add (after the existing `"endpoint returns reason when no image"` test, ~line 43):

```js
  await t("endpoint returns imageUrl fallback when the image download is blocked", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer }; // non-image -> download fails
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/y.png">' };
    };
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"u1", url:"https://example.test/withimg" }] });
    assert.strictEqual(r.json.results[0].hasImage, false);
    assert.strictEqual(r.json.results[0].imageUrl, "https://img.test/y.png");
    assert.strictEqual(r.json.results[0].reason, "");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-meta-endpoint.test.js`
Expected: FAIL — `imageUrl` is `undefined`.

- [ ] **Step 3: Implement.** In `core/server.js`, replace the result map (~lines 447–454):

```js
      const results = found.map((r) => {
        let hasImage = false;
        if (r && r.imageDataUrl) {
          try { images.putImg(storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        return { id: r && r.id, hasImage: hasImage, title: (r && r.title) || "", description: (r && r.description) || "", reason: hasImage ? "" : ((r && r.reason) || "unreachable") };
      });
```

with:

```js
      const results = found.map((r) => {
        let hasImage = false;
        if (r && r.imageDataUrl) {
          try { images.putImg(storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        const imageUrl = (!hasImage && r && /^https?:\/\//i.test(r.imageUrl || "")) ? r.imageUrl : "";
        return { id: r && r.id, hasImage: hasImage, imageUrl: imageUrl, title: (r && r.title) || "", description: (r && r.description) || "", reason: (hasImage || imageUrl) ? "" : ((r && r.reason) || "unreachable") };
      });
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-meta-endpoint.test.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add core/server.js tests/capture-meta-endpoint.test.js
git commit -m "feat(server): /api/capture-meta passes the og:image URL fallback through as success"
```

---

### Task 3: App applies `imageUrl` as a (URL-based) successful capture

**Files:**
- Modify: `web/index.html` — the `startBatchCapture` result loop (~lines 3309–3317) and the `enrichOnOpen` `Store.captureMeta` block (~line 3220)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: capture-meta result field `imageUrl` (Task 2). Uses existing globals `setCardImage`, `isBadImg`.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("og-url fallback applied: startBatchCapture + enrichOnOpen handle r.imageUrl", () => {
  const si = html.indexOf("async function startBatchCapture");
  const sb = html.slice(si, si + 3200);
  assert.ok(sb.indexOf("imageUrl") >= 0, "startBatchCapture applies imageUrl");
  const ei = html.indexOf("async function enrichOnOpen(");
  const eb = html.slice(ei, ei + 2400);
  assert.ok(eb.indexOf("m.imageUrl") >= 0, "enrichOnOpen applies m.imageUrl");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `startBatchCapture applies imageUrl`.

- [ ] **Step 3a: `startBatchCapture` result loop.** Replace this block (~lines 3309–3317):

```js
      results.forEach(r=>{
        const c=r&&byId[r.id]; if(!c) return;
        if(r.hasImage){ c.img="idb:"+c.id; c.capReason=""; got++; }
        else { c.capReason = r.reason || "unreachable"; }
        const dom=domain(c.url)||"";
        if(r.title && (!c.title || c.title===dom)) c.title=r.title;
        if(r.description && !c.description) c.description=r.description;
        c.lastUpdate=Date.now(); c.lastResult = r.hasImage ? "ok" : "fail";
      });
```

with (add the `imageUrl` branch + count it as ok):

```js
      results.forEach(r=>{
        const c=r&&byId[r.id]; if(!c) return;
        if(r.hasImage){ c.img="idb:"+c.id; c.capReason=""; got++; }
        else if(r.imageUrl){ setCardImage(c, r.imageUrl); c.capReason=""; got++; }   // og:image URL fallback — app displays it directly via <img>
        else { c.capReason = r.reason || "unreachable"; }
        const dom=domain(c.url)||"";
        if(r.title && (!c.title || c.title===dom)) c.title=r.title;
        if(r.description && !c.description) c.description=r.description;
        c.lastUpdate=Date.now(); c.lastResult = (r.hasImage || r.imageUrl) ? "ok" : "fail";
      });
```

- [ ] **Step 3b: `enrichOnOpen`.** Find this line (~3220):

```js
          if(m.hasImage && isBadImg(it.img)){ setCardImage(it, "idb:"+it.id); changed=true; }
```

Add the fallback branch immediately after it:

```js
          else if(m.imageUrl && isBadImg(it.img)){ setCardImage(it, m.imageUrl); changed=true; }   // og:image URL fallback
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): apply the og:image URL fallback as a successful capture"
```

---

## Notes for the executor

- After all three tasks pass, run the **data-safety-reviewer** on the branch (it changes how a capture result mutates a card + the Core image path; purely additive — fills an image, never deletes). The **electron-security-reviewer** is not needed (no new endpoint/IPC/extension; the returned `imageUrl` came from the Core's existing SSRF-guarded fetch, and it's displayed as a client-side `<img>`). Then bump `package.json` 1.5.5 → 1.5.6 and rebuild the installer (`npm run dist`) — the app must be fully CLOSED first (it locks `dist\win-unpacked`).
- `setCardImage(c, url)` stores a non-`data:` `src` as the URL itself (and cleans up any prior `idb:` blob) — confirm by reading its definition before relying on it.
