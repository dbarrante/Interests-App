const assert = require("assert");
const d = require("../web/deadcheck-ai");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildDeadCheckPrompt includes url/title/snippet and asks for JSON", () => {
  const p = d.buildDeadCheckPrompt({ title:"Page Not Found", snippet:"404", url:"https://x.com/p/1" });
  assert.ok(p.indexOf("https://x.com/p/1") >= 0);
  assert.ok(p.indexOf("Page Not Found") >= 0);
  assert.ok(/json/i.test(p) && p.indexOf('"dead"') >= 0);
});
t("parseDeadVerdict reads plain JSON", () => {
  assert.deepStrictEqual(d.parseDeadVerdict('{"dead":true,"reason":"removed"}'), { dead:true, reason:"removed" });
});
t("parseDeadVerdict reads fenced JSON with prose around it", () => {
  const txt = "Sure!\n```json\n{ \"dead\": false, \"reason\": \"live article\" }\n```\nHope that helps.";
  assert.deepStrictEqual(d.parseDeadVerdict(txt), { dead:false, reason:"live article" });
});
t("parseDeadVerdict on garbage -> safe default {dead:false}", () => {
  const r = d.parseDeadVerdict("I have no idea, sorry.");
  assert.strictEqual(r.dead, false);
});
t("parseDeadVerdict coerces non-boolean dead to false", () => {
  assert.strictEqual(d.parseDeadVerdict('{"dead":"yes"}').dead, false);
});
t("waybackUrl builds the latest-snapshot redirect url", () => {
  assert.strictEqual(d.waybackUrl("https://x.com/p/1"), "https://web.archive.org/web/2/https://x.com/p/1");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
