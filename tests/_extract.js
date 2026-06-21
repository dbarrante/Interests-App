// Pull self-contained top-level functions out of index.html by name so we can
// unit-test the real source without a build step. Requires each function's
// closing brace to be at column 0 (internal braces indented).
const fs = require("fs");
const path = require("path");
function loadFns(names) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const out = {};
  for (const name of names) {
    const re = new RegExp("\\nfunction " + name + "\\b[\\s\\S]*?\\n\\}");
    const m = html.match(re);
    if (!m) throw new Error("function not found in index.html: " + name);
    out[name] = eval("(" + m[0].trim() + ")");
  }
  return out;
}
module.exports = { loadFns };
