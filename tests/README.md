# Tests (no dependencies — plain Node)

- `node tests/syntax-check.js` — every inline <script> in index.html must parse (0 errors). Run before every commit.
- `node tests/durability.test.js` — unit tests for pure backup logic extracted from index.html.

Pure functions are extracted from index.html by `_extract.js` (regex on a top-level
`function NAME(){ … }` whose closing brace is at column 0). Keep such functions
formatted that way.
