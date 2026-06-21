// Validates every inline <script> block in index.html parses. Exit 1 on any error.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, e = 0;
while ((m = re.exec(html))) {
  i++;
  try { new Function(m[1]); }
  catch (x) { e++; console.log("BLOCK " + i + ": " + x.message); }
}
console.log(i + " script block(s), " + e + " error(s)");
process.exit(e ? 1 : 0);
