"use strict";

// Injects an apple-touch-icon link tag at runtime — iOS Safari's "Add to Home
// Screen" icon has historically relied on this tag rather than the web app
// manifest's `icons` array (SVG support there is inconsistent across iOS
// versions). Runtime injection, not a static <link> in index.html, because
// index.html is documented (pwa/README.md, pwa/HANDOFF.md) as a byte-for-byte
// copy of web/index.html except for its <script> tags.
//
// No DOMContentLoaded gating needed here (unlike pwa/dropbox-connect.js):
// this script tag lives in <head>, and document.head already exists as soon
// as the parser reaches any <script> inside <head> — unlike dropbox-connect.js,
// which needs elements from <body>, which hasn't been parsed yet at that point.
//
// KEEP IN SYNC with the icon in pwa/manifest.webmanifest's `icons[0].src` —
// same SVG, same orange "i" on a #c2410c rounded square.

(function () {
  const ICON_SVG_DATA_URI =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23c2410c'/%3E%3Ctext x='50' y='68' font-size='52' font-family='Segoe UI,Arial' font-weight='800' fill='white' text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E";

  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const link = document.createElement("link");
    link.rel = "apple-touch-icon";
    link.href = ICON_SVG_DATA_URI;
    document.head.appendChild(link);
  }
})();
