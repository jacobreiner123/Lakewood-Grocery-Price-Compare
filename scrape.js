const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const MAX_LINKS = +(process.env.MAX_LINKS || 40);
const STORES = [
  { name: 'Seasons', home: 'https://seasonskosher.com/lakewood', linkRe: /(department|category|c\/|categories|aisle)/i },
  { name: 'Gourmet Glatt', home: 'https://www.gourmetglattonline.com/categories', linkRe: /\/categories(\/\d+\/products)?/i },
];
const NAMEK=['name','productName','title','description','displayName','itemName'];
const PRICEK=['price','salePrice','regularPrice','ourPrice','unitPrice','currentPrice','priceValue'];
const SIZEK=['size','unit','uom','packageSize','sizeDescription'];
const SKUK=['sku','id','productId','itemId','upc','code'];
const STOP=new Set(['featured products','specials','weekly specials','new items','meat','dairy','produce','bakery','grocery','frozen','deli','fish','appetizing','health & beauty','household','beverages','snacks','candy','wine & liquor','pharmacy','departments','shop by department','categories','featured','all products','products']);
const pick=(o,ks)=>{for(const k of ks)if(o[k]!=null&&o[k]!=='')return o[k];return null;};
const toPrice=v=>{if(v==null)return null;if(typeof v==='number')return v>0?v:null;const n=parseFloat(String(v).replace(/[^0-9.]/g,''));return isFinite(n)&&n>0?n:null;};
const junk=name=>{const n=name.trim();return n.length<3||STOP.has(n.toLowerCase())||!/[a-z]/.test(n);};
function harvest(node,found,d=0){
  if(!node||d>8)return;
  if(Array.isArray(node)){for(const e of node)harvest(e,found,d+1);return;}
  if(typeof node==='object'){
    const name=pick(node,NAMEK),price=toPrice(pick(node,PRICEK));
    if(name&&price)found.push({name:String(name).trim(),size:(pick(node,SIZEK)||'').toString().trim()||null,price,sku:(pick(node,SKUK)||'').toString().trim()||null});
    for(const k of Object.keys(node))harvest(node[k],found,d+1);
  }
}
function cleanTitle(t){if(!t)return null;let s=String(t).split('|')[0].split('-')[0].trim();if(!s||s.length<2||/^(shop|home|welcome)/i.test(s)||STOP.has(s.toLowerCase()))return null;return s;}
async function crawlStore(browser,cfg){
  const page=await browser.newPage({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'});
  const byKey=new Map(), now=new Date().toISOString();
  let cat=null;
  page.on('response',async resp=>{
    if(!(resp.headers()['content-type']||'').toLowerCase().includes('json'))return;
    let body;try{body=await resp.json();}catch{return;}
    const found=[];harvest(body,found);
    for(const p of found){
      if(junk(p.name))continue;
      const key=(p.name+'|'+(p.size||'')).toLowerCase();
      if(!byKey.has(key))byKey.set(key,{store:cfg.name,name:p.name,size:p.size,price:p.price,sku:p.sku,category:cat,url:resp.url(),scrapedAt:now});
    }
  });
  console.log(`[${cfg.name}] opening ${cfg.home}`);
  try{await page.goto(cfg.home,{waitUntil:'domcontentloaded',timeout:60000});}catch(e){console.log(`[${cfg.name}] home failed: ${e.message.split('\n')[0]}`);await page.close();return[];}
  await page.waitForTimeout(6000);
  let links=[];
  try{const h=await page.$$eval('a[href]',as=>as.map(a=>a.href));links=[...new Set(h)].filter(u=>cfg.linkRe.test(u)).slice(0,MAX_LINKS);}catch(e){console.log(`[${cfg.name}] link scan failed`);}
  console.log(`[${cfg.name}] visiting ${links.length} category links`);
  for(const link of links){
    cat=null;
    try{await page.goto(link,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(3000);try{cat=cleanTitle(await page.title());}catch{}}
    catch(e){console.log(`[${cfg.name}] skip: ${e.message.split('\n')[0]}`);}
  }
  await page.close();
  const recs=[...byKey.values()];
  console.log(`[${cfg.name}] captured ${recs.length} products`);
  return recs;
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  let all=[];
  for(const cfg of STORES){try{all=all.concat(await crawlStore(browser,cfg));}catch(e){console.error(`${cfg.name} failed:`,e.message);}}
  await browser.close();
  const outDir=path.join(__dirname,'data');fs.mkdirSync(outDir,{recursive:true});
  const payload={updatedAt:new Date().toISOString(),storeCount:new Set(all.map(r=>r.store)).size,productCount:all.length,products:all};
  fs.writeFileSync(path.join(outDir,'prices.json'),JSON.stringify(payload,null,2));
  const byStore={};all.forEach(r=>byStore[r.store]=(byStore[r.store]||0)+1);
  console.log(`\nWrote data/prices.json — ${all.length} products`);console.log('Per store:',JSON.stringify(byStore));
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
