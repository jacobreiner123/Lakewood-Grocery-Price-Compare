const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MAX_PAGES   = parseInt(process.env.MAX_PAGES   || '80', 10);
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '6', 10);

const STORES = [
  {
    name: 'Seasons',
    home: 'https://seasonskosher.com/lakewood',
    linkRe: /(department|category|c\/|categories|aisle)/i,
  },
  {
    name: 'Gourmet Glatt',
    home: 'https://www.gourmetglattonline.com/categories',
    linkRe: /\/categories(\/\d+\/products)?/i,
  },
];

const NAME_KEYS  = ['name','productName','title','description','displayName','itemName'];
const PRICE_KEYS = ['price','salePrice','regularPrice','ourPrice','unitPrice','currentPrice','priceValue'];
const SIZE_KEYS  = ['size','unit','uom','packageSize','sizeDescription'];
const SKU_KEYS   = ['sku','id','productId','itemId','upc','code'];

const STOPWORDS = new Set(['featured products','specials','weekly specials','new items',
  'meat','dairy','produce','bakery','grocery','frozen','deli','fish','appetizing',
  'health & beauty','household','beverages','snacks','candy','wine & liquor','pharmacy',
  'departments','shop by department','categories','featured','all products','products']);

const pick = (o, ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const toPrice = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
};
function isJunkName(name) {
  const n = name.trim();
  if (n.length < 3) return true;
  if (STOPWORDS.has(n.toLowerCase())) return true;
  if (!/[a-z]/.test(n)) return true;
  return false;
}
function harvest(node, found, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const el of node) harvest(el, found, depth + 1); return; }
  if (typeof node === 'object') {
    const name = pick(node, NAME_KEYS);
    const price = toPrice(pick(node, PRICE_KEYS));
    if (name && price) found.push({
      name: String(name).trim(),
      size: (pick(node, SIZE_KEYS) || '').toString().trim() || null,
      price,
      sku: (pick(node, SKU_KEYS) || '').toString().trim() || null,
    });
    for (const k of Object.keys(node)) harvest(node[k], found, depth + 1);
  }
}
function cleanTitle(t) {
  if (!t) return null;
  let s = String(t).split('|')[0].split('-')[0].trim();
  if (!s || s.length < 2) return null;
  if (/^(shop|home|welcome)/i.test(s)) return null;
  if (STOPWORDS.has(s.toLowerCase())) return null;
  return s;
}
async function collectLinks(page, linkRe) {
  try {
    const hrefs = await page.$$eval('a[href]', as => as.map(a => a.href));
    return [...new Set(hrefs.filter(h => linkRe.test(h)))];
  } catch { return []; }
}

async function crawlStore(browser, cfg) {
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const byKey = new Map();
  const now = new Date().toISOString();
  let currentCategory = null;

  page.on('response', async (resp) => {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    let body; try { body = await resp.json(); } catch { return; }
    const found = []; harvest(body, found);
    for (const p of found) {
      if (isJunkName(p.name)) continue;
      const key = (p.name + '|' + (p.size || '')).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, {
        store: cfg.name, name: p.name, size: p.size, price: p.price, sku: p.sku,
        category: currentCategory, url: resp.url(), scrapedAt: now,
      });
    }
  });

  console.log(`[${cfg.name}] opening`, cfg.home);
  try { await page.goto(cfg.home, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log(`[${cfg.name}] home failed: ${e.message.split('\n')[0]}`); await page.close(); return []; }
  await page.waitForTimeout(6000);

  const queue = await collectLinks(page, cfg.linkRe);
  console.log(`[${cfg.name}] ${queue.length} links from start page`);
  const visited = new Set([cfg.home]);

  while (queue.length && visited.size <= MAX_PAGES) {
    const link = queue.shift();
    if (visited.has(link)) continue;
    visited.add(link);
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      currentCategory = cleanTitle(await page.title());
      let stagnant = 0;
      for (let i = 0; i < MAX_SCROLLS && stagnant < 2; i++) {
        const before = byKey.size;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1400);
        if (byKey.size === before) stagnant++; else stagnant = 0;
      }
      if (visited.size < MAX_PAGES) {
        for (const l of await collectLinks(page, cfg.linkRe)) {
          if (!visited.has(l) && !queue.includes(l)) queue.push(l);
        }
      }
      console.log(`[${cfg.name}] ${currentCategory || link} -> total ${byKey.size} (queue ${queue.length})`);
    } catch (e) {
      console.log(`[${cfg.name}] skip: ${e.message.split('\n')[0]}`);
    }
  }

  await page.close();
  const records = [...byKey.values()];
  console.log(`[${cfg.name}] captured ${records.length} products from ${visited.size - 1} pages`);
  return records;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let all = [];
  for (const cfg of STORES) {
    try { all = all.concat(await crawlStore(browser, cfg)); }
    catch (e) { console.error(`${cfg.name} crawl failed:`, e.message); }
  }
  await browser.close();

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    storeCount: new Set(all.map(r => r.store)).size,
    productCount: all.length,
    products: all,
  };
  fs.writeFileSync(path.join(outDir, 'prices.json'), JSON.stringify(payload, null, 2));
  console.log(`\nWrote data/prices.json — ${all.length} products across ${payload.storeCount} store(s).`);
  const byStore = {};
  all.forEach(r => { byStore[r.store] = (byStore[r.store] || 0) + 1; });
  console.log('Per store:', JSON.stringify(byStore));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
