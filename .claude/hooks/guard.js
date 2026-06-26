#!/usr/bin/env node
/*
 * PreToolUse guard (matcher: Edit|Write|NotebookEdit|Bash).
 * Blocks Claude from creating/editing personal-data files, and from `git add`-ing them.
 * These files are gitignored and must NEVER be committed or exposed. Reading them at
 * runtime (the app/tests via `node ...`) is unaffected — only the Edit/Write tools and
 * explicit `git add <file>` are guarded.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch (e) { return ""; }
}

let input = {};
try { input = JSON.parse(readStdin() || "{}"); } catch (e) { process.exit(0); }

const tool = input.tool_name || "";
const ti = input.tool_input || {};

function isProtectedPath(p) {
  if (!p) return false;
  const norm = String(p).replace(/\\/g, "/");
  const base = path.basename(norm).toLowerCase();
  if (base === "saves.json") return true;
  if (/^saves-.*\.json$/.test(base)) return true;
  if (/-import\.json$/.test(base)) return true;
  if (base === "facebook-saves.txt") return true;
  if (/\.zip$/.test(base)) return true;
  if (/^interests-backup-/.test(base)) return true;
  if (/^interests-snapshot-/.test(base)) return true;
  const segs = norm.toLowerCase().split("/");
  if (segs.includes("_recovery")) return true;
  // the live store directory: <project root>/data/...
  let rel = norm;
  try { rel = path.relative(ROOT, path.resolve(norm)).replace(/\\/g, "/"); } catch (e) {}
  if (rel === "data" || rel.startsWith("data/")) return true;
  return false;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
  if (isProtectedPath(ti.file_path)) {
    deny("Blocked: '" + path.basename(String(ti.file_path)) +
      "' is personal data (gitignored). Claude must not create, edit, or expose it. " +
      "If this is truly needed, the user should do it themselves outside Claude.");
  }
  process.exit(0);
}

if (tool === "Bash") {
  const cmd = String(ti.command || "");
  if (/\bgit\s+add\b/.test(cmd)) {
    for (const raw of cmd.split(/\s+/)) {
      const t = raw.replace(/^["']|["']$/g, "");
      if (t && isProtectedPath(t)) {
        deny("Blocked: `git add` references personal-data path '" + t +
          "'. These files are gitignored and must never be committed.");
      }
    }
  }
  process.exit(0);
}

process.exit(0);
