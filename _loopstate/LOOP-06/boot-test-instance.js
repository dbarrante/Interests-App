// LOOP-06 throwaway test instance — boots Core (Express) serving web/ on :3990
// with a FRESH temp data dir + disposable seed content. Never touches the live
// store (%APPDATA%) or the live :3456 app. Read-only-safe for UX auditing.
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { buildContext } = require("../../core/appctx");
const { createServer } = require("../../core/server");
const db = require("../../core/db");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-loop06-"));
fs.mkdirSync(path.join(dir, "images"), { recursive: true });
const ctx = buildContext(dir);

// --- disposable seed content so the UX surfaces render meaningfully ---
const now = Date.now();
const cards = [];
const titles = ["The lost art of steam-bent furniture", "A field guide to desert lichens",
  "How medieval scribes made blue ink", "Tiny homes built from shipping pallets",
  "The physics of a perfect paper airplane", "Forgotten synthesizers of the 1970s"];
titles.forEach((t, i) => cards.push({ id: "c_seed" + i, url: "https://example.com/a/" + i, title: t,
  platform: ["facebook", "pinterest", "youtube", "bookmark"][i % 4], cat: "Saved", ts: now - i * 1000, img: "", desc: "Seed card for LOOP-06 UX audit." }));
try { db.replaceCards(ctx.db, cards); } catch (e) { console.error("seed cards:", e.message); }

const saved = [];
["Meal-prep containers that actually stack", "A calmer weekly planning routine", "Repairing a wobbly chair leg"]
  .forEach((t, i) => saved.push({ id: "s_seed" + i, url: "https://example.com/s/" + i, title: t, category: ["Tips", "Life direction & big ideas", "Personal projects & hobbies"][i], clipped: now - i * 1000, image: "" }));
try { db.replaceSaved(ctx.db, saved); } catch (e) { console.error("seed saved:", e.message); }

// learning signals (the "what the AI remembers about you" surface)
db.setKV(ctx.db, "ia_likes", JSON.stringify([
  { title: "Forgotten synthesizers of the 1970s", category: "Personal projects & hobbies", ts: now - 5000 },
  { title: "How medieval scribes made blue ink", category: "Life direction & big ideas", ts: now - 9000 }]));
db.setKV(ctx.db, "ia_hidden", JSON.stringify([
  { title: "10 productivity hacks you already know", category: "Work initiatives", ts: now - 7000 }]));
db.setKV(ctx.db, "ia_clicks", JSON.stringify([
  { title: "A field guide to desert lichens", category: "Personal projects & hobbies", ts: now - 3000 }]));

// profile + settings
db.setKV(ctx.db, "ia_settings", JSON.stringify({
  about: "Curious generalist who loves hands-on making, quiet design, and odd corners of history.",
  interests: "woodworking, generative art, home repair, synths, natural history",
  weights: { personal: 8, work: 3, career: 2, life: 5 }
}));
db.setKV(ctx.db, "ia_bstumble_cats", JSON.stringify([
  { key: "personal", name: "Personal projects & hobbies" }, { key: "work", name: "Work initiatives" },
  { key: "career", name: "Career movement" }, { key: "life", name: "Life direction & big ideas" }]));

// a fresh dealt Stumble card so the discovery surface renders (not just empty state)
db.setKV(ctx.db, "ia_stvalver", "2");
db.setKV(ctx.db, "ia_stsize", "1");
db.setKV(ctx.db, "ia_stdeal", JSON.stringify([{ id: "bs_seed", url: "https://example.com/stumble/1",
  title: "The quiet genius of the humble index card", source: "example.com", category: "Personal projects & hobbies",
  benefit: "It shows a simple analog system for organizing ideas. You can try it this week with materials you already own.",
  image: null, liveCheckedAt: now }]));

const app = createServer(ctx);
const PORT = Number(process.env.PORT) || 3990;
http.createServer(app).listen(PORT, "127.0.0.1", () => {
  console.log("LOOP-06 test instance: http://127.0.0.1:" + PORT + "/  (data=" + dir + ")");
});
