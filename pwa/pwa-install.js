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
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Crect%20width='100'%20height='100'%20rx='22'%20fill='%23c2410c'/%3E%3Ctext%20x='50'%20y='68'%20font-size='52'%20font-family='Segoe%20UI,Arial'%20font-weight='800'%20fill='white'%20text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E";

  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const link = document.createElement("link");
    link.rel = "apple-touch-icon";
    link.href = ICON_SVG_DATA_URI;
    document.head.appendChild(link);
  }
})();
