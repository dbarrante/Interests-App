#!/usr/bin/env node
/*
 * PostToolUse syntax gate (matcher: Edit|Write).
 * Fast, side-effect-free check that surfaces genuine syntax breakage immediately:
 *   - edited .js/.mjs/.cjs  -> `node --check <file>` (parse only)
 *   - edited index.html     -> `node tests/syntax-check.js` (inline-<script> parse gate)
 * Deliberately does NOT run the full test suite: the build is TDD, so unit tests are
 * intentionally red at the "write failing test" step. Full tests run via `npm test`
 * at commit time and are enforced by the review gates.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch (e) { return ""; }
}

let input = {};
try { input = JSON.parse(readStdin() || "{}"); } catch (e) { process.exit(0); }

const ti = input.tool_input || {};
const tr = input.tool_response || {};
let fp = ti.file_path || ti.filePath || tr.filePath || "";
if (!fp) process.exit(0);
fp = String(fp).replace(/\\/g, "/");

const ext = path.extname(fp).toLowerCase();
const base = path.basename(fp).toLowerCase();

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason }));
  process.exit(0);
}

if ([".js", ".mjs", ".cjs"].includes(ext)) {
  if (!fs.existsSync(fp)) process.exit(0);
  const r = spawnSync(process.execPath, ["--check", fp], { encoding: "utf8" });
  if (r.status !== 0) {
    block("Syntax error after editing " + path.basename(fp) + ":\n" +
      (r.stderr || r.stdout || "").trim());
  }
  process.exit(0);
}

if (base === "index.html") {
  const gate = path.join(ROOT, "tests", "syntax-check.js");
  if (!fs.existsSync(gate)) process.exit(0);
  const r = spawnSync(process.execPath, [gate], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    block("Inline-<script> syntax gate failed after editing " + path.basename(fp) + ":\n" +
      (r.stdout || r.stderr || "").trim());
  }
  process.exit(0);
}

process.exit(0);
