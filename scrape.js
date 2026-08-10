const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const MAX_LINKS = +(process.env.MAX_LINKS || 40), MAX_SCROLLS = +(process.env.MAX_SCROLLS || 10);
const STORES = [
  { name: 'Seasons', home: 'https://seasonskosher.com/lakewood', linkRe: /(department|category|c\/|categories|aisle)/i },
  { name: 'Gourmet Glatt', home: 'https://www.gourmetglattonline.com/categories', linkRe: /\/categories\/\d+/i },
];
const STOP = new Set(['featured products','specials','weekly specials','new items','meat','dairy','produce','bakery','grocery','frozen','deli','fish','appetizing','health & beauty','household','beverages','snacks','candy','wine & liquor','pharmacy','departments','shop by department','categories','featured','all products','products','view all','see all','shop now','add to cart','out of stock']);
const junk = s => { const n=(s||'').trim(); return n.length<3||n.length>90||STOP.has(n.toLowerCase())||!/[a-z]/.test(n)||/^\$?\d/.test(n); };
const cleanTitle = t => { if(!t) return null; let s=String(t).split('|')[0].split('-')[0].trim(); return (!s||s.length<2||/^(shop|home|welcome)/i.test(s)||STOP.has(s.toLowerCase()))?null:s; };
const extractDom = page => page.$$eval('[class*="product"],[class*="item"],[class*="tile"],[class*="card"]', cards => {
  const out=[], seen=new Set();
  for(const el of cards){
    const txt=(el.innerText||'').trim(), pm=txt.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
    if(!pm) continue;
    const price=parseFloat(pm[1]); if(!(price>0)) continue;
    let name='';
    const ne=el.querySelector('[class*="name"],[class*="title"],[class*="desc"],h2,h3,h4,h5');
    if(ne) name=(ne.innerText||'').trim();
    if(!name){ const im=el.querySelector('img[alt]'); if(im) name=(im.getAttribute('alt')||'').trim(); }
    if(!name){ const l=txt.split('\n').map(s=>s.trim()).find(s=>s&&!/^\$?\d/.test(s)); if(l) name=l; }
    name=name.replace(/\$\s?\d+(?:\.\d{1,2})?/g,'').replace(/\s+/g,' ').trim();
    if(name.length<3) continue;
    const key=name.toLowerCase()+'|'+price; if(seen.has(key)) continue; seen.add(key);
    out.push({name,price});
  }
  return out;
});
async function crawlStore(browser, cfg){
  const page = await browser.newPage({ userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const byKey=new Map(), now=new Date().toISOString();
  let cat=null;
  const add=(name,price)=>{ if(junk(name)) return; const k=name.toLowerCase()+'|'+price; if(!byKey.has(k)) byKey.set(k,{store:cfg.name,name,size:null,price,category:cat,scrapedAt:now}); };
  async function loadAndExtract(){
    let stag=0;
    for(let i=0;i<MAX_SCROLLS&&stag<2;i++){
      const before=byKey.size;
      try{ for(const it of await extractDom(page)) add(it.name,it.price); }catch{}
      try{ await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); }catch{}
      await page.waitForTimeout(1200);
      if(byKey.size===before) stag++; else stag=0;
    }
  }
  console.log(`[${cfg.name}] opening ${cfg.home}`);
  try{ await page.goto(cfg.home,{waitUntil:'domcontentloaded',timeout:60000}); }
  catch(e){ console.log(`[${cfg.name}] home failed: ${e.message.split('\n')[0]}`); await page.close(); return []; }
  await page.waitForTimeout(6000);
  let links=[];
  try{ const h=await page.$$eval('a[href]',as=>as.map(a=>a.href)); links=[...new Set(h)].filter(u=>cfg.linkRe.test(u)).slice(0,MAX_LINKS); }catch{}
  console.log(`[${cfg.name}] visiting ${links.length} category links`);
  cat=cleanTitle(await page.title().catch(()=>null)); await loadAndExtract();
  for(const link of links){
    try{ await page.goto(link,{waitUntil:'domcontentloaded',timeout:45000}); await page.waitForTimeout(2500); cat=cleanTitle(await page.title().catch(()=>null)); await loadAndExtract(); }
    catch(e){ console.log(`[${cfg.name}] skip: ${e.message.split('\n')[0]}`); }
  }
  await page.close();
  const recs=[...byKey.values()];
  console.log(`[${cfg.name}] captured ${recs.length} products`);
  return recs;
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  let all=[];
  for(const cfg of STORES){ try{ all=all.concat(await crawlStore(browser,cfg)); }catch(e){ console.error(`${cfg.name} failed:`,e.message); } }
  await browser.close();
  const outDir=path.join(__dirname,'data'); fs.mkdirSync(outDir,{recursive:true});
  fs.writeFileSync(path.join(outDir,'prices.json'), JSON.stringify({updatedAt:new Date().toISOString(),storeCount:new Set(all.map(r=>r.store)).size,productCount:all.length,products:all},null,2));
  const bs={}; all.forEach(r=>bs[r.store]=(bs[r.store]||0)+1);
  console.log(`\nWrote data/prices.json — ${all.length} products`); console.log('Per store:',JSON.stringify(bs));
})().catch(e=>{ console.error('FATAL',e); process.exit(1); });
