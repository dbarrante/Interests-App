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

// True when a `/` at html[i] can only be the start of a regex literal (never
// division) — i.e. the nearest preceding non-whitespace character is one that
// expects an expression to follow it, or there is no such character (start of
// a `code` frame, e.g. right after `${`).
const REGEX_PRECEDING_CHARS = "(,=:[!&|?{};+-*%^~";
function isRegexLiteralStart(html, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(html[j])) j--;
  if (j < 0) return true;
  return REGEX_PRECEDING_CHARS.indexOf(html[j]) !== -1;
}

function extractFn(html, name) {
  // Find the function declaration. Must be preceded by a newline or start of
  // string so we don't accidentally match an inner function with the same name.
  const declRe = new RegExp("(?:^|\\n)((?:async\\s+)?function " + name + "\\b[^{]*)\\{", "m");
  const dm = declRe.exec(html);
  if (!dm) return null;

  // Position of the opening `{` in the full string
  const openBrace = dm.index + dm[0].length - 1;

  // Stack-based brace-balance scan to find the matching closing `}`. A flat
  // single-state quote tracker (the previous approach) cannot handle a
  // template literal that contains a `${...}` expression which itself
  // contains ANOTHER template literal (e.g. renderImported's stickyBlock,
  // web/index.html — an outer backtick string with `${(function(){ ... return
  // `<button ...>`; })()}` nested inside) — it would treat the first nested
  // backtick as closing the OUTER string, then miscount everything after,
  // "succeeding" only by coincidentally re-syncing to depth 0 much later in
  // the file. That coincidence is silently broken by any unrelated edit
  // elsewhere in the file that shifts the accidental parity (caught live —
  // see 2026-08-02 tabs-filtering task 1 report). A stack fixes this: each
  // `${` inside a template literal pushes its own "code" frame (which itself
  // may push further template/string/code frames to any depth), and only the
  // OUTERMOST code frame's depth reaching 0 ends the function.
  const stack = [{ type: "code", depth: 1 }];   // depth=1: openBrace already consumed
  let i = openBrace + 1;
  while (i < html.length) {
    const top = stack[stack.length - 1];
    const ch = html[i];
    if (top.type === "string") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === top.q) stack.pop();
      i++;
      continue;
    }
    if (top.type === "template") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { stack.pop(); i++; continue; }
      if (ch === "$" && html[i + 1] === "{") { stack.push({ type: "code", depth: 1 }); i += 2; continue; }
      i++;
      continue;
    }
    // top.type === "code"
    if (ch === "/" && html[i + 1] === "/") {
      // Crude line-comment skip (not regex — good enough for our utility functions)
      const nl = html.indexOf("\n", i);
      i = nl < 0 ? html.length : nl + 1;
      continue;
    }
    if (ch === "/" && isRegexLiteralStart(html, i)) {
      // A `/` can only be a regex literal (not division) when the preceding
      // significant token is one that expects an expression next — e.g.
      // `.replace(/"/g,'q')` inside a template-literal `${...}` (real case:
      // web/index.html:3149, stNewsSideHTML — a regex containing a literal
      // `"` that would otherwise be misread as opening a string and run the
      // scan off the rails for ~100KB before this fix). Scan to the closing
      // unescaped `/`, treating `[...]` as a character class (so a `/`
      // inside one, e.g. `/[a\/b]/`, doesn't end the regex early), then skip
      // any trailing flag letters.
      let k = i + 1;
      let inClass = false;
      while (k < html.length) {
        const ck = html[k];
        if (ck === "\\") { k += 2; continue; }
        if (ck === "\n") break;   // regex literals can't span lines — bail defensively
        if (ck === "[") { inClass = true; k++; continue; }
        if (ck === "]") { inClass = false; k++; continue; }
        if (ck === "/" && !inClass) { k++; break; }
        k++;
      }
      while (k < html.length && /[a-z]/i.test(html[k])) k++;   // flags: g, i, m, ...
      i = k;
      continue;
    }
    if (ch === '"' || ch === "'") { stack.push({ type: "string", q: ch }); i++; continue; }
    if (ch === "`") { stack.push({ type: "template" }); i++; continue; }
    if (ch === "{") { top.depth++; i++; continue; }
    if (ch === "}") {
      top.depth--;
      if (top.depth === 0) {
        if (stack.length === 1) {
          // This is the function's own closing brace.
          const start = dm.index + (dm[0][0] === "\n" ? 1 : 0);   // skip leading newline
          return html.slice(start, i + 1);
        }
        // This closes a `${...}` expression's own code frame — pop back to
        // the template literal that hosts it, which keeps scanning as text.
        stack.pop();
      }
      i++;
      continue;
    }
    i++;
  }
  return null;   // unbalanced — should never happen in valid JS
}

function loadFns(names) {
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  // All requested functions are wired into ONE shared scope (not evaluated in
  // isolation) so a function that calls another requested-by-name function
  // (e.g. dupeGroupDismissed calling dupeMemberKey) actually resolves it,
  // instead of throwing "X is not defined". Callers must list every function
  // a requested one transitively depends on.
  const srcs = names.map((name) => {
    const src = extractFn(html, name);
    if (!src) throw new Error("function not found in index.html: " + name);
    return src;
  });
  const factory = new Function(srcs.join("\n") + "\nreturn {" + names.join(",") + "};");
  return factory();
}

module.exports = { loadFns, extractFn };
