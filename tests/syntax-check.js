// Validates every inline <script> block in web/index.html parses, and that
// web/storage.js parses. Exit 1 on any error.
const fs = require("fs");
const path = require("path");

let total = 0, errors = 0;
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

const htmlPath = path.join(__dirname, "..", "web", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
let m, i = 0;
while ((m = re.exec(html))) {
  i++; total++;
  try { new Function(m[1]); }
  catch (x) { errors++; console.log("web/index.html BLOCK " + i + ": " + x.message); }
}

const storagePath = path.join(__dirname, "..", "web", "storage.js");
total++;
try { new Function(fs.readFileSync(storagePath, "utf8")); }
catch (x) { errors++; console.log("web/storage.js: " + x.message); }

const aiPath = path.join(__dirname, "..", "web", "ai.js");
total++;
try { new Function(fs.readFileSync(aiPath, "utf8")); }
catch (x) { errors++; console.log("web/ai.js: " + x.message); }

const urlkeyPath = path.join(__dirname, "..", "web", "lib", "urlkey.js");
total++;
try { new Function(fs.readFileSync(urlkeyPath, "utf8")); }
catch (x) { errors++; console.log("web/lib/urlkey.js: " + x.message); }

for (const libFile of ["import-parsers.js", "capture-state.js"]) {
  const p = path.join(__dirname, "..", "web", "lib", libFile);
  total++;
  try { new Function(fs.readFileSync(p, "utf8")); }
  catch (x) { errors++; console.log("web/lib/" + libFile + ": " + x.message); }
}

console.log(i + " inline script block(s) + storage.js = " + total + " unit(s), " + errors + " error(s)");
process.exit(errors ? 1 : 0);
