const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SEASONS_URL = 'https://seasonskosher.com/lakewood';
const MAX_CATEGORIES = parseInt(process.env.MAX_CATEGORIES || '12', 10);

const NAME_KEYS  = ['name','productName','title','description','displayName','itemName'];
const PRICE_KEYS = ['price','salePrice','regularPrice','ourPrice','unitPrice','currentPrice','priceValue'];
const SIZE_KEYS  = ['size','unit','uom','packageSize','sizeDescription'];
const SKU_KEYS   = ['sku','id','productId','itemId','upc','code'];

const pick = (o, ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const toPrice = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
};
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

async function scrapeSeasons(browser) {
  const STORE = 'Seasons';
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const byKey = new Map();
  const now = new Date().toISOString();

  page.on('response', async (resp) => {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    let body; try { body = await resp.json(); } catch { return; }
    const found = []; harvest(body, found);
    for (const p of found) {
      const key = (p.name + '|' + (p.size || '')).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { store: STORE, ...p, url: resp.url(), scrapedAt: now });
    }
  });

  console.log(`[${STORE}] opening`, SEASONS_URL);
  await page.goto(SEASONS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  let catLinks = [];
  try {
    catLinks = await page.$$eval('a[href]', as => as.map(a => a.href)
      .filter(h => /\/(department|category|c\/|categories|aisle)/i.test(h)));
  } catch {}
  catLinks = [...new Set(catLinks)].slice(0, MAX_CATEGORIES);
  console.log(`[${STORE}] walking ${catLinks.length} categories`);
  for (const link of catLinks) {
    try { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(3000); }
    catch (e) { console.log(`[${STORE}] skip: ${e.message.split('\n')[0]}`); }
  }

  if (byKey.size < 5) {
    console.log(`[${STORE}] feed thin, trying DOM fallback`);
    try {
      const domItems = await page.$$eval('[class*="product"],[class*="item"]', els => {
        const out = [];
        for (const el of els) {
          const pm = (el.innerText || '').match(/\$\s?(\d+(?:\.\d{2})?)/);
          const nameEl = el.querySelector('[class*="name"],[class*="title"],h2,h3,h4');
          if (pm && nameEl && nameEl.innerText.trim()) out.push({ name: nameEl.innerText.trim(), price: parseFloat(pm[1]) });
        }
        return out;
      });
      for (const p of domItems) {
        const key = (p.name + '|').toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { store: STORE, name: p.name, size: null, price: p.price, sku: null, url: page.url(), scrapedAt: now });
      }
    } catch (e) { console.log(`[${STORE}] DOM fallback failed: ${e.message.split('\n')[0]}`); }
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
  all.slice(0, 8).forEach(r => console.log(`  ${r.store}  $${r.price.toFixed(2)}  ${r.name}`));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
