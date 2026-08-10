const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SEASONS_HOME = 'https://seasonskosher.com/lakewood';
const MAX_CATEGORIES = parseInt(process.env.MAX_CATEGORIES || '60', 10);
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '12', 10);

const NAME_KEYS  = ['name','productName','title','description','displayName','itemName'];
const PRICE_KEYS = ['price','salePrice','regularPrice','ourPrice','unitPrice','currentPrice','priceValue'];
const SIZE_KEYS  = ['size','unit','uom','packageSize','sizeDescription'];
const SKU_KEYS   = ['sku','id','productId','itemId','upc','code'];

const STOPWORDS = new Set(['featured products','specials','weekly specials','new items',
  'meat','dairy','produce','bakery','grocery','frozen','deli','fish','appetizing',
  'health & beauty','household','beverages','snacks','candy','wine & liquor','pharmacy',
  'departments','shop by department','categories','featured']);

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
function catFromUrl(u) {
  const m = String(u).match(/\/category\/\d+\/([^/?#]+)/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function scrapeSeasons(browser) {
  const STORE = 'Seasons';
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
        store: STORE, name: p.name, size: p.size, price: p.price, sku: p.sku,
        category: currentCategory || catFromUrl(resp.url()), url: resp.url(), scrapedAt: now,
      });
    }
  });

  console.log(`[${STORE}] opening home`, SEASONS_HOME);
  await page.goto(SEASONS_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  let catLinks = [];
  try {
    catLinks = await page.$$eval('a[href*="/category/"]', as => as.map(a => a.href));
  } catch {}
  catLinks = [...new Set(catLinks)];
  const seenIds = new Set();
  catLinks = catLinks.filter(u => {
    const m = u.match(/\/category\/(\d+)/);
    if (!m || seenIds.has(m[1])) return false;
    seenIds.add(m[1]); return true;
  }).slice(0, MAX_CATEGORIES);
  console.log(`[${STORE}] found ${catLinks.length} categories`);

  for (const link of catLinks) {
    currentCategory = catFromUrl(link);
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      let stagnant = 0;
      for (let i = 0; i < MAX_SCROLLS && stagnant < 2; i++) {
        const before = byKey.size;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1400);
        if (byKey.size === before) stagnant++; else stagnant = 0;
      }
      console.log(`[${STORE}] ${currentCategory || link}: total so far ${byKey.size}`);
    } catch (e) {
      console.log(`[${STORE}] skip ${currentCategory || link}: ${e.message.split('\n')[0]}`);
    }
  }

  await page.close();
  const records = [...byKey.values()];
  console.log(`[${STORE}] captured ${records.length} products`);
  return records;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let all = [];
  try { all = all.concat(await scrapeSeasons(browser)); }
  catch (e) { console.error('Seasons scraper failed:', e.message); }
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
  all.slice(0, 10).forEach(r => console.log(`  ${r.store}  $${r.price.toFixed(2)}  ${r.name}`));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
