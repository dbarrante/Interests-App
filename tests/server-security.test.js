// tests/server-security.test.js — input-validation & CSRF hardening on the
// local Express API: restore-name allowlist, absolute-path checks for
// import/move, the Origin allowlist middleware, the CSP header, and the
// image-id 400 mapping. Mounts createServer() on an ephemeral port.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../core/server");
const db = require("../core/db");
const config = require("../core/config");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sec-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise((res) => {
    const srv = http.createServer(app).listen(0, "127.0.0.1", () => {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}
// Raw HTTP GET with a hand-crafted Host header. fetch()/undici refuses to let a
// custom Host override the connection authority, so we speak HTTP over a socket
// to exercise the Host-allowlist middleware with arbitrary (incl. attacker) Host
// values. Returns { status, body }.
function rawGet(port, hostHeader, pathStr) {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      // Use HTTP/1.0 when omitting Host: HTTP/1.1 mandates a Host header and Node's
      // parser 400s a 1.1 request without one BEFORE app middleware sees it. HTTP/1.0
      // has no such requirement, so the absent-Host path reaches our middleware.
      const ver = hostHeader == null ? "HTTP/1.0" : "HTTP/1.1";
      const lines = ["GET " + pathStr + " " + ver];
      if (hostHeader != null) lines.push("Host: " + hostHeader);
      lines.push("Connection: close", "", "");
      sock.write(lines.join("\r\n"));
    });
    let data = "";
    sock.on("data", (d) => { data += d.toString("utf8"); });
    sock.on("end", () => {
      const status = parseInt((data.match(/^HTTP\/1\.1 (\d+)/) || [])[1], 10);
      const body = data.slice(data.indexOf("\r\n\r\n") + 4);
      resolve({ status, body });
    });
    sock.on("error", reject);
  });
}
async function post(base, route, body, headers) {
  return fetch(base + route, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: JSON.stringify(body || {})
  });
}

(async () => {
  // Point the backup dir at a throwaway folder so listBackups() never touches Dropbox.
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sec-bk-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));

  const storeDir = tmpStore();
  const database = db.openDb(storeDir);
  const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {}, reopen: () => db.openDb(storeDir) };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  try {
    // --- restore name allowlist (HIGH) ---
    await t("POST /api/restore with a traversal name -> 400 (not passed to backup.restore)", async () => {
      const r = await post(base, "/api/restore", { name: "../../evil" });
      assert.strictEqual(r.status, 400);
      const j = await r.json();
      assert.strictEqual(j.ok, false);
    });
    await t("POST /api/restore with an absolute path name -> 400", async () => {
      const r = await post(base, "/api/restore", { name: "C:\\Windows\\System32" });
      assert.strictEqual(r.status, 400);
    });
    await t("POST /api/restore with a missing/empty name -> 400", async () => {
      const r = await post(base, "/api/restore", {});
      assert.strictEqual(r.status, 400);
    });
    await t("POST /api/restore with a well-formed but non-existent dated name -> NOT 400 (passes validation)", async () => {
      const r = await post(base, "/api/restore", { name: "interests-backup-2099-01-01" });
      assert.notStrictEqual(r.status, 400);  // passes the allowlist; backup.restore returns {ok:false} for a missing folder
    });

    // --- import srcDir absolute-path check (HIGH) ---
    await t("POST /api/import with a relative srcDir -> 400", async () => {
      const r = await post(base, "/api/import", { srcDir: "some/relative/dir" });
      assert.strictEqual(r.status, 400);
    });
    await t("POST /api/import with an empty srcDir -> 400", async () => {
      const r = await post(base, "/api/import", { srcDir: "" });
      assert.strictEqual(r.status, 400);
    });

    // --- store move target absolute-path check (HIGH) ---
    await t("POST /api/store-location/move with a relative target -> 400", async () => {
      const r = await post(base, "/api/store-location/move", { target: "relative/target" });
      assert.strictEqual(r.status, 400);
    });
    await t("POST /api/store-location/move with an empty target -> 400", async () => {
      const r = await post(base, "/api/store-location/move", { target: "" });
      assert.strictEqual(r.status, 400);
    });

    // --- Origin allowlist (MEDIUM) ---
    await t("GET /api/ping with no Origin header -> 200 (same-origin/navigation)", async () => {
      const r = await fetch(base + "/api/ping");
      assert.strictEqual(r.status, 200);
    });
    await t("GET /api/ping with a localhost Origin -> 200", async () => {
      const r = await fetch(base + "/api/ping", { headers: { Origin: "http://localhost:3456" } });
      assert.strictEqual(r.status, 200);
    });
    await t("GET /api/ping with a 127.0.0.1 Origin -> 200", async () => {
      const r = await fetch(base + "/api/ping", { headers: { Origin: base } });
      assert.strictEqual(r.status, 200);
    });
    await t("GET /api/ping with a chrome-extension Origin -> 200", async () => {
      const r = await fetch(base + "/api/ping", { headers: { Origin: "chrome-extension://abcdefghijklmnop" } });
      assert.strictEqual(r.status, 200);
    });
    await t("GET /api/ping with a malicious https Origin -> 403", async () => {
      const r = await fetch(base + "/api/ping", { headers: { Origin: "https://evil.example.com" } });
      assert.strictEqual(r.status, 403);
    });

    // --- Host allowlist (DNS-rebinding fix) ---
    // fetch()/undici will not let a custom Host override the connection authority,
    // so these use rawGet() to speak HTTP with an arbitrary Host header.
    const secPort = srv.address().port;
    // ACCEPT matrix: loopback HOSTNAME on ANY port (the harness itself binds an
    // ephemeral port), localhost, IPv6 [::1]:port, bare host, and absent-Host over
    // a loopback socket (this connection IS loopback → the no-Host path allows it).
    for (const host of ["127.0.0.1:3456", "127.0.0.1:65000", "localhost:3456", "localhost", "[::1]:3456", "127.0.0.1", "[::1]"]) {
      await t("Host: " + host + " -> 200 (loopback hostname accepted, port ignored)", async () => {
        const r = await rawGet(secPort, host, "/api/ping");
        assert.strictEqual(r.status, 200);
      });
    }
    await t("absent Host header over loopback socket -> 200 (remoteAddress is loopback)", async () => {
      const r = await rawGet(secPort, null, "/api/ping");
      assert.strictEqual(r.status, 200);
    });
    await t("extension-style fetch (127.0.0.1 authority + chrome-extension Origin) -> 200", async () => {
      const r = await fetch(base + "/api/ping", { headers: { Origin: "chrome-extension://abcdefghijklmnop" } });
      assert.strictEqual(r.status, 200);
    });
    // REJECT matrix: a DNS-rebound attacker host (the core threat), with or without
    // a loopback-range port, and a subdomain-of-loopback trick. Empty-string Host
    // with a NON-loopback socket cannot be simulated here (the test connection is
    // always loopback) — documented in the report; the absent-Host accept case
    // above exercises the loopback-socket branch of the same code path.
    for (const host of ["evil.com", "evil.com:3456", "127.0.0.1.evil.com", "127.0.0.1.evil.com:3456"]) {
      await t("Host: " + host + " -> 403 forbidden host (rebinding rejected)", async () => {
        const r = await rawGet(secPort, host, "/api/ping");
        assert.strictEqual(r.status, 403);
        assert.ok(r.body.indexOf("forbidden host") >= 0, "body says forbidden host");
      });
    }

    // --- CSP header (MEDIUM) ---
    await t("served HTML carries a Content-Security-Policy header", async () => {
      const r = await fetch(base + "/");
      assert.strictEqual(r.status, 200);
      const csp = r.headers.get("content-security-policy");
      assert.ok(csp && csp.indexOf("default-src 'self'") >= 0, "CSP present with default-src 'self'");
    });

    // --- image-id 400 mapping (CRITICAL companion) ---
    // These percent-encoded ids reach the :id route param as a traversal value
    // and must be rejected with 400 (not a 500 stack or an out-of-dir fs op).
    for (const enc of ["%2e%2e%2fsecret" /* ../secret */, "..%2fsecret", "%2ehidden" /* .hidden */, "abc%5cdef" /* abc\def */, "a.b"]) {
      await t("GET /api/img/" + enc + " -> 400 (invalid id, not 500)", async () => {
        const r = await fetch(base + "/api/img/" + enc);
        assert.strictEqual(r.status, 400);
      });
    }
    await t("PUT /api/img/<bad id> -> 400", async () => {
      const r = await fetch(base + "/api/img/%2e%2e%2fevil", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "data:image/jpeg;base64,/9j/" })
      });
      assert.strictEqual(r.status, 400);
    });
    await t("GET /api/img/<valid-but-missing> -> 404", async () => {
      const r = await fetch(base + "/api/img/doesnotexist");
      assert.strictEqual(r.status, 404);
    });

  } finally {
    await new Promise((res) => srv.close(res));
    try { ctx.db.close(); } catch (e) {}
    config.saveConfig(orig || {});
  }

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
