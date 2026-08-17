const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const MAX_PAGES = +(process.env.MAX_PAGES || 400), MAX_SCROLLS = +(process.env.MAX_SCROLLS || 12);
// ONLY="Seasons" or ONLY="Gourmet Glatt,NPGS" to crawl a subset. Stores left out keep
// their existing records via the carry-forward at the end, so a subset run never
// publishes an empty store.
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()).filter(Boolean) : null;

// ---------------------------------------------------------------------------
// Extraction. Prices are always read off the RENDERED DOM — never from a product
// JSON endpoint. (Category *discovery* may use a site's own nav API; that's link
// finding, not price reading, and the distinction matters: the DOM stays the
// source of truth for every price we record.)
//
// Both platforms render a site-wide "featured products" carousel on top of the
// real grid. Including it made every category return the same ~24 items, which is
// why earlier runs produced one repeated set of products no matter the category.
// Carousel nodes are excluded by subtree, then the grid is read.
// ---------------------------------------------------------------------------
// NOTE: match the featured strip's own container exactly. A loose [class*="carousel"]
// excludes everything — Seasons wraps each individual card in its own .item-carousel div,
// so the greedy selector zeroed out the whole grid.
// Brand and size are captured as their own fields, not left inside the name. The two
// platforms disagree about where that information lives: Seasons bakes it into the name
// ("Liebers Avocado Oil, 48 Oz") while SelfPoint keeps .brand and .weight as separate
// elements and leaves the name bare ("Avocado Oil"). Storing them apart is what makes
// the same product comparable across stores — without it there is nothing to match on.
const extractGrid = (page, cardSel, carouselSel, brandSel, sizeSel) => page.evaluate(({ cardSel, carouselSel, brandSel, sizeSel }) => {
  const clean = t => (t || '').replace(/[|\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const SIZE_RE = /(\d+(?:\.\d+)?)\s*(oz|fl\s?oz|lbs?|ct|pk|qt|gal|ml|l|g|kg|inch|in)\b\.?/i;
  const inCarousel = new Set();
  for (const c of document.querySelectorAll(carouselSel))
    for (const el of c.querySelectorAll(cardSel)) inCarousel.add(el);
  const out = [], seen = new Set();
  for (const el of document.querySelectorAll(cardSel)) {
    if (inCarousel.has(el)) continue;
    const txt = (el.innerText || '').trim();
    const pm = txt.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
    if (!pm) continue;
    const price = parseFloat(pm[1]);
    if (!(price > 0)) continue;
    let name = '';
    const ne = el.querySelector('[class*="name"],[class*="title"],[class*="desc"],h2,h3,h4,h5');
    if (ne) name = (ne.innerText || '').trim();
    if (!name) { const im = el.querySelector('img[alt]'); if (im) name = (im.getAttribute('alt') || '').trim(); }
    if (!name) { const l = txt.split('\n').map(s => s.trim()).find(s => s && !/^\$?\d/.test(s)); if (l) name = l; }
    name = name.replace(/\$\s?\d+(?:\.\d{1,2})?/g, '').replace(/\s+/g, ' ').trim();
    if (name.length < 3) continue;

    let brand = brandSel ? clean((el.querySelector(brandSel) || {}).innerText) : null;
    let size = sizeSel ? clean((el.querySelector(sizeSel) || {}).innerText) : null;

    // Seasons has no brand/size elements: the name is "Brand Product, Size". Split the
    // trailing size off so the name is comparable to SelfPoint's bare product name.
    if (!size) {
      const tail = name.match(/,\s*([^,]*\d[^,]*)$/);
      if (tail && SIZE_RE.test(tail[1])) { size = clean(tail[1]); name = name.slice(0, tail.index).trim(); }
      else { const m = name.match(SIZE_RE); if (m) size = clean(m[0]); }
    }
    if (size) { const m = size.match(SIZE_RE); size = m ? `${m[1]} ${m[2].toLowerCase().replace(/\s+/g, '')}` : null; }

    const key = name.toLowerCase() + '|' + (brand || '').toLowerCase() + '|' + (size || '') + '|' + price;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, brand: brand || null, size: size || null, price });
  }
  return out;
}, { cardSel, carouselSel, brandSel, sizeSel });

const STOP = new Set(['featured products','specials','weekly specials','new items','meat','dairy','produce','bakery','grocery','frozen','deli','fish','appetizing','health & beauty','household','beverages','snacks','candy','wine & liquor','pharmacy','departments','shop by department','categories','featured','all products','products','view all','see all','shop now','add to cart','out of stock']);
const junk = s => { const n=(s||'').trim(); return n.length<3||n.length>90||STOP.has(n.toLowerCase())||!/[a-z]/.test(n)||/^\$?\d/.test(n); };
const slug = s => String(s||'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'c';

// ---------------------------------------------------------------------------
// Store configs
// ---------------------------------------------------------------------------
const STORES = [
  {
    name: 'Seasons',
    enabled: true,
    home: 'https://seasonskosher.com/lakewood',
    cardSel: '.product-item',
    carouselSel: '.product-list-content-carousel',
    // Top-level category pages are landing pages: subcategory tiles plus the featured
    // carousel, no product grid of their own. Their subcategory links aren't anchors,
    // so an a[href] crawl never reached the leaves where products actually live.
    // The site's own nav endpoint enumerates the whole tree instead.
    async categories(page) {
      const nodes = await page.evaluate(async () => {
        const r = await fetch('/api/AjaxFilter/GetCategoryTreeJSON?filterMode=00000000', { credentials: 'include' });
        if (!r.ok) return [];
        const j = await r.json();
        const out = [];
        const walk = ns => { for (const n of ns || []) { if (n && n.Id) out.push({ id: n.Id, name: n.N }); if (n && Array.isArray(n.List)) walk(n.List); } };
        walk(Array.isArray(j) ? j : []);
        return out;
      });
      // Lakewood only — seasonskosher also serves Lawrence and Queens, and the old
      // crawl mixed those markets' prices into the data.
      return nodes.map(n => ({ url: `https://seasonskosher.com/Lakewood/category/${n.id}/${slug(n.name)}`, name: n.name }));
    },
  },
  {
    name: 'Gourmet Glatt',
    enabled: true,
    home: 'https://www.gourmetglattonline.com/',
    // SelfPoint's real card is .product-item (wraps an <sp-product>). The old catch-all
    // [class*="item"],[class*="card"]... also matched the language switcher and the
    // category header, which then picked up a neighbouring price — "Eng :: $4.99".
    cardSel: '.product-item',
    carouselSel: '.sp-carousel',
    brandSel: '.brand',
    sizeSel: '.weight',
    // SelfPoint sits behind Cloudflare. Playwright's bundled chromium-headless-shell is
    // fingerprinted and gets an endless interstitial; real Chrome clears it in seconds.
    channel: 'chrome',
    headed: true,
    profileDir: process.env.GG_PROFILE || path.join(__dirname, '.gg-profile'),
    // The shop defaults to the Cedarhurst branch. These are the cookies the site's own
    // store picker sets for Lakewood North (1700 Madison Ave) — without them every
    // price collected is Five Towns pricing, not Lakewood.
    cookies: [
      { name: 'store', value: 'gourmet-glatt-north', domain: '.gourmetglattonline.com', path: '/' },
      { name: 'retailerId', value: '1116', domain: '.gourmetglattonline.com', path: '/' },
    ],
    expectLocation: /Gourmet Glatt Lakewood/i,
    async categories(page) {
      const hrefs = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.href))]);
      return hrefs.filter(u => /\/categories\/\d+/i.test(u)).map(u => ({ url: u, name: null }));
    },
  },
  {
    // Same SelfPoint platform and same Cloudflare gate as Gourmet Glatt, so the same
    // real-Chrome setup applies. Both NPGS locations (Main St and South Lake) are in
    // Lakewood, so unlike the other two there's no wrong-market risk to guard against.
    name: 'NPGS',
    enabled: true,
    home: 'https://www.gonpgs.com/',
    cardSel: '.product-item',
    carouselSel: '.sp-carousel',
    brandSel: '.brand',
    sizeSel: '.weight',
    channel: 'chrome',
    headed: true,
    profileDir: process.env.NPGS_PROFILE || path.join(__dirname, '.npgs-profile'),
    async categories(page) {
      const hrefs = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.href))]);
      return hrefs.filter(u => /\/categories\/\d+/i.test(u)).map(u => ({ url: u, name: null }));
    },
  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Only spoof the UA on the bundled Chromium. When running real Chrome (channel:'chrome')
// a hardcoded UA contradicts the browser's actual JS/TLS fingerprint, which is precisely
// what a bot check scores against — leaving the native UA alone is what gets through.
const ctxOpts = cfg => ({
  viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York',
  ...(cfg.channel ? {} : { userAgent: UA }),
});

// A persistent profile keeps the bot-check clearance and the selected-store cookies
// between runs; a throwaway context gets re-challenged on every launch.
async function openContext(cfg) {
  if (cfg.profileDir) {
    const ctx = await chromium.launchPersistentContext(cfg.profileDir, {
      ...ctxOpts(cfg), headless: !cfg.headed,
      ...(cfg.channel ? { channel: cfg.channel } : {}),
      args: ['--disable-blink-features=AutomationControlled'],
    });
    return { ctx, close: () => ctx.close() };
  }
  const browser = await chromium.launch({
    headless: !cfg.headed,
    ...(cfg.channel ? { channel: cfg.channel } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext(ctxOpts(cfg));
  return { ctx, close: async () => { await ctx.close().catch(() => {}); await browser.close().catch(() => {}); } };
}

async function crawlStore(handle, cfg) {
  const ctx = handle.ctx;
  if (cfg.cookies) await ctx.addCookies(cfg.cookies).catch(() => {});
  const page = ctx.pages()[0] || await ctx.newPage();
  const byKey = new Map(), now = new Date().toISOString();
  let cat = null;
  const add = (it) => {
    if (junk(it.name)) return;
    const k = it.name.toLowerCase() + '|' + (it.brand || '').toLowerCase() + '|' + (it.size || '') + '|' + it.price;
    if (!byKey.has(k)) byKey.set(k, {
      store: cfg.name, name: it.name, brand: it.brand || null, size: it.size || null,
      price: it.price, category: cat, scrapedAt: now,
    });
  };

  // Wait past any bot interstitial, then past hydration, then scroll for lazy loads.
  // Cloudflare uses several wordings for the same gate; missing one makes settle()
  // report "clear" while the challenge page is still up.
  async function settle() {
    for (let i = 0; i < 20; i++) {
      const s = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return {
          len: t.trim().length,
          challenged: /Just a moment|Verifying you are human|Performing security verification|security service to protect|you have been blocked|Attention Required/i.test(t),
        };
      }).catch(() => ({ len: 0, challenged: true }));
      // An empty body means the challenge cleared but the app hasn't rendered yet —
      // treating that as "settled" is what made the store-location check read null.
      if (!s.challenged && s.len > 200) return true;
      await page.waitForTimeout(2500);
    }
    return false;
  }
  async function loadAndExtract() {
    if (!await settle()) { console.log(`[${cfg.name}] blocked by bot check, skipping page`); return; }
    // These pages hydrate well after domcontentloaded; extracting on a fixed delay
    // returned nothing and tripped the stagnation counter before products rendered.
    try {
      await page.waitForFunction(sel => {
        for (const el of document.querySelectorAll(sel)) if (/\$\s?\d/.test(el.innerText || '')) return true;
        return false;
      }, cfg.cardSel, { timeout: 20000 });
    } catch { return; } // genuinely empty category
    let stag = 0, lastCount = -1;
    for (let i = 0; i < MAX_SCROLLS && stag < 2; i++) {
      const items = await extractGrid(page, cfg.cardSel, cfg.carouselSel, cfg.brandSel, cfg.sizeSel).catch(() => []);
      for (const it of items) add(it);
      // Per-page stagnation. Measured against the global set it also stopped early on
      // any category whose items had all been seen on an earlier page.
      if (items.length === lastCount) stag++; else stag = 0;
      lastCount = items.length;
      try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
      await page.waitForTimeout(1500);
    }
  }

  console.log(`[${cfg.name}] opening ${cfg.home}`);
  try { await page.goto(cfg.home, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
  catch (e) { console.log(`[${cfg.name}] home failed: ${e.message.split('\n')[0]}`); return []; }
  if (!await settle()) console.log(`[${cfg.name}] WARNING: bot check did not clear on the home page`);
  await page.waitForTimeout(8000);

  // Fail loud if a store-scoped session landed on the wrong branch — silently
  // publishing another market's prices is worse than publishing nothing.
  if (cfg.expectLocation) {
    const shown = await page.evaluate(() => { const m = (document.body.innerText || '').match(/Gourmet Glatt [A-Za-z ]+/); return m ? m[0].trim() : null; });
    if (!cfg.expectLocation.test(shown || '')) {
      console.log(`[${cfg.name}] ABORT: expected ${cfg.expectLocation} but session shows "${shown}"`);
      const head = await page.evaluate(() => (document.body.innerText || '').trim().slice(0, 200)).catch(() => '');
      console.log(`[${cfg.name}] page said: ${head.replace(/\n/g, ' | ')}`);
      return [];
    }
    console.log(`[${cfg.name}] store location confirmed: ${shown}`);
  }

  let cats = [];
  try { cats = await cfg.categories(page); } catch (e) { console.log(`[${cfg.name}] category discovery failed: ${e.message.split('\n')[0]}`); }
  console.log(`[${cfg.name}] ${cats.length} categories discovered`);

  let visited = 0;
  for (const c of cats.slice(0, MAX_PAGES)) {
    visited++;
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      cat = c.name || null;
      await loadAndExtract();
    } catch (e) { console.log(`[${cfg.name}] skip ${c.url}: ${e.message.split('\n')[0]}`); }
    if (visited % 25 === 0) console.log(`[${cfg.name}] ${visited}/${Math.min(cats.length, MAX_PAGES)} pages, ${byKey.size} products`);
  }
  const recs = [...byKey.values()];
  console.log(`[${cfg.name}] captured ${recs.length} products from ${visited} category pages`);
  if (cats.length > MAX_PAGES) console.log(`[${cfg.name}] NOTE: ${cats.length - MAX_PAGES} categories skipped by MAX_PAGES=${MAX_PAGES}`);
  return recs;
}

// The previous run's data, read ONCE before anything is written. Checkpoints overwrite
// prices.json mid-run, so re-reading it later would carry forward this run's own
// partial output instead of the last complete one.
let PREV = null;

// Carry forward the previous run's records for any store that produced nothing this
// time. A store can fail for reasons unrelated to its data being stale — the scheduled
// Action runs from datacenter IPs that a bot check is far likelier to challenge than a
// home connection — and a failed store must not silently erase prices already published
// for it. Also covers ONLY= runs and mid-run checkpoints, which touch a subset by design.
function writeOut(all, outFile, { checkpoint }) {
  let out = all;
  if (PREV && Array.isArray(PREV.products)) {
    const got = new Set(all.map(r => r.store));
    const carried = PREV.products.filter(r => !got.has(r.store));
    if (!checkpoint) {
      const tally = {}; carried.forEach(r => tally[r.store] = (tally[r.store] || 0) + 1);
      for (const [s, n] of Object.entries(tally))
        console.log(`WARNING: ${s} returned 0 products this run — carrying forward ${n} records from ${PREV.updatedAt}`);
    }
    out = all.concat(carried);
  }
  fs.writeFileSync(outFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    storeCount: new Set(out.map(r => r.store)).size,
    productCount: out.length,
    products: out,
  }, null, 2));
  const bs = {}; out.forEach(r => bs[r.store] = (bs[r.store] || 0) + 1);
  if (checkpoint) console.log(`  [checkpoint] data/prices.json — ${out.length} products ${JSON.stringify(bs)}`);
  else { console.log(`\nWrote data/prices.json — ${out.length} products`); console.log('Per store:', JSON.stringify(bs)); }
}

(async () => {
  const outDir = path.join(__dirname, 'data'); fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'prices.json');
  try { PREV = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}

  let all = [];
  for (const cfg of STORES) {
    if (cfg.enabled === false) { console.log(`[${cfg.name}] skipped (disabled)`); continue; }
    if (ONLY && !ONLY.includes(cfg.name)) continue;
    let handle;
    try {
      handle = await openContext(cfg);
      all = all.concat(await crawlStore(handle, cfg));
    } catch (e) { console.error(`${cfg.name} failed:`, e.message.split('\n')[0]); }
    finally { if (handle) await handle.close().catch(() => {}); }
    // Checkpoint after every store. A full pass is hours long; writing only at the
    // end meant a crash or a bot-check lockout late in the run discarded every
    // store that had already succeeded.
    writeOut(all, outFile, { checkpoint: true });
  }

  writeOut(all, outFile, { checkpoint: false });
})().catch(e => { console.error('FATAL', e); process.exit(1); });
