// Pull self-contained top-level functions out of index.html by name so we can
// unit-test the real source without a build step.
//
// Extraction strategy: find the start of `function NAME(` in the source, then
// do a brace-balance scan from the opening `{` to its matching `}`. This works
// for both single-line functions (`function f(){ return 1; }`) and multi-line
// functions whose closing brace is at column 0 — the previous regex-only
// approach only handled the latter.
const fs = require("fs");
const path = require("path");

function extractFn(html, name) {
  // Find the function declaration. Must be preceded by a newline or start of
  // string so we don't accidentally match an inner function with the same name.
  const declRe = new RegExp("(?:^|\\n)(function " + name + "\\b[^{]*)\\{", "m");
  const dm = declRe.exec(html);
  if (!dm) return null;

  // Position of the opening `{` in the full string
  const openBrace = dm.index + dm[0].length - 1;

  // Brace-balance scan to find the matching closing `}`
  let depth = 0;
  let inStr = null;   // null | '"' | "'" | '`'
  let i = openBrace;
  while (i < html.length) {
    const ch = html[i];
    if (inStr) {
      if (ch === "\\" && inStr !== "`") { i += 2; continue; }   // escape in string/regex
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (ch === "/") {
      // Crude line-comment skip (not regex — good enough for our utility functions)
      if (html[i + 1] === "/") {
        const nl = html.indexOf("\n", i);
        i = nl < 0 ? html.length : nl + 1;
        continue;
      }
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Slice from the start of `function` to the closing `}`
        const start = dm.index + (dm[0][0] === "\n" ? 1 : 0);   // skip leading newline
        return html.slice(start, i + 1);
      }
    }
    i++;
  }
  return null;   // unbalanced — should never happen in valid JS
}

function loadFns(names) {
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  const out = {};
  for (const name of names) {
    const src = extractFn(html, name);
    if (!src) throw new Error("function not found in index.html: " + name);
    out[name] = eval("(" + src + ")");
  }
  return out;
}

module.exports = { loadFns, extractFn };
