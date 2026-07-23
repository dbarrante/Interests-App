# LOOP-06 battery runner — drives the throwaway instance (:3990) with Playwright.
# Read-only UX audit: visual sweep + horizontal-overflow, WCAG contrast + focus state
# (both themes), error/network degradation, memory-transparency surfaces.
from playwright.sync_api import sync_playwright
import json, pathlib

BASE = "http://127.0.0.1:3990"
OUT = pathlib.Path(__file__).resolve().parent / "2026-07-04"
SHOTS = OUT / "shots"; SHOTS.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [("mobile", 375, 812), ("tablet", 768, 1024), ("desktop", 1440, 900)]
THEMES = ["light", "dark"]
VIEWS = ["stumble", "saved", "imported", "settings"]
f = {"overflow": [], "contrast": [], "states": [], "degradation": {}, "memory": {}, "pageerrors": []}

CONTRAST_JS = r'''() => {
  function lum(c){ const a=c.map(v=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
  function parse(s){ const m=(s||'').match(/rgba?\(([^)]+)\)/); if(!m) return null; return m[1].split(',').map(x=>parseFloat(x)); }
  function effbg(el){ let e=el; while(e){ const p=parse(getComputedStyle(e).backgroundColor); if(p && (p.length<4 || p[3]>0)) return [p[0],p[1],p[2]]; e=e.parentElement; } return [255,255,255]; }
  function ratio(el){ const fg=parse(getComputedStyle(el).color); if(!fg) return null; const bg=effbg(el); const L1=lum(fg.slice(0,3)),L2=lum(bg); return Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))*100)/100; }
  const out=[];
  ['.hint','.sub','.tab','.btn.btn-primary','.btn','.empty p','h2','h3','label'].forEach(sel=>{
    const el=[...document.querySelectorAll(sel)].find(e=>e.offsetParent!==null && e.innerText && e.innerText.trim());
    if(el){ const cs=getComputedStyle(el); out.push({sel, ratio:ratio(el), size:cs.fontSize, weight:cs.fontWeight, text:el.innerText.slice(0,30)}); }
  });
  return out;
}'''

def set_theme(page, t): page.evaluate("(t)=>{ try{ setTheme(t); }catch(e){ document.documentElement.classList.toggle('dark', t==='dark'); } }", t)
def show(page, v):
    page.evaluate("(v)=>{ try{ showTab(v); }catch(e){} }", v); page.wait_for_timeout(350)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width":1440,"height":900})
    ctx.set_extra_http_headers({"Cache-Control": "no-store"})  # always fetch fresh (avoid stale-CSS re-run artifacts)
    page = ctx.new_page()
    page.on("pageerror", lambda e: f["pageerrors"].append(str(e)))
    page.goto(BASE, wait_until="networkidle"); page.wait_for_timeout(800)

    # NODE 2 (visual + overflow) across theme x viewport x view; NODE 3 contrast per theme
    for theme in THEMES:
        set_theme(page, theme)
        for view in VIEWS:
            for (vp,w,h) in VIEWPORTS:
                page.set_viewport_size({"width":w,"height":h}); show(page, view)
                ov = page.evaluate("()=>({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})")
                f["overflow"].append({"view":view,"vp":vp,"theme":theme,"scrollW":ov["sw"],"clientW":ov["cw"],"overflow": ov["sw"] > ov["cw"]+2})
                page.screenshot(path=str(SHOTS/f"{view}_{vp}_{theme}.png"))
        page.set_viewport_size({"width":1440,"height":900}); show(page,"settings")
        f["contrast"].append({"theme":theme, "samples": page.evaluate(CONTRAST_JS)})

    # NODE 3 focus-state visibility on the primary button, both themes
    for theme in THEMES:
        set_theme(page, theme); show(page,"stumble")
        st = page.evaluate('''()=>{ const el=document.querySelector('.btn.btn-primary')||document.querySelector('.btn'); if(!el) return null; el.focus(); const cs=getComputedStyle(el); return {outlineStyle:cs.outlineStyle, outlineWidth:cs.outlineWidth, boxShadow:cs.boxShadow!=='none'}; }''')
        f["states"].append({"theme":theme, "focus_primary": st})

    # NODE 4 degradation — (a) stumble with no AI key; (b) abort /api and reload
    show(page,"stumble")
    f["degradation"]["no_key_stumble"] = page.evaluate('''async ()=>{
      try{ window.spool=[]; window.stDeal=[]; if(typeof stumbleNext==='function') await stumbleNext(true);
        const t=[...document.querySelectorAll('div,span')].find(e=>/add your|settings first|couldn/i.test(e.innerText||''));
        return {crashed:false, message: t? t.innerText.slice(0,120): null, onSettings: (typeof curTab!=='undefined'? curTab: null)}; }
      catch(e){ return {crashed:true, error:String(e)}; }
    }''')
    page.route("**/api/**", lambda r: r.abort())
    try:
        page.reload(wait_until="domcontentloaded"); page.wait_for_timeout(1800)
        body = page.evaluate("()=>({txt:document.body.innerText.trim(), nav:!!document.querySelector('.tab'), kids:document.body.children.length, banner:!!document.querySelector('#bootErr')})")
        f["degradation"]["api_down_reload"] = {"whiteScreen": (len(body["txt"])==0 or body["kids"]==0), "navPresent": body["nav"], "errorBanner": body["banner"], "sample": body["txt"][:140]}
    except Exception as e:
        f["degradation"]["api_down_reload"] = {"error": str(e)}
    page.unroute("**/api/**")

    # NODE 5 memory-transparency
    page.reload(wait_until="networkidle"); page.wait_for_timeout(900); show(page,"settings")
    page.screenshot(path=str(SHOTS/"settings_memory_full.png"), full_page=True)
    f["memory"] = page.evaluate('''()=>{ const txt=document.body.innerText;
      return {
        resetLearning: !!document.querySelector('[onclick*="resetLearning"]'),
        buildProfile: !!(document.querySelector('[onclick*="buildMyProfile"]')||document.querySelector('#analyzeLibBtn')),
        aboutEditable: !!document.querySelector('#aboutMe'),
        interestsEditable: !!document.querySelector('#interests,[id*="nterest"]'),
        categoryWeights: document.querySelectorAll('#sliders input[type=range]').length,
        mentionsLearningHistory: /learning history/i.test(txt),
        individualMemoryList: !!document.querySelector('#learnedList,[data-memory],.memory-item,#memoryList,#likesList,#hiddenList'),
        learnedItems: document.querySelectorAll('#learnedList [onclick*="removeLearned"]').length
      };
    }''')
    b.close()

OUT.joinpath("findings.json").write_text(json.dumps(f, indent=2))
print(json.dumps(f, indent=2))
print("SCREENSHOTS:", len(list(SHOTS.glob("*.png"))))
