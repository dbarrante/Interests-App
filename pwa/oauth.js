"use strict";

// PKCE OAuth against Dropbox's public-client flow (no client secret — safe for a
// fully static site). See https://developers.dropbox.com/oauth-guide.

const DBX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DBX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DBX_API_URL = "https://api.dropboxapi.com/2";
const DBX_CONTENT_URL = "https://content.dropboxapi.com/2";

const LS_KEYS = {
  appKey: "ia_pwa_app_key",
  redirectUri: "ia_pwa_redirect_uri",
  accessToken: "ia_pwa_access_token",
  refreshToken: "ia_pwa_refresh_token",
  expiresAt: "ia_pwa_expires_at",
};
const SS_KEYS = { verifier: "ia_pwa_code_verifier", state: "ia_pwa_oauth_state" };

function base64url(bytes) {
  let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, len);
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", data);
}

async function beginAuthorize(appKey, redirectUri) {
  const verifier = randomString(64);
  const state = randomString(24);
  sessionStorage.setItem(SS_KEYS.verifier, verifier);
  sessionStorage.setItem(SS_KEYS.state, state);

  const challenge = base64url(await sha256(verifier));
  const url = new URL(DBX_AUTHORIZE_URL);
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("token_access_type", "offline"); // also returns a refresh_token

  location.href = url.toString();
}

// Call on page load. Returns true if this load is an OAuth redirect callback
// (whether it succeeded or failed) so the caller knows to stop and report,
// rather than proceeding as a normal page load.
async function handleRedirectCallback(appKey, redirectUri, log) {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;

  // Strip the query string so a page refresh doesn't try to reuse a spent code.
  history.replaceState({}, "", location.pathname);

  if (error) {
    log("Dropbox authorization failed: " + error + " — " + (params.get("error_description") || ""));
    return true;
  }

  const expectedState = sessionStorage.getItem(SS_KEYS.state);
  const verifier = sessionStorage.getItem(SS_KEYS.verifier);
  if (!verifier || params.get("state") !== expectedState) {
    log("OAuth state mismatch — refusing to exchange code (possible CSRF or stale session).");
    return true;
  }

  try {
    const tokens = await exchangeCodeForToken(appKey, redirectUri, code, verifier);
    storeTokens(tokens);
    log("Connected to Dropbox.");
  } catch (e) {
    log("Token exchange failed: " + e.message);
  } finally {
    sessionStorage.removeItem(SS_KEYS.verifier);
    sessionStorage.removeItem(SS_KEYS.state);
  }
  return true;
}

async function exchangeCodeForToken(appKey, redirectUri, code, verifier) {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: appKey,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(DBX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || res.statusText);
  return json;
}

async function refreshAccessToken(appKey) {
  const refreshToken = localStorage.getItem(LS_KEYS.refreshToken);
  if (!refreshToken) throw new Error("No refresh token on file — reconnect to Dropbox.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
  });
  const res = await fetch(DBX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || res.statusText);
  storeTokens(json);
  return json.access_token;
}

function storeTokens(tokens) {
  localStorage.setItem(LS_KEYS.accessToken, tokens.access_token);
  if (tokens.refresh_token) localStorage.setItem(LS_KEYS.refreshToken, tokens.refresh_token);
  localStorage.setItem(LS_KEYS.expiresAt, String(Date.now() + (tokens.expires_in || 0) * 1000));
}

function isConnected() {
  return !!localStorage.getItem(LS_KEYS.accessToken);
}

function disconnect() {
  Object.values(LS_KEYS).forEach((k) => { if (k !== LS_KEYS.appKey && k !== LS_KEYS.redirectUri) localStorage.removeItem(k); });
}

// Returns a usable access token, transparently refreshing if it's expired or
// about to expire. Callers should always go through this rather than reading
// LS_KEYS.accessToken directly.
async function getAccessToken(appKey) {
  const expiresAt = Number(localStorage.getItem(LS_KEYS.expiresAt) || 0);
  if (Date.now() < expiresAt - 60000) return localStorage.getItem(LS_KEYS.accessToken);
  return refreshAccessToken(appKey);
}

// Concurrent image downloads/uploads (see pwa/sync-pwa.js's worker pools) can
// trip Dropbox's per-app rate limit (HTTP 429) well before a real library
// finishes syncing. Every Dropbox network call routes through this so a 429
// waits and retries instead of the caller treating it as a permanent failure
// (which, before this fix, silently and incorrectly deferred images that were
// perfectly reachable — just rate-limited in the moment).
//
// SHARED gate across all concurrent workers: an independent per-call retry
// loop sounds right but isn't — with N concurrent workers all hitting 429 at
// roughly the same moment, they retry on roughly the same schedule and hit the
// wall again together (a thundering herd), never actually backing off as a
// group. `rateLimitedUntil` is a module-level timestamp every call checks
// FIRST, before even attempting a fetch — one 429 pauses every worker, not
// just the one that got hit.
const MAX_RETRIES = 8;
let rateLimitedUntil = 0;

async function fetchWithRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const now = Date.now();
    if (rateLimitedUntil > now) {
      await new Promise((r) => setTimeout(r, rateLimitedUntil - now));
    }
    const res = await fetch(url, options);
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) return res; // non-retryable client error — let the caller's own error handling take it
    if (attempt === MAX_RETRIES) return res; // out of retries — return the last (failing) response as-is
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSecs = retryAfterHeader ? Number(retryAfterHeader) : null;
    // +/-20% jitter so, once the shared pause lifts, four workers resuming at
    // the exact same instant don't just re-synchronize and trip 429 together again.
    const base = (retryAfterSecs && isFinite(retryAfterSecs)) ? retryAfterSecs * 1000 : Math.min(1000 * 2 ** attempt, 30000);
    const waitMs = Math.round(base * (0.8 + Math.random() * 0.4));
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs);
    console.warn(`dropbox: ${res.status} — pausing all requests for ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Pure — classifies a Dropbox HTTP response status into a code the rest of
// the app can branch on, without inspecting Dropbox's free-text
// error_summary. 401 means the access token is dead (revoked or expired
// server-side — distinct from our own locally-tracked expiresAt, which can
// still look "not expired yet" while the server has already killed it) and
// every caller must treat that identically: clear the token, tell the user
// to reconnect. Everything else (network failure, 404, 5xx, a 429 that
// survived fetchWithRetry's own retries) is a generic, non-auth failure
// that must NOT force a reconnect for what might just be a bad moment.
function classifyDbxError(status) {
  if (status === 401) return { code: "AUTH_EXPIRED", message: "Dropbox connection expired — reconnect in Settings." };
  return { code: "OTHER", message: null };
}

async function dbxApiCall(accessToken, endpoint, argBody) {
  const res = await fetchWithRetry(`${DBX_API_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(argBody || {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_summary || res.statusText);
  return json;
}

async function dbxDownload(accessToken, path) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`download ${path}: ${res.status} ${errText}`);
  }
  return res.text();
}

async function getCurrentAccount(accessToken) {
  const res = await fetch(`${DBX_API_URL}/users/get_current_account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("users/get_current_account failed: " + res.status);
  return res.json();
}

async function dbxDownloadBinary(accessToken, path) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`download ${path}: ${res.status} ${errText}`);
  }
  return res.arrayBuffer();
}

// mode: "overwrite" (default, matches desktop's atomic-write-then-rename intent —
// Dropbox itself makes a single PUT atomic from a reader's perspective) or "add".
async function dbxUpload(accessToken, path, contentBytesOrString, mode) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: mode || "overwrite", mute: true }),
    },
    body: contentBytesOrString,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`upload ${path}: ${res.status} ${errText}`);
  }
  return res.json();
}

// Fully paginated list_folder — a real image library easily exceeds Dropbox's
// per-call entry cap (observed: 5787 files in one device's images/ folder,
// which silently returned as an EMPTY result before this fix, since the caller
// only ever looked at the first page and never checked has_more/cursor).
async function dbxListFolder(accessToken, path) {
  let listing = await dbxApiCall(accessToken, "files/list_folder", { path });
  let entries = listing.entries.slice();
  while (listing.has_more) {
    listing = await dbxApiCall(accessToken, "files/list_folder/continue", { cursor: listing.cursor });
    entries = entries.concat(listing.entries);
  }
  return entries;
}

async function listDeviceImageIds(accessToken, deviceId) {
  try {
    const entries = await dbxListFolder(accessToken, `/Interests App/sync/${deviceId}/images`);
    return entries.filter((e) => e[".tag"] === "file").map((e) => e.name.replace(/\.jpg$/i, ""));
  } catch (e) {
    // path/not_found is the normal, silent case for a device that hasn't
    // published any images yet. Anything else (rate limit, network error, a
    // real bug) was previously swallowed identically — that masked the actual
    // pagination bug this function had. Surface everything else loudly.
    if (!/path\/not_found/.test(e.message)) {
      console.error("listDeviceImageIds: unexpected error listing images for", deviceId, "-", e.message);
    }
    return [];
  }
}

// Full peer snapshot for merge input (cards/saved/tombstones/settings/imageIds) —
// distinct from readDeviceSnapshot() above, which only fetches the meta-level
// summary for the Phase 1 connectivity-test UI. Applies the same torn-write
// completion-marker validation before returning.
async function readFullPeerSnapshot(accessToken, deviceId) {
  const base = `/Interests App/sync/${deviceId}`;
  const meta = JSON.parse(await dbxDownload(accessToken, `${base}/meta.json`));
  const snap = JSON.parse(await dbxDownload(accessToken, `${base}/snapshot.json`));

  const cardsMatch = (snap.cards || []).length === (meta.counts?.cards | 0);
  const savedMatch = (snap.saved || []).length === (meta.counts?.saved | 0);
  if (!cardsMatch || !savedMatch) return null; // mid-write on the writer's side — skip this cycle

  const imageIds = await listDeviceImageIds(accessToken, deviceId);

  return {
    deviceId,
    dir: base, // "dir" name kept to match core/merge.js's field name (imageCopies.fromDir)
    schemaVersion: meta.schemaVersion,
    deviceLabel: meta.deviceLabel,
    publishedAt: snap.publishedAt,
    cards: snap.cards || [],
    saved: snap.saved || [],
    tombstones: snap.tombstones || [],
    settings: snap.settings || null,
    imageIds,
  };
}

// Mirrors core/sync.js's readSnapshot() torn-write guard: a folder only counts
// as a valid, fully-synced snapshot if meta.json's counts match snapshot.json's
// actual array lengths. See docs/iphone-sync-design.md section 1.
async function readDeviceSnapshot(accessToken, deviceId) {
  const base = `/Interests App/sync/${deviceId}`;
  const metaText = await dbxDownload(accessToken, `${base}/meta.json`);
  const meta = JSON.parse(metaText);
  const snapText = await dbxDownload(accessToken, `${base}/snapshot.json`);
  const snap = JSON.parse(snapText);

  const cardsMatch = (snap.cards || []).length === (meta.counts?.cards | 0);
  const savedMatch = (snap.saved || []).length === (meta.counts?.saved | 0);

  return {
    deviceId,
    deviceLabel: meta.deviceLabel,
    schemaVersion: meta.schemaVersion,
    publishedAt: meta.publishedAt,
    counts: meta.counts,
    tombstoneCount: (snap.tombstones || []).length,
    valid: cardsMatch && savedMatch,
  };
}

async function listSyncDevices(accessToken) {
  const listing = await dbxApiCall(accessToken, "files/list_folder", { path: "/Interests App/sync" });
  const deviceIds = listing.entries
    .filter((e) => e[".tag"] === "folder")
    .map((e) => e.name);

  const results = [];
  for (const deviceId of deviceIds) {
    try {
      results.push(await readDeviceSnapshot(accessToken, deviceId));
    } catch (e) {
      results.push({ deviceId, error: e.message });
    }
  }
  return results;
}

window.IADropbox = {
  LS_KEYS,
  beginAuthorize,
  handleRedirectCallback,
  isConnected,
  disconnect,
  getAccessToken,
  getCurrentAccount,
  listSyncDevices,
  dbxDownload,
  dbxDownloadBinary,
  dbxUpload,
  dbxListFolder,
  listDeviceImageIds,
  readFullPeerSnapshot,
};
