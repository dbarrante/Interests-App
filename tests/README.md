# Tests (no dependencies — plain Node)

- `node tests/syntax-check.js` — every inline <script> in index.html must parse (0 errors). Run before every commit.
- `node tests/durability.test.js` — unit tests for pure backup logic extracted from index.html.

Pure functions are extracted from index.html by `_extract.js` using a brace-balance
scan, so both single-line functions (`function f(){ return 1; }`) and multi-line
functions (closing `}` at column 0) are supported. Functions only need to be
top-level (start at column 0 or immediately after a newline) to be extractable.
Internal helper functions defined inside another function are not extractable by
name alone.
