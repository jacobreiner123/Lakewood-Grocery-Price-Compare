/**
 * scrape.js — runner. Runs every store scraper, merges results, and writes
 * data/prices.json (which the web app reads).
 *
 * Add more stores by dropping another scraper in scrapers/ and importing it
 * into the STORES array below.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { scrapeSeasons } = require('./scrapers/seasons');

const STORES = [
  scrapeSeasons,
  // scrapeGourmetGlatt,   <- add here as we build each one
  // scrapeEvergreen,
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let all = [];
  for (const run of STORES) {
    try {
      const recs = await run(browser);
      all = all.concat(recs);
    } catch (e) {
      console.error('scraper failed:', e.message);
    }
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
  if (all.length) all.slice(0, 8).forEach(r => console.log(`  ${r.store}  $${r.price.toFixed(2)}  ${r.name}`));
  else { console.log('No products captured — check the scraper logs above.'); process.exitCode = 0; }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
