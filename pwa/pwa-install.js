"use strict";

// Injects an apple-touch-icon link tag at runtime — iOS Safari's "Add to Home
// Screen" icon has historically relied on this tag rather than the web app
// manifest's `icons` array. Runtime injection, not a static <link> in
// index.html, because index.html is documented (pwa/README.md,
// pwa/HANDOFF.md) as a byte-for-byte copy of web/index.html except for its
// <script> tags.
//
// No DOMContentLoaded gating needed here (unlike pwa/dropbox-connect.js):
// this script tag lives in <head>, and document.head already exists as soon
// as the parser reaches any <script> inside <head> — unlike dropbox-connect.js,
// which needs elements from <body>, which hasn't been parsed yet at that point.
//
// Real PNG, not the SVG used elsewhere: Chromium-based browsers accept an SVG
// manifest icon as valid JSON but don't rasterize SVG for the actual
// installable-icon pipeline (confirmed via Edge DevTools' Application >
// Manifest panel reporting "Icon ... failed to load" even after the SVG data
// URI's encoding was fixed), and iOS Safari's apple-touch-icon has the same
// raster-only expectation. icons/icon-192.png is the same orange "i" design
// as pwa/manifest.webmanifest's icons, rendered to a real PNG via Playwright
// (see docs/superpowers/plans/2026-07-13-pwa-manifest-offline-shell.md's
// follow-up notes) since no image-rasterization CLI tool is available in
// this environment.

(function () {
  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const link = document.createElement("link");
    link.rel = "apple-touch-icon";
    link.href = "icons/icon-192.png";
    document.head.appendChild(link);
  }
})();
