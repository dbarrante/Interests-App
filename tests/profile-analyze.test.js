const assert = require("assert");
const p = require("../web/profile-analyze");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("summarizeLibrary counts categories, domains, title keywords; tolerant of missing fields", () => {
  const s = p.summarizeLibrary([
    { title:"Best MIG welding tips", url:"https://weldingweb.com/x", category:"welding" },
    { title:"MIG welding for beginners", url:"https://youtube.com/y", category:"welding" },
    { title:"Drip irrigation guide", url:"https://gardenista.com/z", category:"gardening" },
    { /* junk */ },
    null
  ]);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.categories[0].name, "welding");
  assert.strictEqual(s.categories[0].count, 2);
  assert.ok(s.domains.some(d => d.name === "weldingweb.com"));
  assert.ok(s.keywords.some(k => k.name === "welding" && k.count === 2));
  assert.ok(!s.keywords.some(k => k.name === "for" || k.name === "best"));
});
t("summarizeLibrary caps each list to top-N", () => {
  const cards = []; for (let i=0;i<100;i++) cards.push({ title:"t"+i, url:"https://d"+i+".com/", category:"c"+i });
  const s = p.summarizeLibrary(cards, { maxCategories:5, maxDomains:5, maxKeywords:5 });
  assert.strictEqual(s.categories.length, 5);
  assert.strictEqual(s.domains.length, 5);
});
t("summarizeLibrary counts tags when present, empty when absent", () => {
  const s = p.summarizeLibrary([{ title:"x", url:"https://a.com/", tags:["diy","tools"] }, { title:"y", url:"https://a.com/", tags:["diy"] }]);
  assert.ok(s.tags.some(g => g.name === "diy" && g.count === 2));
  const s2 = p.summarizeLibrary([{ title:"x", url:"https://a.com/" }]);
  assert.deepStrictEqual(s2.tags, []);
});
t("buildProfilePrompt embeds summary + asks for {interests,about} JSON; extraSources optional", () => {
  const prompt = p.buildProfilePrompt({ total:3, categories:[{name:"welding",count:2}], domains:[], keywords:[], tags:[] }, { about:"I tinker", interests:"welding" });
  assert.ok(prompt.indexOf("welding") >= 0);
  assert.ok(/interests/i.test(prompt) && prompt.indexOf('"about"') >= 0);
  assert.ok(prompt.indexOf("I tinker") >= 0);
});
t("buildProfilePrompt includes extra sources when given", () => {
  const prompt = p.buildProfilePrompt({ total:0 }, {}, [{ label:"Notion", text:"machine learning notes" }]);
  assert.ok(prompt.indexOf("Notion") >= 0 && prompt.indexOf("machine learning notes") >= 0);
});
t("parseProfileResult: plain JSON", () => {
  assert.deepStrictEqual(p.parseProfileResult('{"interests":["a","b"],"about":"hi"}'), { interests:["a","b"], about:"hi" });
});
t("parseProfileResult: fenced + prose, filters non-strings", () => {
  const r = p.parseProfileResult("Sure:\n```json\n{ \"interests\": [\"x\", 3, \" y \"], \"about\": \" me \" }\n```\n");
  assert.deepStrictEqual(r.interests, ["x","y"]);
  assert.strictEqual(r.about, "me");
});
t("parseProfileResult: garbage -> safe empty", () => {
  assert.deepStrictEqual(p.parseProfileResult("no json here"), { interests:[], about:"" });
});
t("mergeInterests appends, case-insensitive de-dupe, preserves existing", () => {
  assert.strictEqual(p.mergeInterests("welding, gardening", ["Welding", "drip irrigation"]), "welding, gardening, drip irrigation");
  assert.strictEqual(p.mergeInterests("", ["a","a","b"]), "a, b");
  assert.strictEqual(p.mergeInterests("x", []), "x");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
