"use strict";

/* ============ constants ============ */
const BASE_CATS = [
  {key:"personal", name:"Personal projects & hobbies", chip:"var(--chip-personal)"},
  {key:"work",     name:"Work initiatives",            chip:"var(--chip-work)"},
  {key:"career",   name:"Career movement",             chip:"var(--chip-career)"},
  {key:"life",     name:"Life direction & big ideas",  chip:"var(--chip-life)"}
];
const CAT_PALETTE = ["#0d9488","#b45309","#be185d","#4d7c0f","#6d28d9","#0369a1","#a21caf","#92400e"];
const GRADS = {personal:"#0e7490,#155e75", work:"#7c3aed,#5b21b6", career:"#c2410c,#9a3412", life:"#15803d,#166534"};
let CATS = [];
function rebuildCats(){
  CATS = BASE_CATS.concat((S.extraCats||[]).map(c=>({key:c.key, name:c.name, chip:c.color, custom:true})));
  CATS.forEach(c=>{ if(S.weights[c.key]==null) S.weights[c.key]=5; });
}
function catGrad(cat){ return GRADS[cat.key] || (cat.chip+","+cat.chip); }
const PROVIDERS = {
  anthropic:{label:"Claude (Anthropic)", model:"claude-sonnet-4-6",
    keyUrl:"https://console.anthropic.com/settings/keys", keyName:"Anthropic API key"},
  openai:{label:"ChatGPT (OpenAI)", model:"gpt-4o",
    keyUrl:"https://platform.openai.com/api-keys", keyName:"OpenAI API key"},
  gemini:{label:"Gemini (Google)", model:"gemini-2.5-flash",
    keyUrl:"https://aistudio.google.com/apikey", keyName:"Google AI Studio API key"},
  groq:{label:"Groq", model:"llama-3.3-70b-versatile",
    keyUrl:"https://console.groq.com/keys", keyName:"Groq API key"},
  local:{label:"Local / Custom", model:"llama3.1:8b",
    keyUrl:"https://ollama.com/download", keyName:"API key (optional for Ollama)"}
};
const DEFAULTS = {
  provider:"gemini",
  keys:{anthropic:"",openai:"",gemini:"",groq:"",local:""},
  models:{anthropic:PROVIDERS.anthropic.model,openai:PROVIDERS.openai.model,gemini:PROVIDERS.gemini.model,groq:PROVIDERS.groq.model,local:PROVIDERS.local.model},
  localUrl:"http://localhost:11434/v1",
  popularOnly:false,
  oprKey:"",
  weights:{personal:8, work:6, career:7, life:5},
  itemCount:12,
  about:"Dave — hands-on tinkerer and builder in Connecticut. Heavy AI user (especially Claude — prompting, Claude Code, agents, MCP, skills). Builds and 3D-prints things, automates his home, fishes, maintains his own property and equipment, and is actively using AI to level up his career.",
  interests:"AI tools & workflows, Claude power-use (prompt libraries, Claude Code, MCP servers, agent skills), 3D printing (Bambu Lab, calibration, functional prints, gridfinity organizers), Star Wars props & droid builds, retro gaming (RetroPie, emulation, classic consoles, arcade cabinets), bass fishing (lures, tackle organization, techniques), knots & rope skills, lawn & property care (lawn tractors, leveling, homemade attachments), mini excavators & compact equipment, Harbor Freight tool projects, home automation (Home Assistant, Raspberry Pi, ESP32, DIY electronics), car tinkering (5th-gen Camaro, FORScan), healthy cooking (Mediterranean, high-protein, low-sugar desserts, Ninja Creami), career development (LinkedIn optimization, resume & ATS, interview prep, AI-powered job search), workplace influence & power skills, productivity systems, personal growth & calm mindset"
};

/* ============ state ============ */
let S = load("settings", DEFAULTS);
S = Object.assign({}, DEFAULTS, S);
S.keys = Object.assign({}, DEFAULTS.keys, S.keys||{});
S.models = Object.assign({}, DEFAULTS.models, S.models||{});
S.weights = Object.assign({}, DEFAULTS.weights, S.weights||{});
S.extraCats = S.extraCats||[];
rebuildCats();

let feed   = load("feed", []);
let saved  = load("saved", []);
let hidden = load("hidden", []);
let clicks = load("clicks", []);
let shown  = load("shown", []);
let likes  = load("likes", []);
let imported = load("imported", []);
let spool  = load("spool", []);
let stCur  = load("stcur", null);

function load(k,d){ try{ const v=localStorage.getItem("ia_"+k); return v?JSON.parse(v):d; }catch(e){ return d; } }
function save(k,v){ localStorage.setItem("ia_"+k, JSON.stringify(v)); }
function persistAll(){ save("feed",feed); save("saved",saved); save("hidden",hidden); save("clicks",clicks); save("shown",shown); save("likes",likes); save("spool",spool); writeSavesFile(); }

/* ============ ui helpers ============ */
function toast(msg, ms){ const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("show"), ms||2600); }
function esc(s){ const d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }
function domain(u){ try{ return new URL(u).hostname.replace(/^www\./,""); }catch(e){ return ""; } }
function catByName(n){ return CATS.find(c=>c.name===n) || CATS.find(c=> n && n.toLowerCase().includes(c.key)) || CATS[0]; }

let curTab = "feed";
let filterCat = load("fcat","");
let viewMode = load("view", "g4");
const VIEWS = [["g4","&#9638; 4&times;4"],["g8","&#9641; 8&times;8"],["detail","&#9645; Detail"],["list","&#9776; List"]];
function setView(v){
  viewMode = v; save("view", v);
  renderCatBar();
  if(curTab==="saved") renderSaved();
  else if(curTab==="imported") renderImported();
  else renderFeed();
}
function gridClass(){ return "masonry m-"+viewMode; }
function showTab(t){
  curTab = t;
  save("tab", t);
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===t));
  ["feed","stumble","saved","imported","settings"].forEach(v=>document.getElementById("view-"+v).style.display = v===t?"":"none");
  document.getElementById("catBar").style.display = t==="settings"?"none":"";
  renderCatBar();
  if(t==="feed") renderFeed();
  if(t==="saved") renderSaved();
  if(t==="settings") renderSettings();
  if(t==="imported") renderImported();
  if(t==="stumble"){ if(!stCur) stumbleNext(); else renderStumble(); }
}
function renderCatBar(){
  const pills = [{key:"",name:"All",chip:"var(--ink)"}].concat(CATS);
  const catHtml = curTab==="imported"
    ? PLATS.map(([k,label])=>
      `<button class="catpill${impSrc===k?" on":""}" style="${impSrc===k?"background:var(--ink)":""}"
        onclick="setImpSrc('${k}')">${k?PICONS[k]||"":""}${label}</button>`).join("")
    : pills.map(c=>
    `<button class="catpill${filterCat===c.key?" on":""}" style="${filterCat===c.key?`background:${c.chip}`:""}"
      onclick="setFilter('${c.key}')">${c.name}</button>`).join("");
  document.getElementById("catBar").innerHTML = catHtml
    + `<span style="flex:1"></span>`
    + VIEWS.map(([v,label])=>
    `<button class="catpill${viewMode===v?" on":""}" style="${viewMode===v?"background:var(--ink)":""}" title="View"
      onclick="setView('${v}')">${label}</button>`).join("");
}
function setFilter(k){
  filterCat = k;
  save("fcat", k);
  renderCatBar();
  if(curTab==="saved") renderSaved(); else renderFeed();
}
function applyFilter(list){
  if(!filterCat) return list;
  const name = CATS.find(c=>c.key===filterCat).name;
  return list.filter(i=>i.category===name);
}

/* ============ cards ============ */
const imgChains = {};
function imageChain(item){
  const c = [];
  if(item.image) c.push(item.image);
  if(item.url){
    c.push(`https://s0.wp.com/mshots/v1/${encodeURIComponent(item.url)}?w=640`);
    c.push(`https://image.thum.io/get/width/640/crop/700/${item.url}`);
  }
  return c;
}
function nextImg(el,id){
  const chain = imgChains[id]||[];
  if(chain.length){ el.src = chain.shift(); return; }
  const d = el.dataset;
  el.closest(".thumb").innerHTML =
    `<div class="ph" style="background:linear-gradient(135deg,${d.grad})">${d.fav?`<img src="${d.fav}">`:""}${d.dom||"idea"}</div>`;
}
function mshotsRetry(el){
  if(el.src.includes("/mshots/") && !el.dataset.r){
    el.dataset.r = "1";
    setTimeout(()=>{ if(el.isConnected && el.src.includes("/mshots/")) el.src = el.src.split("&rnd=")[0]+"&rnd="+Date.now(); }, 9000);
  }
}
function cardHTML(item, mode){
  const cat = catByName(item.category);
  const dom = domain(item.url);
  const fav = dom ? `https://www.google.com/s2/favicons?domain=${dom}&sz=64` : "";
  const id = esc(item.id);
  const grad = catGrad(cat);
  const chain = imageChain(item);
  imgChains[id] = chain.slice(1);
  const first = chain[0];
  return `<div class="card" id="card-${id}">
    <a class="thumb" onclick="openItem('${id}','${mode}')" title="Open article">
      ${first?`<img src="${esc(first)}" loading="lazy" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}"
                onerror="nextImg(this,'${id}')" onload="mshotsRetry(this)">`
             :`<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`}
    </a>
    <div class="body">
      <span class="chip" style="background:${cat.chip}">${esc(cat.name)}</span>
      <div class="title" onclick="openItem('${id}','${mode}')">${esc(item.title)}</div>
      <div class="src">${esc(item.source||dom)}</div>
      <div class="benefit"><b>Why for you:</b> ${esc(item.benefit)}</div>
      ${mode==="saved"?tagRow(item.tags):""}
    </div>
    <div class="actions">
      ${mode==="feed"
        ? `<button class="act" onclick="saveItem('${id}')">&#128278; Save</button>
           <button class="act" onclick="hideItem('${id}')">&#10005; Not for me</button>`
        : `<button class="act saved" onclick="unsaveItem('${id}')">&#10003; Saved — remove</button>`}
    </div>
  </div>`;
}
function renderFeed(){
  const grid = document.getElementById("feedGrid");
  grid.className = gridClass();
  const list = applyFilter(feed);
  grid.innerHTML = list.map(i=>cardHTML(i,"feed")).join("");
  const empty = document.getElementById("feedEmpty");
  if(feed.length && !list.length){ empty.innerHTML = `<div class="empty"><h2>Nothing here right now</h2><p>No current ideas in this category — hit <b>New ideas</b> or raise its importance in Settings.</p></div>`; }
  else if(feed.length){ empty.innerHTML=""; }
  else{
    const hasKey = S.provider==="local" || !!S.keys[S.provider];
    empty.innerHTML = `<div class="empty"><h2>${hasKey?"Ready when you are":"Welcome, Dave"}</h2>
      <p>${hasKey
        ? "Hit <b>New ideas</b> up top and your AI will go find articles, projects, and initiatives matched to your interests."
        : "One quick step: open <b>Settings</b>, pick your AI provider, and paste an API key. Then hit <b>New ideas</b> and the feed fills with recommendations matched to your interests. Every save teaches it what you like."}</p>
      <button class="btn btn-primary" onclick="${hasKey?"refreshFeed()":"showTab('settings')"}">${hasKey?"&#10227; New ideas":"Open Settings"}</button></div>`;
  }
  updateCounts();
}
function renderSaved(){
  const list = applyFilter(saved);
  const g = document.getElementById("savedGrid");
  g.className = gridClass();
  g.innerHTML = list.map(i=>cardHTML(i,"saved")).join("");
  document.getElementById("savedEmpty").innerHTML = list.length?"":`<div class="empty"><h2>Nothing saved${filterCat?" in this category":" yet"}</h2><p>Save items from your feed and they collect here — and every save teaches the AI what to bring you next.</p></div>`;
}

/* ============ item actions ============ */
function findItem(id){ return feed.find(i=>i.id===id) || saved.find(i=>i.id===id); }
function openItem(id,mode){
  const it=findItem(id); if(!it) return;
  clicks.push({title:it.title, category:it.category, ts:Date.now()});
  if(clicks.length>60) clicks=clicks.slice(-60);
  persistAll();
  window.open(it.url, "_blank");
}
function saveItem(id){
  const it=feed.find(i=>i.id===id); if(!it) return;
  if(!saved.some(s=>s.url===it.url)) saved.unshift(it);
  feed = feed.filter(i=>i.id!==id);
  persistAll(); renderFeed();
  toast("Saved — the feed just learned something about you");
}
function unsaveItem(id){
  saved = saved.filter(i=>i.id!==id);
  persistAll(); renderSaved(); renderFeed();
}
function hideItem(id){
  const it=feed.find(i=>i.id===id); if(!it) return;
  hidden.push({title:it.title, category:it.category, ts:Date.now()});
  if(hidden.length>60) hidden=hidden.slice(-60);
  feed = feed.filter(i=>i.id!==id);
  persistAll(); renderFeed();
  toast("Got it — fewer like that");
}
function resetLearning(){
  if(!confirm("Clear save/click/hide history the AI learns from? (Your saved items list stays.)")) return;
  hidden=[]; clicks=[]; shown=[]; likes=[]; spool=[];
  persistAll(); toast("Learning history cleared");
}
function exportData(){
  const blob = new Blob([JSON.stringify({settings:S,feed,saved,hidden,clicks},null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="interests-data.json"; a.click();
}

/* ============ settings ui ============ */
function renderSettings(){
  document.querySelectorAll("#provPick label").forEach(l=>{
    const on = l.dataset.p===S.provider;
    l.classList.toggle("on", on);
    l.querySelector("input").checked = on;
    l.onclick = ()=>{ S.provider=l.dataset.p; renderSettings(); };
  });
  const p = PROVIDERS[S.provider];
  const localExtra = S.provider!=="local" ? "" : `
    <label>Endpoint base URL</label>
    <input type="text" id="localUrl" value="${esc(S.localUrl)}">
    <div class="hint">Ollama: <b>http://localhost:11434/v1</b> (free, local — run <b>ollama serve</b> with env var <b>OLLAMA_ORIGINS=*</b> so the browser may call it).
    Also works with OpenRouter (<b>https://openrouter.ai/api/v1</b> — free ":free" models) or Groq (<b>https://api.groq.com/openai/v1</b> — free tier). Note: no web search in this mode, so links can occasionally be stale.</div>`;
  document.getElementById("provFields").innerHTML = `${localExtra}
    <label>${esc(p.keyName)}</label>
    <input type="password" id="apiKey" value="${esc(S.keys[S.provider])}" placeholder="${S.provider==="local"?"Leave blank for Ollama":"Paste your key…"}">
    <div class="hint">Get one at <a href="${p.keyUrl}" target="_blank">${p.keyUrl.replace("https://","")}</a>. Stored only in this browser.${S.provider==="groq"?` <a href="#" onclick="showGuide('groqkey');return false"><b>Step-by-step instructions</b></a> — free, no card needed. Note: Groq has no web search; great for Enrich, decent for the feed.`:""}</div>
    <label>Model</label>
    <input type="text" id="modelName" value="${esc(S.models[S.provider])}">
    <div class="hint">${S.provider==="local"?"e.g. llama3.1:8b or qwen2.5:14b (Ollama), llama-3.3-70b-versatile (Groq), meta-llama/llama-3.3-70b-instruct:free (OpenRouter).":"Default works well; change it if you want a smarter/cheaper model."}</div>`;
  document.getElementById("apiKey").oninput = e=>{ S.keys[S.provider]=e.target.value.trim(); };
  document.getElementById("modelName").oninput = e=>{ S.models[S.provider]=e.target.value.trim(); };
  if(S.provider==="local") document.getElementById("localUrl").oninput = e=>{ S.localUrl=e.target.value.trim().replace(/\/$/,""); };

  document.getElementById("sliders").innerHTML = CATS.map(c=>`
    <div class="slider-row">
      <div class="nm">${c.custom?`<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.chip};margin-right:6px"></span>`:""}${esc(c.name)}</div>
      <input type="range" min="0" max="10" value="${S.weights[c.key]}" oninput="S.weights['${c.key}']=+this.value;this.nextElementSibling.textContent=this.value">
      <div class="val">${S.weights[c.key]}</div>
      ${c.custom?`<button class="act" style="flex:0 0 auto;padding:4px 10px" title="Remove category" onclick="removeCategory('${c.key}')">&#10005;</button>`:`<span style="width:38px"></span>`}
    </div>`).join("");

  document.getElementById("aboutMe").value = S.about;
  document.getElementById("interestList").value = S.interests;
  document.getElementById("itemCount").value = S.itemCount;
  document.getElementById("popOnly").checked = !!S.popularOnly;
  document.getElementById("popOnly").onchange = e=>{ S.popularOnly=e.target.checked; save("settings",S); };
  document.getElementById("oprKey").value = S.oprKey||"";
  document.getElementById("oprKey").oninput = e=>{ S.oprKey=e.target.value.trim(); };
  renderImportStatus();
}
function saveSettings(notify){
  S.about = document.getElementById("aboutMe").value;
  S.interests = document.getElementById("interestList").value;
  S.itemCount = Math.max(4, Math.min(24, +document.getElementById("itemCount").value || 12));
  save("settings", S);
  if(notify){ toast("Settings saved"); showTab("feed"); }
}

/* ============ prompt ============ */
function buildPrompt(mode){
  const stumble = mode==="stumble";
  const count = (stumble ? 10 : S.itemCount) + 3;
  const active = CATS.filter(c=>S.weights[c.key]>0);
  const catLines = active.map(c=>`- "${c.name}" (importance ${S.weights[c.key]}/10)`).join("\n");
  const recentSaves = saved.slice(0,20).map(s=>`- [${s.category}] ${s.title}`).join("\n") || "(none yet)";
  const liked = likes.slice(-20).map(l=>`- [${l.category}] ${l.title}`).join("\n") || "(none yet)";
  const recentClicks = clicks.slice(-15).map(c=>`- [${c.category}] ${c.title}`).join("\n") || "(none yet)";
  const dismissed = hidden.slice(-25).map(h=>`- [${h.category}] ${h.title}`).join("\n") || "(none yet)";
  const avoid = saved.map(s=>s.url).concat(shown.slice(-80)).filter(Boolean).join("\n") || "(none)";
  return `${stumble
  ? `You are Dave's StumbleUpon. Use web search to find ${count} REAL, currently-accessible, delightful rabbit-hole pages matched to his interests: fascinating articles, interactive sites, niche tools, brilliant project writeups, weird-and-wonderful corners of the web. Favor serendipity and surprise over the obvious — things he would never have searched for but will love.`
  : `You are a personal discovery engine for Dave, like a smart Pinterest/Facebook feed but actually useful. Use web search to find REAL, currently-accessible web pages: articles, guides, project ideas, tools, videos, courses, initiatives, and thought pieces.`}

ABOUT DAVE:
${S.about}

INTERESTS:
${S.interests}

CATEGORIES (distribute the ${count} items roughly proportionally to importance):
${catLines}

LEARNING SIGNALS — weight these heavily:
Recently SAVED — use these to understand his taste, but NEVER recommend the same or near-identical item again (he already has it; bring him something NEW in the same vein):
${recentSaves}
THUMBS-UP liked pages (strong positive signal):
${liked}
Recently CLICKED:
${recentClicks}
DISMISSED as "not for me" (avoid similar):
${dismissed}
IMPORTED SAVES from his Facebook/Pinterest history (broader taste signal, weight moderately):
${imported.length ? imported.slice().sort(()=>Math.random()-.5).slice(0,25).map(i=>"- "+i.title).join("\n") : "(none)"}

DO NOT recommend any of these URLs again:
${avoid}

RULES:
1. ${(S.provider==="local"||S.provider==="groq")
  ? "You cannot browse the web. Recommend well-known, durable resources and use stable URLs that are very likely to exist (GitHub repos, official project sites, YouTube channels, established publications). Never invent deep article URLs."
  : "Search the web to verify each item is a real, live page. CRITICAL: copy each URL character-for-character from an actual search result — NEVER invent, reconstruct, or best-guess a URL path, and never cite a page you did not see in search results. If you can't confirm the exact deep link, use the site's homepage or section page instead. Prefer substantial, high-quality sources over engagement-bait. For the \"image\" field, include the page's real og:image / preview image URL whenever you can find one — only use null as a last resort."}
2. ${stumble
  ? "Optimize for delight and serendipity; every page should make him say \"how did it know?\" or \"I had no idea this existed\"."
  : "Mix it up: some practical/hands-on, some career-advancing, an occasional stretch idea adjacent to his interests that he might not have searched for himself."}${S.popularOnly?`
2b. POPULAR SITES ONLY: every recommendation must be on a well-known, high-traffic, reputable site (major publications, established platforms, big communities — think top-10k domains).${stumble?" Serendipity should come from surprising corners OF popular sites, not from obscure domains.":""}`:""}
3. "benefit" must be EXACTLY two sentences, written to Dave in second person, explaining concretely how this helps him.
4. Return ONLY a JSON array, no other text, with exactly ${count} objects in this shape:
[{"title":"...","url":"https://...","source":"site or author name","category":"one of: ${active.map(c=>c.name).join(" | ")}","benefit":"Two sentences.","image":"og/preview image URL if you found one, else null"}]`;
}

/* ============ providers ============ */
async function callAnthropic(prompt){
  const r = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-api-key":S.keys.anthropic,
      "anthropic-version":"2023-06-01",
      "anthropic-dangerous-direct-browser-access":"true"
    },
    body:JSON.stringify({
      model:S.models.anthropic, max_tokens:6000,
      tools:[{type:"web_search_20250305", name:"web_search", max_uses:8}],
      messages:[{role:"user", content:prompt}]
    })
  });
  if(!r.ok) throw new Error("Anthropic API error "+r.status+": "+(await r.text()).slice(0,300));
  const d = await r.json();
  return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
}
async function callOpenAI(prompt){
  const r = await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.keys.openai},
    body:JSON.stringify({model:S.models.openai, tools:[{type:"web_search"}], input:prompt})
  });
  if(!r.ok) throw new Error("OpenAI API error "+r.status+": "+(await r.text()).slice(0,300));
  const d = await r.json();
  let out="";
  (d.output||[]).forEach(o=>{ if(o.type==="message") (o.content||[]).forEach(c=>{ if(c.type==="output_text") out+=c.text; }); });
  return out || d.output_text || "";
}
async function callGemini(prompt){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${S.models.gemini}:generateContent?key=${S.keys.gemini}`;
  const r = await fetch(url,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}], tools:[{google_search:{}}]})
  });
  if(!r.ok) throw new Error("Gemini API error "+r.status+": "+(await r.text()).slice(0,300));
  const d = await r.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  return parts.map(p=>p.text||"").join("\n");
}
async function callGroq(prompt){
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.keys.groq},
    body:JSON.stringify({model:S.models.groq, temperature:0.8,
      messages:[{role:"user", content:prompt}]})
  });
  if(!r.ok) throw new Error("Groq API error "+r.status+": "+(await r.text()).slice(0,300));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}
async function callLocal(prompt){
  const headers = {"Content-Type":"application/json"};
  if(S.keys.local) headers["Authorization"] = "Bearer "+S.keys.local;
  const r = await fetch(S.localUrl+"/chat/completions",{
    method:"POST", headers,
    body:JSON.stringify({model:S.models.local, temperature:0.8,
      messages:[{role:"user", content:prompt}]})
  }).catch(e=>{ throw new Error("Can't reach "+S.localUrl+". If using Ollama, start it with OLLAMA_ORIGINS=* set."); });
  if(!r.ok) throw new Error("Endpoint error "+r.status+": "+(await r.text()).slice(0,300));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

/* ============ response parsing & validation ============ */
function urlKey(u){ return (u||"").toLowerCase().replace(/^https?:\/\/(www\.)?/,"").replace(/\/+$/,""); }
function titleKey(t){ return (t||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function dropAlreadySaved(items){
  const haveU = new Set(saved.map(s=>urlKey(s.url)));
  const haveT = saved.map(s=>titleKey(s.title)).filter(t=>t.length>10);
  return items.filter(i=>{
    if(haveU.has(urlKey(i.url))) return false;
    const t = titleKey(i.title);
    return !haveT.some(h=>h===t || (t.length>12 && h.includes(t)) || (h.length>12 && t.includes(h)));
  });
}
function parseItems(text){
  if(!text) throw new Error("Empty response from model");
  let t = text.replace(/```json|```/g,"").trim();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if(a===-1||b===-1) throw new Error("No JSON array found in model response");
  let arr = JSON.parse(t.slice(a,b+1));
  if(!Array.isArray(arr)) throw new Error("Model did not return a list");
  return arr.filter(i=>i && i.title && i.url).map((i,n)=>({
    id: Date.now().toString(36)+"_"+n,
    title:String(i.title), url:String(i.url),
    source:i.source?String(i.source):domain(i.url),
    category: catByName(String(i.category||"")).name,
    benefit: String(i.benefit||"").trim() || "Matched to your interest profile. Worth a quick look.",
    image: (i.image && /^https?:\/\//.test(String(i.image))) ? String(i.image) : null
  }));
}
async function validateItems(items){
  let proxyDown = false;
  const check = async it=>{
    try{
      if(/facebook\.com|youtube\.com|youtu\.be/.test(it.url)) return true;
      const ctl=new AbortController(); const tm=setTimeout(()=>ctl.abort(), 8000);
      const r=await fetch("https://api.allorigins.win/get?url="+encodeURIComponent(it.url), {signal:ctl.signal});
      clearTimeout(tm);
      if(!r.ok){ proxyDown=true; return true; }
      const d=await r.json();
      const code=(d.status && (d.status.http_code || d.status.code)) || 0;
      if(code<200 || code>=400) return false;
      if(!d.contents || typeof d.contents!=="string" || d.contents.length<200) return false;
      if(/<title>[^<]*(404|not found|oops|can.t be reached|temporarily unavailable)[^<]*<\/title>/i.test(d.contents.slice(0,3000))) return false;
      return true;
    }catch(e){ proxyDown=true; return true; }
  };
  const flags = await Promise.all(items.map(check));
  if(proxyDown) console.warn("Link checker partially unavailable — some links unverified");
  return items.filter((_,i)=>flags[i]);
}
async function rankFilter(items){
  if(!S.popularOnly || !S.oprKey || !items.length) return items;
  try{
    const doms=[...new Set(items.map(i=>domain(i.url)).filter(Boolean))].slice(0,100);
    const qs=doms.map(d=>"domains%5B%5D="+encodeURIComponent(d)).join("&");
    const r=await fetch("https://openpagerank.com/api/v1.0/getPageRank?"+qs, {headers:{"API-OPR":S.oprKey}});
    if(!r.ok) throw new Error("OPR "+r.status);
    const d=await r.json();
    const rank={};
    (d.response||[]).forEach(x=>{ rank[(x.domain||"").toLowerCase()] = x.status_code===200 ? (+x.page_rank_decimal||0) : 0; });
    const kept = items.filter(i=>{
      const dm=domain(i.url).toLowerCase();
      return rank[dm]==null ? true : rank[dm]>=3.5;
    });
    if(kept.length) return kept;
    return items;
  }catch(e){ console.warn("Popularity check unavailable:",e); return items; }
}

/* ============ feed refresh ============ */
async function refreshFeed(){
  saveSettings(false);
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); showTab("settings"); return; }
  const btn=document.getElementById("refreshBtn");
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Thinking…';
  try{
    const prompt = buildPrompt();
    const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
    const text = await call(prompt);
    let items = dropAlreadySaved(parseItems(text));
    if(!items.length) throw new Error("Model returned no usable items");
    btn.innerHTML='<span class="spin"></span> Checking links…';
    const before=items.length;
    items = (await rankFilter(await validateItems(items))).slice(0, S.itemCount);
    if(!items.length) throw new Error("All suggested links failed the live check — try again");
    items.forEach(i=>shown.push(i.url));
    if(shown.length>200) shown=shown.slice(-200);
    feed = items;
    persistAll();
    if(curTab==="feed") renderFeed(); else updateCounts();
    toast(items.length+" new ideas from "+PROVIDERS[S.provider].label+(before-items.length>Math.min(3,before-S.itemCount)?" ("+(before-items.length)+" dead links filtered)":""));
  }catch(e){
    console.error(e);
    toast("Hmm: "+e.message, 6000);
  }finally{
    btn.disabled=false; btn.innerHTML="&#10227; New ideas";
  }
}

/* ============ stumble ============ */
let stLoading = false;
async function stumbleFetch(){
  if(stLoading) return false;
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); showTab("settings"); return false; }
  stLoading = true; renderStumble();
  try{
    const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
    const items = await rankFilter(await validateItems(dropAlreadySaved(parseItems(await call(buildPrompt("stumble"))))));
    items.forEach(i=>{ i.id="st_"+i.id; shown.push(i.url); });
    if(shown.length>200) shown=shown.slice(-200);
    spool = spool.concat(items.filter(i=>!spool.some(p=>p.url===i.url)));
    persistAll();
    return items.length>0;
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); return false; }
  finally{ stLoading=false; }
}
async function stumbleNext(){
  let pick = ()=>{ const c=applyFilter(spool); return c.length?c[Math.floor(Math.random()*c.length)]:null; };
  let it = pick();
  if(!it){
    const ok = await stumbleFetch();
    it = ok ? pick() : null;
  }
  stCur = it;
  save("stcur", stCur);
  if(stCur) spool = spool.filter(p=>p.url!==stCur.url);
  if(spool.length<3 && !stLoading && stCur) stumbleFetch();
  persistAll(); renderStumble();
}
function renderStumble(){
  const v = document.getElementById("view-stumble");
  if(stLoading && !stCur){
    v.innerHTML = `<div class="empty"><h2>Stumbling…</h2><p>Hunting down corners of the web you didn't know you needed.</p><span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent);width:26px;height:26px"></span></div>`;
    return;
  }
  if(!stCur){
    v.innerHTML = `<div class="empty"><h2>Ready to stumble?</h2><p>One page at a time, picked for your interests. Thumbs up or down to teach it your taste — use the category pills above to stumble within one area.</p><button class="btn btn-primary" onclick="stumbleNext()">&#127922; Stumble</button></div>`;
    return;
  }
  const it = stCur;
  const cat = catByName(it.category);
  const dom = domain(it.url);
  const fav = dom ? `https://www.google.com/s2/favicons?domain=${dom}&sz=64` : "";
  const grad = catGrad(cat);
  const chain = imageChain(it);
  imgChains[it.id] = chain.slice(1);
  v.innerHTML = `<div class="stumble">
    <div class="st-bar"><button class="btn btn-primary" onclick="stumbleNext()" ${stLoading?"disabled":""}>&#127922; Stumble ${stLoading?'<span class="spin"></span>':"&rarr;"}</button></div>
    <div class="st-card">
      <a class="thumb" onclick="stumbleOpen()" title="Open page">
        ${chain[0]?`<img src="${esc(chain[0])}" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}" onerror="nextImg(this,'${esc(it.id)}')" onload="mshotsRetry(this)">`
                  :`<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`}
      </a>
      <div class="st-body">
        <span class="chip" style="background:${cat.chip}">${esc(cat.name)}</span>
        <div class="st-title" onclick="stumbleOpen()">${esc(it.title)}</div>
        <div class="src">${esc(it.source||dom)}</div>
        <div class="benefit"><b>Why for you:</b> ${esc(it.benefit)}</div>
      </div>
      <div class="st-actions">
        <button class="act" onclick="stumbleVote(false)">&#128078; Not my thing</button>
        <button class="act" onclick="stumbleVote(true)">&#128077; More like this</button>
        <button class="act" onclick="stumbleSave()">&#128278; Save</button>
        <button class="act big" onclick="stumbleOpen()">Open page &#8599;</button>
      </div>
    </div>
  </div>`;
}
function stumbleVote(up){
  if(!stCur) return;
  (up?likes:hidden).push({title:stCur.title, category:stCur.category, ts:Date.now()});
  if(likes.length>60) likes=likes.slice(-60);
  if(hidden.length>60) hidden=hidden.slice(-60);
  toast(up?"Noted — more like this":"Noted — less like that");
  stumbleNext();
}
function stumbleSave(){
  if(!stCur) return;
  if(!saved.some(s=>s.url===stCur.url)) saved.unshift(stCur);
  likes.push({title:stCur.title, category:stCur.category, ts:Date.now()});
  toast("Saved");
  stumbleNext();
}
function stumbleOpen(){
  if(!stCur) return;
  clicks.push({title:stCur.title, category:stCur.category, ts:Date.now()});
  if(clicks.length>60) clicks=clicks.slice(-60);
  persistAll();
  window.open(stCur.url,"_blank");
}

/* ============ export guides modal ============ */
const GUIDES = {
  facebook: `<h2>Export your Facebook saves</h2><ol>
    <li>Facebook &rarr; <b>Settings &amp; privacy</b> &rarr; <b>Accounts Center</b></li>
    <li><b>Your information and permissions</b> &rarr; <b>Download your information</b></li>
    <li>Choose <b>Download or transfer information</b> &rarr; select your profile &rarr; <b>Some of your information</b></li>
    <li>Check only <b>Saved items and collections</b></li>
    <li>Format: <b>JSON</b> (or HTML), date range: All time &rarr; <b>Request a download</b></li>
    <li>You'll get a notification within ~24h — download the ZIP and drop it here as-is</li></ol>
    <p>Facebook keeps the file available for only a few days, so grab it promptly.</p>`,
  pinterest: `<h2>Export your Pinterest data</h2><ol>
    <li>Pinterest &rarr; <b>Settings</b> &rarr; <b>Privacy and data</b></li>
    <li><b>Request your data</b> &rarr; confirm</li>
    <li>Pinterest emails you a download link (can take a day or two)</li>
    <li>Download the ZIP and drop it here as-is — pin and board titles become taste signals</li></ol>`,
  oprkey: `<h2>Get a free Open PageRank key</h2><ol>
    <li>Go to <b>domcop.com/openpagerank</b> and click <b>Get API Key</b> / Sign up — free, no credit card</li>
    <li>Verify your email and log in</li>
    <li>Your API key is shown on the dashboard — copy it</li>
    <li>Paste it into the key field here</li></ol>
    <p>Open PageRank scores every domain 0–10 using open Common Crawl link data (Google's original PageRank idea, rebuilt on open data). With the popularity toggle on, the app checks each recommendation's domain in one batched call and drops anything scoring below ~3.5 — small unknown blogs and made-up domains never reach your feed. The free tier allows thousands of checks per hour, far more than this app will ever use.</p>`,
  groqkey: `<h2>Get a free Groq API key</h2><ol>
    <li>Go to <b>console.groq.com</b> and sign up — free, no credit card (Google or GitHub login works)</li>
    <li>In the left menu, open <b>API Keys</b></li>
    <li>Click <b>Create API Key</b>, give it any name (e.g. "Interests App")</li>
    <li>Copy the key immediately — it's shown only once</li>
    <li>Paste it into the key field here and you're done</li></ol>
    <p>Groq runs open models (Llama, etc.) on custom hardware — extremely fast, generous free tier. One caveat: no web search, so recommendation links can occasionally be stale. It shines for the <b>✨ Enrich</b> descriptions and category/interest suggestions; many people keep Gemini for feed refreshes and switch to Groq for the heavy lifting.</p>`,
  youtube: `<h2>Export your YouTube saves</h2><ol>
    <li>Go to <b>takeout.google.com</b> and sign in</li>
    <li><b>Deselect all</b>, then check only <b>YouTube and YouTube Music</b></li>
    <li>Click <b>All YouTube data included</b> &rarr; keep <b>history</b>, <b>playlists</b>, <b>subscriptions</b></li>
    <li><b>Next step</b> &rarr; Export once &rarr; <b>Create export</b></li>
    <li>Download the ZIP (link emailed, expires in ~7 days) and drop it here as-is</li></ol>
    <p>Playlist exports (including Liked videos) contain only video IDs — the app automatically looks up the titles for you (up to 60 per import). Watch history and subscriptions import with full titles. Note: "Watch Later" is not included in Google's export.</p>`
};
function showGuide(p){ document.getElementById("modalBody").innerHTML=GUIDES[p]; document.getElementById("modal").classList.add("open"); }
function closeGuide(){ document.getElementById("modal").classList.remove("open"); }
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeGuide(); });

/* ============ Facebook / Pinterest / YouTube import ============ */
function fixTxt(s){ try{ return decodeURIComponent(escape(s)); }catch(e){ return s; } }
function harvest(node, out, depth){
  depth = depth||0; if(depth>12 || !node) return;
  if(Array.isArray(node)){ node.forEach(n=>harvest(n,out,depth+1)); return; }
  if(typeof node==="object"){
    const title = typeof node.title==="string" ? node.title : (typeof node.name==="string" ? node.name : null);
    const img = ["image","img","thumbnail"].map(k=>node[k]).find(v=>typeof v==="string" && /^https?:\/\//.test(v)) || null;
    const desc = ["desc","description","details"].map(k=>node[k]).find(v=>typeof v==="string" && v.trim().length>10) || null;
    let url = ["url","link","canonical","href"].map(k=>node[k]).find(v=>typeof v==="string" && /^https?:\/\//.test(v)) || null;
    if(!url) for(const k in node){ const v=node[k]; if(typeof v==="string" && /^https?:\/\//.test(v) && v!==img){ url=v; break; } }
    if(title && title.trim().length>5 && title.length<400 && !/^https?:\/\//i.test(title.trim())) out.push({title:title.trim(), url, img, desc});
    for(const k in node) harvest(node[k], out, depth+1);
  }
}
function splitCsv(line){
  const out=[]; let cur="", q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ q=!q; continue; }
    if(ch===','&&!q){ out.push(cur); cur=""; continue; }
    cur+=ch;
  }
  out.push(cur); return out.map(s=>s.trim());
}
function parseCSV(text){
  const items=[], ids=[];
  const lines=(text||"").split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2) return {items, ids};
  const head=splitCsv(lines[0]).map(h=>h.toLowerCase());
  const tIdx=head.findIndex(h=>h.includes("channel title"));
  const vIdx=head.findIndex(h=>h.includes("video id"));
  lines.slice(1).forEach(l=>{
    const cols=splitCsv(l);
    if(tIdx>-1 && cols[tIdx] && cols[tIdx].length>2){ items.push({title:"YouTube channel: "+cols[tIdx]}); }
    else if(vIdx>-1 && /^[\w-]{8,16}$/.test(cols[vIdx]||"")){ ids.push(cols[vIdx]); }
    else if(tIdx===-1 && vIdx===-1){
      const t=cols.find(c=>c && c.length>10 && !/^https?:/.test(c));
      const u=cols.find(c=>/^https?:\/\//.test(c));
      if(t) items.push({title:t, url:u||null});
    }
  });
  return {items, ids};
}
function parsePinterestSAR(text){
  const items=[];
  const parts = text.split(/<a href="(https:\/\/www\.pinterest\.com\/pin\/\d+\/)">/);
  const decode = s=>{ const d=document.createElement("textarea"); d.innerHTML=s; return d.value; };
  for(let i=1; i<parts.length; i+=2){
    const pinUrl=parts[i], body=parts[i+1].slice(0,4000);
    const fld = n=>{
      const m=body.match(new RegExp(n+":\\s*([\\s\\S]*?)\\s*<br>"));
      if(!m) return null;
      const v=decode(m[1].replace(/<[^>]+>/g,"")).trim();
      return (v==="No data"||!v)?null:v;
    };
    if(fld("Alive")==="No") continue;
    const title=fld("Title"), details=fld("Details"), alt=fld("Alt Text"), img=fld("Image");
    const canon=(body.match(/Canonical Link:\s*<a href="([^"]+)"/)||[])[1]||null;
    const t = title || (details?details.slice(0,120):null) || alt;
    if(!t || t.length<6) continue;
    const it={title:t, url:canon||pinUrl, src:"pinterest"};
    if(details && details!==t) it.desc=details;
    if(img && /^[0-9a-f]{32}$/.test(img)) it.img=`https://i.pinimg.com/564x/${img.slice(0,2)}/${img.slice(2,4)}/${img.slice(4,6)}/${img}.jpg`;
    items.push(it);
  }
  return items;
}
function fbDeepName(o){
  if(Array.isArray(o)){ for(const v of o){ const r=fbDeepName(v); if(r) return r; } return null; }
  if(o && typeof o==="object"){
    if(o.label==="Name") return o.value||null;
    for(const k in o){ const r=fbDeepName(o[k]); if(r) return r; }
  }
  return null;
}
function parseFacebookJSON(p){
  const items=[];
  if(p && Array.isArray(p.saves_v2)){
    p.saves_v2.forEach(e=>(e.attachments||[]).forEach(a=>(a.data||[]).forEach(d=>{
      const ec=d.external_context;
      if(ec && ec.name && ec.name.length>5){
        const it={title:String(ec.name).trim()};
        if(/^https?:/.test(ec.source||"")) it.url=ec.source;
        items.push(it);
      }
      if(d.event && d.event.name) items.push({title:"Event: "+d.event.name});
    })));
    return items;
  }
  if(Array.isArray(p) && p.length && p[0] && Array.isArray(p[0].label_values)){
    p.forEach(col=>{
      let cname="";
      (col.label_values||[]).forEach(lv=>{ if(lv.label==="Title") cname=lv.value||""; });
      (col.label_values||[]).forEach(lv=>{
        if(lv.title!=="Saves" || !Array.isArray(lv.dict)) return;
        lv.dict.forEach(item=>{
          let url=null, f={}, group=null, author=null;
          (item.dict||[]).forEach(ent=>{
            if(ent.label==="URL" && /^https?:/.test(ent.value||"")) url=ent.value;
            else if(["Name","Title","Description","Message"].includes(ent.label)) f[ent.label]=ent.value||"";
            else if(ent.title==="Group") group=fbDeepName(ent);
            else if(ent.title==="Author") author=fbDeepName(ent);
          });
          if(!url) return;
          let title=f.Title||f.Name||(f.Message||"").slice(0,120)||(f.Description||"").slice(0,120);
          if(!title || title.length<6) title=(group?group+" post":"Facebook post")+(author?" by "+author:"");
          const it={title:title.trim(), url};
          const desc=f.Description||f.Message;
          if(desc && desc.trim() && desc.slice(0,120)!==title.slice(0,120)) it.desc=desc.trim();
          else if(group) it.desc="Saved from "+group+(cname?" · "+cname:"");
          else if(cname) it.desc="From your '"+cname+"' Facebook collection";
          items.push(it);
        });
      });
    });
  }
  return items;
}
function parseImportText(text, name){
  if(/\.csv$/i.test(name||"")) {
    const r=parseCSV(text);
    return {items:r.items.map(clean), ids:r.ids};
  }
  const out=[]; const t=(text||"").trim();
  if(/pinterest\.com\/pin\/\d+/.test(t) && /Title:/.test(t) && /Image:/.test(t)){
    const pins=parsePinterestSAR(t);
    if(pins.length) return {items: pins.map(p=>Object.assign(clean(p),{src:"pinterest"})), ids:[]};
  }
  if(t.startsWith("{")||t.startsWith("[")){
    try{
      const p=JSON.parse(t);
      const fb=parseFacebookJSON(p);
      if(fb.length) return {items: fb.map(i=>Object.assign(clean(i),{src:"facebook"})), ids:[]};
      harvest(p, out);
    }catch(e){}
  } else if(/<html|<!doctype|<a[ >]/i.test(t)){
    const doc=new DOMParser().parseFromString(t,"text/html");
    doc.querySelectorAll("a").forEach(a=>{
      const txt=(a.textContent||"").trim();
      if(txt.length>10 && txt.length<400 && !/^https?:\/\//i.test(txt)) out.push({title:txt, url:/^https?:/.test(a.href||"")?a.href:null});
    });
  } else {
    t.split(/\n+/).forEach(line=>{
      line=line.trim();
      const m=line.match(/https?:\/\/\S+/);
      const title=line.replace(/https?:\/\/\S+/g,"").replace(/[\[\]()|•·]+/g," ").trim();
      if(title.length>10 && title.length<400) out.push({title, url:m?m[0]:null});
    });
  }
  return {items: out.map(clean), ids: []};
}
function clean(i){
  let title=fixTxt(i.title).replace(/^Watched\s+/,"").trim();
  const o={title:title.slice(0,250), url:i.url||null, ts:Date.now()};
  if(i.img) o.img=i.img;
  if(i.desc) o.desc=fixTxt(i.desc).trim().slice(0,220);
  return o;
}
async function resolveYT(ids){
  ids=[...new Set(ids)].slice(0,60);
  const out=[];
  for(let i=0;i<ids.length;i+=10){
    const chunk=ids.slice(i,i+10);
    const rs=await Promise.allSettled(chunk.map(id=>
      fetch("https://noembed.com/embed?url="+encodeURIComponent("https://www.youtube.com/watch?v="+id)).then(r=>r.json())));
    rs.forEach((r,j)=>{
      if(r.status==="fulfilled" && r.value && r.value.title)
        out.push({title:"YouTube: "+r.value.title, url:"https://www.youtube.com/watch?v="+chunk[j], ts:Date.now(), src:"youtube"});
    });
  }
  return out;
}
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
async function parseZip(f){
  if(!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const zip = await JSZip.loadAsync(f);
  let items=[], ids=[];
  for(const path of Object.keys(zip.files)){
    const e=zip.files[path];
    if(e.dir || !/\.(json|html?|csv)$/i.test(path)) continue;
    if(!/saved|collection|pin|board|watch-history|subscriptions|playlists|liked|history/i.test(path)) continue;
    const r=parseImportText(await e.async("string"), path);
    const h=srcHint(path);
    if(h) r.items.forEach(i=>i.src=h);
    items=items.concat(r.items); ids=ids.concat(r.ids);
  }
  return {items, ids};
}
async function handleImport(ev){
  const files=[...ev.target.files]; if(!files.length) return;
  toast("Reading…");
  let found=[], ids=[];
  for(const f of files){
    try{
      const r = /\.zip$/i.test(f.name) ? await parseZip(f) : parseImportText(await f.text(), f.name);
      const h=srcHint(f.name);
      if(h) r.items.forEach(i=>{ if(!i.src) i.src=h; });
      found=found.concat(r.items); ids=ids.concat(r.ids);
    }catch(e){ console.error(e); toast("Couldn't read "+f.name, 5000); }
  }
  if(ids.length){
    toast("Looking up "+Math.min(ids.length,60)+" YouTube video titles…");
    try{ found=found.concat(await resolveYT(ids)); }catch(e){ console.warn(e); }
  }
  const seen = new Set(imported.map(i=>i.title.toLowerCase()));
  const seenU = new Set(imported.filter(i=>i.url).map(i=>i.url));
  const junk = /^(like|comment|share|save|home|menu|profile|settings|see more|watch|reels?|marketplace|groups?|notifications?)$/i;
  const fresh = found.filter(i=>{
    const k=i.title.toLowerCase();
    if(seen.has(k) || junk.test(k) || /^https?:\/\//i.test(i.title)) return false;
    if(i.url && seenU.has(i.url)) return false;
    seen.add(k); if(i.url) seenU.add(i.url);
    return true;
  });
  imported = imported.concat(fresh).slice(-10000);
  save("imported", imported); writeSavesFile(); renderImportStatus();
  toast(fresh.length ? fresh.length+" items imported — your next refresh will learn from them" : "No new items found in that file", 5000);
  ev.target.value="";
}
function renderImportStatus(){
  const el=document.getElementById("impStatus"); if(!el) return;
  el.innerHTML = imported.length
    ? `<b style="color:var(--chip-life)">&#10003; ${imported.length} imported items</b> shaping recommendations — browse them in the <b>Imported</b> tab &nbsp; <a href="#" onclick="imported=[];save('imported',imported);writeSavesFile();renderImportStatus();updateCounts();return false">clear</a>`
    : "Nothing imported yet.";
  updateCounts();
}

/* ============ imported tab ============ */
let impQuery = "";
let selMode = false;
let selPicks = new Set();
function toggleSelMode(){ selMode=!selMode; if(!selMode) selPicks.clear(); renderImported(); }
function togglePick(idx){ selPicks.has(idx)?selPicks.delete(idx):selPicks.add(idx); renderImported(); }
let impTag = load("itag","");
function setImpTag(t){ impTag = (impTag===t ? "" : t); save("itag", impTag); renderImported(); }
let impSrc = load("isrc","");
const PLATS = [["","All sources"],["facebook","Facebook"],["pinterest","Pinterest"],["youtube","YouTube"],["web","Other web"]];
function setImpSrc(k){ impSrc=k; save("isrc",k); renderCatBar(); renderImported(); }
function updateCounts(){
  document.getElementById("savedCnt").textContent = saved.length?`(${saved.length})`:"";
  document.getElementById("impCnt").textContent = imported.length?`(${imported.length})`:"";
}
function guessCat(title){
  if(/career|linkedin|resume|cv\b|interview|job |job-|recruiter|ats\b|salary/i.test(title)) return "Career movement";
  if(/mindset|calm|stress|burnout|habit|life advice|self-discovery|boundaries|growth|motivat/i.test(title)) return "Life direction & big ideas";
  if(/business|productivity|workflow|meeting|strategy|automation|enterprise|operator/i.test(title)) return "Work initiatives";
  return "Personal projects & hobbies";
}
function renderImported(){
  const v=document.getElementById("view-imported");
  if(!imported.length){
    v.innerHTML = `<div class="empty"><h2>Nothing imported yet</h2><p>Bring in your Facebook, Pinterest, or YouTube saves from <b>Settings &rarr; Import your saves</b> — they'll all be browsable here, and you can promote the keepers to Saved.</p><button class="btn btn-primary" onclick="showTab('settings')">Open Settings</button></div>`;
    return;
  }
  const list = imported.map((it,idx)=>({it,idx}))
    .filter(r=>(!impQuery || r.it.title.toLowerCase().includes(impQuery) || (r.it.desc||"").toLowerCase().includes(impQuery)
                 || (r.it.tags||[]).some(t=>t.includes(impQuery)))
            && (!impSrc || platformOf(r.it)===impSrc)
            && (!impTag || (impTag==="__none" ? !(r.it.tags&&r.it.tags.length) : (r.it.tags||[]).includes(impTag))))
    .sort((a,b)=>(b.it.ts||0)-(a.it.ts||0));
  const todo = imported.filter(i=>!i.desc || (platformOf(i)==="pinterest" && i.url && !i.img && !i.pt)).length;
  v.innerHTML = `
    <div class="imp-head">
      <input type="text" placeholder="Search ${imported.length} imported items…" value="${esc(impQuery)}"
        oninput="impQuery=this.value.toLowerCase();renderImportedKeepFocus()">
      <span class="hint">${list.length} shown</span>
      ${todo?`<button class="btn btn-ghost" id="enrichBtn" onclick="enrichImported()">&#10024; Enrich ${todo} item${todo>1?"s":""}</button>`:""}
      ${(function(){const n=imported.filter(i=>!i.tags).length+saved.filter(i=>!i.tags).length;
        return n?`<button class="btn btn-ghost" id="tagBtn" onclick="autoTag()">&#127991; Tag ${n} item${n>1?"s":""}</button>`:"";})()}
      ${selMode
        ? `<button class="btn btn-primary" id="fetchBtn" onclick="fetchSelectedInfo()" ${selPicks.size?"":"disabled"}>&#11015; Fetch pictures &amp; info (${selPicks.size})</button>
           <button class="btn btn-ghost" onclick="selectShown()">Select all shown</button>
           <button class="btn btn-ghost" onclick="toggleSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleSelMode()">&#9745; Select</button>`}
    </div>
    ${tagBarHTML()}
    <div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div>`;
}
function tagBarHTML(){
  const counts={};
  let untagged=0;
  imported.forEach(i=>{
    if(i.tags && i.tags.length) i.tags.forEach(t=>counts[t]=(counts[t]||0)+1);
    else untagged++;
  });
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,24);
  if(!top.length && !untagged) return "";
  return `<div class="tagbar">
    ${impTag?`<span class="tg on" onclick="setImpTag('${esc(impTag)}')">&#10005; ${esc(impTag==="__none"?"untagged":impTag)}</span>`:""}
    ${top.map(([t,n])=>impTag===t?"":`<span class="tg" onclick="setImpTag('${esc(t)}')">${esc(t)} <b>${n}</b></span>`).join("")}
    ${untagged && impTag!=="__none" ? `<span class="tg" style="opacity:.65" onclick="setImpTag('__none')">untagged <b>${untagged}</b></span>`:""}
  </div>`;
}
const PICONS = {
  youtube:  `<svg class="pic" width="13" height="13" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#f00"/><path d="M9.5 7.5v9l8-4.5z" fill="#fff"/></svg>`,
  facebook: `<svg class="pic" width="13" height="13" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1877f2"/><text x="12" y="18.5" text-anchor="middle" font-size="17" font-weight="bold" fill="#fff" font-family="Arial">f</text></svg>`,
  pinterest:`<svg class="pic" width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#e60023"/><text x="12" y="18" text-anchor="middle" font-size="16" font-weight="bold" fill="#fff" font-family="Arial">P</text></svg>`,
  web:      `<svg class="pic" width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#8a8378"/><ellipse cx="12" cy="12" rx="5" ry="11" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M1 12h22M2.5 6.5h19M2.5 17.5h19" stroke="#fff" stroke-width="1.6" fill="none"/></svg>`
};
function platformOf(it){
  if(it.src && PICONS[it.src]) return it.src;
  const u=(it.url||"").toLowerCase();
  if(/youtube\.com|youtu\.be/.test(u) || /^YouTube/i.test(it.title)) return "youtube";
  if(/pinterest\./.test(u)) return "pinterest";
  if(/facebook\.com|fb\.watch/.test(u)) return "facebook";
  return "web";
}
function cleanDesc(d){
  d=(d||"").replace(/^(this is|this looks like|it is|it's|likely|probably)\s+(a|an|the)?\s*/i,"").trim();
  d=d.replace(/^(a|an|the)?\s*(facebook|pinterest|youtube|instagram)?\s*(video|pin|post|reel|short|clip|channel|board|saved item|page)\s*(about|on|showing|of|that shows|demonstrating|featuring|explaining|covering|for)\s*[:,–-]?\s*/i,"").trim();
  return d ? d.charAt(0).toUpperCase()+d.slice(1) : d;
}
function srcHint(name){
  name=(name||"").toLowerCase();
  if(/youtube|takeout|watch-history|subscription|liked/.test(name)) return "youtube";
  if(/pinterest|\bpins?\b|board/.test(name)) return "pinterest";
  if(/facebook|saved_items|saves|fb/.test(name)) return "facebook";
  return null;
}
function impThumb(it){
  if(it.img) return it.img;
  if(!it.url) return null;
  const yt = it.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{8,16})/);
  if(yt) return "https://i.ytimg.com/vi/"+yt[1]+"/mqdefault.jpg";
  if(/facebook\.com|fb\.watch/.test(it.url)) return null;
  return "https://s0.wp.com/mshots/v1/"+encodeURIComponent(it.url)+"?w=320";
}

/* ============ enrichment (Pinterest metadata, AI descriptions) ============ */
async function fetchPinBatch(ids){
  try{
    const r = await fetch("https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids="+ids.join(","));
    if(!r.ok) return {};
    const d = await r.json();
    const map={};
    (d.data||[]).forEach(p=>{
      if(!p||!p.id) return;
      const img=((p.images&&(p.images["564x"]||p.images["474x"]||p.images["237x"]))||{}).url||null;
      const title=(p.rich_metadata&&(p.rich_metadata.title||(p.rich_metadata.article&&p.rich_metadata.article.name)))||null;
      map[p.id]={img, title, desc:(p.description||"").trim()||null};
    });
    return map;
  }catch(e){ return {}; }
}
async function fetchMicrolink(url){
  try{
    const r = await fetch("https://api.microlink.io/?url="+encodeURIComponent(url));
    if(!r.ok) return null;
    const d = await r.json();
    if(d.status!=="success"||!d.data) return null;
    return {img:(d.data.image&&d.data.image.url)||null, title:d.data.title||null, desc:d.data.description||null};
  }catch(e){ return null; }
}
function genericTitle(t){ return t.length<25 || /^\d+\s*(photo|video)s?\b/i.test(t); }
async function enrichPins(){
  const pins = imported.filter(i=>platformOf(i)==="pinterest" && i.url && !i.img && !i.pt);
  if(!pins.length) return 0;
  let got=0;
  const apply=(p,m)=>{
    if(!m) return;
    if(m.img){ p.img=m.img; got++; }
    if(m.title && genericTitle(p.title)) p.title=m.title.slice(0,250);
    if(m.desc && !p.desc) p.desc=m.desc.slice(0,220);
  };
  const withId = pins.map(p=>({p, id:(p.url.match(/\/pin\/(\d+)/)||[])[1]})).filter(x=>x.id);
  for(let i=0;i<withId.length;i+=10){
    const chunk=withId.slice(i,i+10);
    const map=await fetchPinBatch(chunk.map(c=>c.id));
    chunk.forEach(c=>{ c.p.pt=1; apply(c.p, map[c.id]); });
  }
  for(const p of pins.filter(x=>!x.img).slice(0,25)){
    p.pt=1; apply(p, await fetchMicrolink(p.url));
  }
  save("imported",imported); writeSavesFile();
  return got;
}
async function enrichImported(){
  const btn=document.getElementById("enrichBtn");
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Enriching…'; }
  try{
    const gotPins = await enrichPins();
    if(gotPins) toast(gotPins+" Pinterest pin image"+(gotPins>1?"s":"")+" fetched");
  }catch(e){ console.warn(e); }
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Pin data done — add your "+PROVIDERS[S.provider].keyName+" in Settings for AI descriptions"); renderImportedKeepFocus(); return; }
  try{
    let done=0;
    while(done<120){
      const batch = imported.filter(i=>!i.desc).slice(0,40);
      if(!batch.length) break;
      const prompt = `Here are titles of things Dave saved on social platforms. For EACH numbered title, write ONE short sentence (under 20 words) describing what it likely is and why it caught his eye. Never name the platform or content type — no "Facebook post", "Pinterest pin", "YouTube video", "reel", or "This is a…". Start directly with the substance (e.g. "Bass-fishing knot trick that locks under tension."). No web search needed — infer from the title. Return ONLY a JSON array of ${batch.length} strings, same order, no other text.

${batch.map((b,i)=>(i+1)+". "+b.title).join("\n")}`;
      const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
      const text = await call(prompt);
      const t = text.replace(/```json|```/g,"").trim();
      const a=t.indexOf("["), z=t.lastIndexOf("]");
      if(a===-1||z===-1) throw new Error("No descriptions found in model response");
      const arr = JSON.parse(t.slice(a,z+1));
      batch.forEach((b,i)=>{ if(typeof arr[i]==="string" && arr[i].trim()) b.desc=arr[i].trim().slice(0,220); });
      done += batch.length;
      save("imported",imported); writeSavesFile();
      toast(done+" described…");
    }
    const left = imported.filter(i=>!i.desc).length;
    toast(left? "Pausing here — click again to describe the remaining "+left : "All imported items described");
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); }
  renderImportedKeepFocus();
}

/* ============ auto-tagging ============ */
async function autoTag(){
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return; }
  const btn=document.getElementById("tagBtn");
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Tagging…'; }
  try{
    let done=0;
    while(done<120){
      const queue = imported.filter(i=>!i.tags).concat(saved.filter(i=>!i.tags)).slice(0,40);
      if(!queue.length) break;
      const prompt = `Tag each numbered saved item for Dave's interest app. For EACH item return 2-4 short lowercase keyword tags (1-2 words each, reusable across items — e.g. "3d printing", "bass fishing", "claude", "recipes", "linkedin") and the ONE best-fit category, chosen ONLY from this exact list: ${CATS.map(c=>c.name).join(" | ")}.
Return ONLY a JSON array of ${queue.length} objects, same order, shape: [{"t":["tag1","tag2"],"c":"Category Name"}]

${queue.map((q,i)=>(i+1)+". "+q.title+(q.desc?" — "+q.desc.slice(0,80):"")).join("\n")}`;
      const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
      const text = await call(prompt);
      const t = text.replace(/```json|```/g,"").trim();
      const a=t.indexOf("["), z=t.lastIndexOf("]");
      if(a===-1||z===-1) throw new Error("No tags found in model response");
      const arr = JSON.parse(t.slice(a,z+1));
      queue.forEach((q,i)=>{
        const r=arr[i]||{};
        q.tags = Array.isArray(r.t) ? r.t.filter(x=>typeof x==="string"&&x.trim()).slice(0,4).map(x=>x.trim().toLowerCase()) : [];
        if(!q.tags.length) q.tags=["misc"];
        const cat = catByName(String(r.c||"")).name;
        if(q.category!==undefined) q.category = cat;
        else q.cat = cat;
      });
      done += queue.length;
      save("imported",imported); persistAll();
      toast(done+" tagged…");
    }
    const left = imported.filter(i=>!i.tags).length + saved.filter(i=>!i.tags).length;
    toast(left ? "Pausing — click Tag again for the remaining "+left : "Everything is tagged and categorized");
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); }
  if(curTab==="saved") renderSaved();
  renderImportedKeepFocus();
}
function tagRow(tags){
  return tags && tags.length
    ? `<div class="tagsline">${tags.map(t=>`<span class="tg${impTag===t?" on":""}" onclick="event.stopPropagation();if(curTab!=='imported')showTab('imported');setImpTag('${esc(t)}')">${esc(t)}</span>`).join("")}</div>`
    : "";
}
function renderImportedKeepFocus(){
  const pos=document.activeElement&&document.activeElement.selectionStart;
  renderImported();
  const inp=document.querySelector(".imp-head input");
  if(inp){ inp.focus(); if(pos!=null) inp.setSelectionRange(pos,pos); }
}
function selectShown(){
  imported.map((it,idx)=>({it,idx}))
    .filter(r=>(!impQuery || r.it.title.toLowerCase().includes(impQuery) || (r.it.desc||"").toLowerCase().includes(impQuery)
                 || (r.it.tags||[]).some(t=>t.includes(impQuery)))
            && (!impSrc || platformOf(r.it)===impSrc)
            && (!impTag || (impTag==="__none" ? !(r.it.tags&&r.it.tags.length) : (r.it.tags||[]).includes(impTag))))
    .forEach(r=>selPicks.add(r.idx));
  renderImported();
}
function ogParse(html){
  const pick = p=>{
    let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\'](?:og:'+p+'|twitter:'+p+')["\'][^>]*content=["\']([^"\']+)','i'))
         || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og:'+p+'|twitter:'+p+')','i'));
    return m ? m[1].replace(/&amp;/g,"&").replace(/&#0?39;/g,"'").replace(/&quot;/g,'"').trim() : null;
  };
  return {img:pick("image"), title:pick("title"), desc:pick("description")};
}
async function fetchSelectedInfo(){
  const targets = [...selPicks].map(i=>imported[i]).filter(it=>it && it.url).slice(0,40);
  if(!targets.length){ toast("Select some items with links first"); return; }
  const btn=document.getElementById("fetchBtn");
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Fetching…';
  let gotImg=0, gotInfo=0;
  for(let i=0;i<targets.length;i+=6){
    await Promise.all(targets.slice(i,i+6).map(async it=>{
      try{
        const ctl=new AbortController(); const tm=setTimeout(()=>ctl.abort(), 9000);
        const r=await fetch("https://api.allorigins.win/get?url="+encodeURIComponent(it.url), {signal:ctl.signal});
        clearTimeout(tm);
        if(!r.ok) return;
        const d=await r.json();
        if(!d.contents || typeof d.contents!=="string") return;
        const og=ogParse(d.contents.slice(0,60000));
        if(og.img && /^https?:/.test(og.img) && !it.img){ it.img=og.img; gotImg++; }
        if(og.desc && og.desc.length>15 && /login|log in to facebook|see posts, photos/i.test(og.desc)===false && (!it.desc || it.desc.startsWith("Saved from") || it.desc.startsWith("From your"))){ it.desc=og.desc.slice(0,220); gotInfo++; }
        if(og.title && og.title.length>10 && !/facebook|log in/i.test(og.title) && genericTitle(it.title)) it.title=og.title.slice(0,250);
        it.fi=1;
      }catch(e){}
    }));
    toast("Fetched "+Math.min(i+6,targets.length)+" of "+targets.length+"…");
  }
  const noDesc = [...selPicks].map(i=>imported[i]).filter(it=>it && !it.desc).slice(0,40);
  if(noDesc.length && (S.keys[S.provider] || S.provider==="local")){
    try{
      const prompt = `For EACH numbered saved-item title, write ONE short sentence (under 20 words) describing what it likely is. No platform names, no "This is" filler — start with the substance. Return ONLY a JSON array of ${noDesc.length} strings, same order.

${noDesc.map((b,i)=>(i+1)+". "+b.title).join("\n")}`;
      const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
      const text = await call(prompt);
      const t=text.replace(/```json|```/g,"").trim();
      const a=t.indexOf("["), z=t.lastIndexOf("]");
      if(a>-1&&z>-1){ const arr=JSON.parse(t.slice(a,z+1));
        noDesc.forEach((b,i)=>{ if(typeof arr[i]==="string"&&arr[i].trim()){ b.desc=arr[i].trim().slice(0,220); gotInfo++; } }); }
    }catch(e){ console.warn(e); }
  }
  save("imported",imported); writeSavesFile();
  selPicks.clear();
  renderImported();
  toast(gotImg+" picture"+(gotImg===1?"":"s")+" and "+gotInfo+" description"+(gotInfo===1?"":"s")+" fetched"+(targets.length>=40?" (40 max per run)":""), 6000);
}
function impCardHTML(it,idx){
  const dom = it.url ? domain(it.url) : "";
  const yt = /^YouTube/i.test(it.title) || /youtu/.test(dom);
  const thumb = impThumb(it);
  const fvFallback = dom
    ? `this.className='fv';this.src='https://www.google.com/s2/favicons?domain=${esc(dom)}&sz=64';this.onerror=function(){this.outerHTML='<div class=ic>${yt?"YT":"IM"}</div>'}`
    : `this.outerHTML='<div class=ic>${yt?"YT":"IM"}</div>'`;
  const icon = thumb
    ? `<img class="th" src="${esc(thumb)}" loading="lazy" onclick="impOpen(${idx})" onerror="${fvFallback}">`
    : (dom
      ? `<img class="fv" src="https://www.google.com/s2/favicons?domain=${esc(dom)}&sz=64" onerror="this.outerHTML='<div class=ic>${yt?"YT":"IM"}</div>'">`
      : `<div class="ic">${yt?"YT":"IM"}</div>`);
  return `<div class="imp-card${selPicks.has(idx)?" selpick":""}">
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:""}
    ${icon}
    <div style="flex:1">
      <div class="imp-t${it.url?" link":""}" ${it.url?`onclick="impOpen(${idx})"`:""}>${esc(it.title)}</div>
      ${it.desc?`<div class="imp-desc">${PICONS[platformOf(it)]}${esc(cleanDesc(it.desc))}</div>`:""}
      <div class="imp-d">${it.desc?"":PICONS[platformOf(it)]}${esc(dom||"no link — title only")}${it.liked?" · &#128077; liked":""}</div>
      ${tagRow(it.tags)}
      <div class="imp-acts">
        ${it.liked?"":`<button onclick="impLike(${idx})">&#128077; Like</button>`}
        ${it.url?`<button onclick="impSave(${idx})">&#128278; Save</button>`:""}
        <button onclick="impDrop(${idx})">&#10005;</button>
      </div>
    </div>
  </div>`;
}
function impOpen(idx){
  const it=imported[idx]; if(!it||!it.url) return;
  clicks.push({title:it.title, category:guessCat(it.title), ts:Date.now()});
  if(clicks.length>60) clicks=clicks.slice(-60);
  persistAll();
  window.open(it.url,"_blank");
}
function impLike(idx){
  const it=imported[idx]; if(!it) return;
  it.liked=true;
  likes.push({title:it.title, category:guessCat(it.title), ts:Date.now()});
  if(likes.length>60) likes=likes.slice(-60);
  save("imported",imported); persistAll(); renderImportedKeepFocus();
  toast("Liked — more like this in your feed");
}
function impSave(idx){
  const it=imported[idx]; if(!it||!it.url) return;
  if(!saved.some(s=>s.url===it.url)){
    saved.unshift({
      id:"imp_"+Date.now().toString(36)+"_"+idx,
      title:it.title.replace(/^YouTube( channel)?:\s*/i,""),
      url:it.url, source:domain(it.url),
      category:it.cat||guessCat(it.title),
      tags:it.tags,
      benefit:(it.desc?cleanDesc(it.desc)+" ":"")+"Promoted from your imported saves — you flagged this one as a keeper.",
      image:it.img||(/youtube\.com|youtu\.be/.test(it.url)?impThumb(it):null)
    });
  }
  imported.splice(idx,1);
  save("imported",imported); persistAll(); renderImportedKeepFocus(); updateCounts();
  toast("Moved to Saved");
}
function impDrop(idx){
  imported.splice(idx,1);
  save("imported",imported); writeSavesFile(); renderImportedKeepFocus(); updateCounts();
}

/* ============ custom categories ============ */
let catSugs = [];
function addCategory(name){
  name = (name || document.getElementById("newCatName").value || "").trim();
  if(!name){ toast("Type a category name first"); return; }
  if(name.length>60) name=name.slice(0,60);
  const key = "c_"+name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  if(CATS.some(c=>c.key===key || c.name.toLowerCase()===name.toLowerCase())){ toast("That category already exists"); return; }
  S.extraCats.push({key, name, color:CAT_PALETTE[S.extraCats.length % CAT_PALETTE.length]});
  S.weights[key]=5;
  save("settings", S); rebuildCats();
  const inp=document.getElementById("newCatName"); if(inp) inp.value="";
  renderSettings(); renderCatBar();
  toast('"'+name+'" added — set its importance with the slider');
}
function removeCategory(key){
  const c=CATS.find(x=>x.key===key);
  if(!c || !c.custom) return;
  S.extraCats = S.extraCats.filter(x=>x.key!==key);
  delete S.weights[key];
  if(filterCat===key){ filterCat=""; save("fcat",""); }
  save("settings", S); rebuildCats();
  renderSettings(); renderCatBar();
}
async function suggestCategories(){
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" first"); return; }
  const btn=document.getElementById("catSugBtn");
  btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Thinking…';
  try{
    const sample = imported.slice().sort(()=>Math.random()-.5).slice(0,40).map(i=>"- "+i.title).join("\n");
    const prompt = `Dave's discovery-feed app organizes recommendations into categories. Existing categories (do NOT repeat or near-duplicate these): ${CATS.map(c=>c.name).join("; ")}.

ABOUT DAVE: ${S.about}
INTERESTS: ${S.interests}
SAMPLE OF THINGS HE SAVES:
${sample||"(none)"}

Suggest 6-10 NEW feed categories (2-4 words each, title case) that would usefully partition his interests — specific enough to be meaningful, broad enough to fill a feed section. Return ONLY a JSON array of strings.`;
    const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
    const text = await call(prompt);
    const t = text.replace(/```json|```/g,"").trim();
    const a=t.indexOf("["), z=t.lastIndexOf("]");
    if(a===-1||z===-1) throw new Error("No suggestions found in model response");
    catSugs = JSON.parse(t.slice(a,z+1)).filter(x=>typeof x==="string" && x.trim())
      .filter(x=>!CATS.some(c=>c.name.toLowerCase()===x.trim().toLowerCase()))
      .slice(0,12).map(x=>({name:x.trim(), sel:false}));
    renderCatSugs();
    if(!catSugs.length) toast("Nothing new suggested — your categories already cover it");
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); }
  finally{ btn.disabled=false; btn.innerHTML="&#10024; Suggest categories"; }
}
function renderCatSugs(){
  document.getElementById("catSuggest").innerHTML = catSugs.map((s,i)=>
    `<button class="tagchip${s.sel?" sel":""}" onclick="catSugs[${i}].sel=!catSugs[${i}].sel;renderCatSugs()">${s.sel?"&#10003; ":""}${esc(s.name)}</button>`).join("");
  document.getElementById("catSugAdd").style.display = catSugs.some(s=>s.sel)?"":"none";
}
function addSelectedCats(){
  const picks = catSugs.filter(s=>s.sel);
  picks.forEach(s=>addCategory(s.name));
  catSugs = catSugs.filter(s=>!s.sel);
  renderCatSugs();
}

/* ============ interest discovery ============ */
let discTags = [];
async function discoverInterests(){
  const txt = document.getElementById("discInput").value.trim();
  if(!txt){ toast("Type a few words about what you might be into first"); return; }
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" first"); return; }
  const btn=document.getElementById("discBtn");
  btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Thinking…';
  try{
    const prompt = `Dave is exploring new interests. His existing interest profile:
${S.interests}

He just typed this rough musing about things he might be into:
"${txt}"

Suggest 10-14 concise interest categories (2-5 words each) he could add to his profile. Make them specific and feed-able (good topics for finding articles/projects), expand on what he typed, include a few adjacent ideas he didn't think of, and do NOT duplicate anything already in his profile. Return ONLY a JSON array of strings, e.g. ["MIG welding basics","drip irrigation automation"]`;
    const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, local:callLocal}[S.provider];
    const text = await call(prompt);
    const t = text.replace(/```json|```/g,"").trim();
    const a=t.indexOf("["), b=t.lastIndexOf("]");
    if(a===-1||b===-1) throw new Error("No suggestions found in model response");
    const arr = JSON.parse(t.slice(a,b+1));
    discTags = arr.filter(x=>typeof x==="string" && x.trim()).slice(0,16).map(x=>({name:x.trim(), sel:false}));
    renderDiscTags();
    if(!discTags.length) toast("No suggestions came back — try rephrasing");
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); }
  finally{ btn.disabled=false; btn.innerHTML="&#10024; Suggest interest categories"; }
}
function renderDiscTags(){
  document.getElementById("discResults").innerHTML = discTags.map((tg,i)=>
    `<button class="tagchip${tg.sel?" sel":""}" onclick="toggleTag(${i})">${tg.sel?"&#10003; ":""}${esc(tg.name)}</button>`).join("");
  document.getElementById("discAdd").style.display = discTags.some(tg=>tg.sel)?"":"none";
}
function toggleTag(i){ discTags[i].sel=!discTags[i].sel; renderDiscTags(); }
function addDiscovered(){
  const add = discTags.filter(tg=>tg.sel).map(tg=>tg.name);
  if(!add.length) return;
  S.interests = S.interests.replace(/[,\s]+$/,"") + ", " + add.join(", ");
  document.getElementById("interestList").value = S.interests;
  save("settings", S); writeSavesFile();
  discTags = discTags.filter(tg=>!tg.sel);
  renderDiscTags();
  toast(add.length+" interest"+(add.length>1?"s":"")+" added to your profile");
}

/* ============ saves.json bridge (File System Access API) ============ */
let dirHandle = null;
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open("ia_fs",1);
  r.onupgradeneeded=()=>r.result.createObjectStore("kv");
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction("kv","readwrite"); tx.objectStore("kv").put(v,k); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); }); }
async function idbGet(k){ const db=await idb(); return new Promise((res,rej)=>{ const rq=db.transaction("kv").objectStore("kv").get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }

async function connectFolder(){
  if(!window.showDirectoryPicker){ toast("Your browser doesn't support this — use Chrome or Edge"); return; }
  try{
    dirHandle = await window.showDirectoryPicker({mode:"readwrite"});
    await idbSet("dir", dirHandle);
    setFsStatus(true);
    await writeSavesFile();
    toast("Connected — saves.json will stay in sync");
  }catch(e){ /* user cancelled */ }
}
async function restoreFolder(){
  try{
    const h = await idbGet("dir");
    if(!h) return;
    const p = await h.queryPermission({mode:"readwrite"});
    if(p==="granted"){ dirHandle=h; setFsStatus(true); }
    else{
      const b=document.createElement("div");
      b.className="banner";
      b.innerHTML=`<span>&#128279; Reconnect <b>saves.json</b> sync for Notion &amp; your morning briefing</span>
        <button class="btn btn-primary" style="padding:6px 14px">Reconnect</button>`;
      b.querySelector("button").onclick=async()=>{
        if(await h.requestPermission({mode:"readwrite"})==="granted"){ dirHandle=h; setFsStatus(true); writeSavesFile(); b.remove(); toast("Sync reconnected"); }
      };
      document.querySelector("main").prepend(b);
    }
  }catch(e){ console.warn(e); }
}
function setFsStatus(on){
  const el=document.getElementById("fsStatus");
  if(el) el.innerHTML = on?'<b style="color:var(--chip-life)">&#10003; Connected — saves.json syncing</b>':"Not connected";
}
let _wTimer=null;
function writeSavesFile(){
  if(!dirHandle) return;
  clearTimeout(_wTimer);
  _wTimer=setTimeout(async()=>{
    try{
      const fh = await dirHandle.getFileHandle("saves.json",{create:true});
      const w = await fh.createWritable();
      await w.write(JSON.stringify({
        updated:new Date().toISOString(),
        about:S.about, interests:S.interests, weights:S.weights,
        saved, hidden, clicks, likes, imported
      },null,2));
      await w.close();
    }catch(e){ console.warn("saves.json write failed",e); }
  },400);
}

/* ============ init ============ */
(function(){
  feed = dropAlreadySaved(feed); save("feed", feed);
  const before=imported.length;
  imported = imported.filter(i=>!/^https?:\/\//i.test(i.title));
  imported = imported.filter(i=>!/^.{2,40}\bsaved\b.{0,80}\b(link|post|video|event)\b\.?$/i.test(i.title));
  let wiped=0;
  imported.forEach(i=>{
    if(i.desc && /\blikely\b/i.test(i.desc) && /\b(pin|post|video|image|idea|visual|interest)\b/i.test(i.desc)){ delete i.desc; wiped++; }
  });
  if(imported.length!==before || wiped){
    save("imported", imported);
    setTimeout(()=>toast("Cleaned up "+(before-imported.length)+" junk imports, reset "+wiped+" vague descriptions — re-import pinterest-import.json, then hit Enrich"), 800);
  }
})();
save("settings", S);
updateCounts();
showTab(load("tab","feed"));
restoreFolder();
