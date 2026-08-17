// Cross-store product matching.
//
// Exact string matching only ever paired ~40 of Seasons' 9,000 items with the two
// SelfPoint stores, because the platforms disagree about product naming. Cheap
// heuristics can't close that gap and an LLM alone is too expensive to run over
// 9k x 10k pairs, so this does both: deterministic blocking narrows each product to
// a handful of plausible candidates, then Claude adjudicates only those.
//
//   node match.js propose   # block, then ask Claude ONLY about undecided pairs
//   node match.js collect   # merge the batch results into the decision cache
//   node match.js rebuild   # regenerate matches.json from the cache — no API calls
//
// Decisions are cached in data/match-cache.json and reused forever. Product identity
// doesn't change when a price does, so a re-scrape must re-read prices but must NOT
// re-ask which products are the same thing — that would repay the full matching cost
// on every refresh. Only genuinely new products, or ones whose candidate set changed,
// are sent to the model. Batches cost half of standard rates and aren't latency-sensitive.
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs'), path = require('path');

const MODEL = process.env.MATCH_MODEL || 'claude-opus-5';
const EFFORT = process.env.MATCH_EFFORT || 'medium';
const PER_REQUEST = +(process.env.MATCH_BATCH_SIZE || 15); // products adjudicated per API request
const MAX_CANDIDATES = 6;
const DATA = path.join(__dirname, 'data');

const norm = s => String(s || '').toLowerCase()
  .replace(/[''`]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Size comparison needs a canonical unit — "1 lb" and "16 oz" are the same pack.
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(oz|fl ?oz|lbs?|ct|pk|qt|gal|ml|l|g|kg)$/i;
const sizeKey = s => {
  const m = String(s || '').trim().match(SIZE_RE);
  if (!m) return null;
  let n = parseFloat(m[1]); const u = m[2].toLowerCase().replace(/\s/g, '');
  if (u === 'lb' || u === 'lbs') { n *= 16; return `${n}oz`; }
  if (u === 'kg') { n *= 1000; return `${n}g`; }
  if (u === 'l') { n *= 1000; return `${n}ml`; }
  return `${n}${u === 'floz' ? 'oz' : u}`;
};

// Words too common to signal that two products are the same thing.
const NOISE = new Set(['the','and','with','for','of','in','a','an','fresh','natural','original','classic','premium','style','flavor','flavored','all','new','size','pack','value','family']);
const tokens = s => new Set(norm(s).split(' ').filter(t => t.length > 2 && !NOISE.has(t) && !/^\d/.test(t)));
const overlap = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };

// A product's stable identity across re-scrapes. Deliberately excludes price — the
// whole point is that a price change must not invalidate a cached match decision.
const keyOf = p => `${p.store}|${norm(p.brand)}|${norm(p.name)}|${sizeKey(p.size) || norm(p.size)}`;

const CACHE_FILE = path.join(DATA, 'match-cache.json');
const loadCache = () => {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { version: 1, decisions: {} }; }
};
const saveCache = c => fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));

// A decision is only reusable if the model saw the same options. If a store adds a
// closer candidate, the old answer may no longer be right, so re-ask that one.
const fingerprint = candidates => candidates.map(c => keyOf(c.p ?? c)).sort().join('~');

function load() {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, 'prices.json'), 'utf8'));
  const byStore = {};
  for (const p of d.products) (byStore[p.store] = byStore[p.store] || []).push(p);
  // Collapse a store's duplicate listings to its cheapest, so a match compares one
  // price per product per store rather than an arbitrary listing.
  for (const s of Object.keys(byStore)) {
    const m = new Map();
    for (const p of byStore[s]) {
      const k = `${norm(p.name)}|${norm(p.brand)}|${sizeKey(p.size) || p.size || ''}`;
      if (!m.has(k) || p.price < m.get(k).price) m.set(k, p);
    }
    byStore[s] = [...m.values()];
  }
  return byStore;
}

// Deterministic blocking. Anchor on the store with the richest names (Seasons carries
// brand + size in its own field after the scrape fix) and find plausible counterparts.
function block(byStore) {
  const stores = Object.keys(byStore);
  const anchorStore = 'Seasons';
  const others = stores.filter(s => s !== anchorStore);
  const index = {};
  for (const s of others) {
    index[s] = byStore[s].map(p => ({ p, tok: tokens(`${p.brand || ''} ${p.name}`), size: sizeKey(p.size) }));
  }
  const groups = [];
  for (const a of byStore[anchorStore]) {
    const at = tokens(`${a.brand || ''} ${a.name}`);
    if (at.size < 1) continue;
    const aSize = sizeKey(a.size);
    const cands = [];
    for (const s of others) {
      for (const c of index[s]) {
        // A size mismatch is a hard no when both sides state one — a 16oz and a 48oz
        // bottle of the same oil are different products at different prices.
        if (aSize && c.size && aSize !== c.size) continue;
        const ov = overlap(at, c.tok);
        if (ov >= 0.5) cands.push({ store: s, ov, p: c.p });
      }
    }
    if (!cands.length) continue;
    cands.sort((x, y) => y.ov - x.ov);
    // Keep the best few per store so the model sees real alternatives to reject.
    const perStore = {};
    const kept = [];
    for (const c of cands) {
      perStore[c.store] = (perStore[c.store] || 0) + 1;
      if (perStore[c.store] <= 3) kept.push(c);
      if (kept.length >= MAX_CANDIDATES) break;
    }
    groups.push({ anchor: a, candidates: kept });
  }
  return groups;
}

const fmt = p => `${p.brand ? p.brand + ' — ' : ''}${p.name}${p.size ? ` (${p.size})` : ''}`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The product id given in the prompt' },
          matches: {
            type: 'array',
            description: 'Candidate letters that are the SAME product. Empty if none are.',
            items: { type: 'string' },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'matches', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const SYSTEM = `You match grocery products across stores for a price-comparison tool.

Two listings are the SAME product only if a shopper would consider them interchangeable: same brand (or both unbranded store/fresh items of the same thing), same food item, same pack size. Stores write names differently — "Liebers Avocado Oil, 48 Oz" and "Avocado Oil" from brand Liebers at 48 oz are the same product.

Do NOT match:
- different brands (Gefen mayo is not Liebers mayo)
- different sizes or counts
- different varieties or flavors (whole wheat vs white; garlic vs plain)
- a component and a prepared dish made from it
- fresh/butcher items where one is priced per pound and the other per package

A wrong match silently corrupts a price comparison, so leave matches empty when uncertain. Report low confidence rather than guessing.`;

function buildPrompt(chunk) {
  const lines = chunk.map(({ anchor, candidates }, i) => {
    const cs = candidates.map((c, j) =>
      `    ${String.fromCharCode(65 + j)}. [${c.store}] ${fmt(c.p)} — $${c.p.price.toFixed(2)}`).join('\n');
    return `Product ${i + 1}: [Seasons] ${fmt(anchor)} — $${anchor.price.toFixed(2)}\n  Candidates:\n${cs}`;
  }).join('\n\n');
  return `For each product below, decide which candidates (if any) are the same product.\n\n${lines}\n\nReturn one result per product, using the product number as "id".`;
}

async function propose() {
  const byStore = load();
  console.log('catalogue:', Object.entries(byStore).map(([s, v]) => `${s}=${v.length}`).join(' '));
  const groups = block(byStore);
  console.log(`blocking produced ${groups.length} products with candidates`);
  if (!groups.length) { console.log('nothing to match — has the brand/size re-crawl finished?'); return; }

  // Ask only about products with no usable prior decision. On a steady-state refresh
  // this is normally near zero, which is the point.
  const cache = loadCache();
  let reused = 0, stale = 0;
  const todo = groups.filter(g => {
    const prior = cache.decisions[keyOf(g.anchor)];
    if (!prior) return true;
    if (prior.fingerprint !== fingerprint(g.candidates)) { stale++; return true; }
    reused++; return false;
  });
  console.log(`cache: ${reused} reused, ${stale} re-asked (candidates changed), ${todo.length} to decide`);
  if (!todo.length) { console.log('nothing new to match — run "node match.js rebuild"'); return; }

  const chunks = [];
  for (let i = 0; i < todo.length; i += PER_REQUEST) chunks.push(todo.slice(i, i + PER_REQUEST));

  // --dry stops before spending anything, so the scale of a run can be inspected first.
  if (process.argv.includes('--dry')) {
    console.log(`\nDRY RUN — would submit ${chunks.length} batch requests (${PER_REQUEST} products each)`);
    console.log(`model=${MODEL} effort=${EFFORT}\n\nsample prompt:\n`);
    console.log(buildPrompt(chunks[0].slice(0, 3)));
    return;
  }
  console.log(`submitting ${chunks.length} batch requests (${PER_REQUEST} products each), model=${MODEL} effort=${EFFORT}`);

  const client = new Anthropic();
  const batch = await client.messages.batches.create({
    requests: chunks.map((chunk, i) => ({
      custom_id: `chunk-${i}`,
      params: {
        model: MODEL,
        // Thinking is on by default on Opus 5 and shares this ceiling with the
        // response, so it needs room beyond the JSON itself.
        max_tokens: 8000,
        system: SYSTEM,
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: buildPrompt(chunk) }],
      },
    })),
  });

  fs.writeFileSync(path.join(DATA, 'match-batch.json'), JSON.stringify({
    batchId: batch.id, model: MODEL, effort: EFFORT,
    chunks: chunks.map(c => c.map(g => ({
      anchor: { store: 'Seasons', name: g.anchor.name, brand: g.anchor.brand, size: g.anchor.size },
      anchorKey: keyOf(g.anchor),
      fingerprint: fingerprint(g.candidates),
      candidates: g.candidates.map(c2 => ({ store: c2.store, name: c2.p.name, brand: c2.p.brand, size: c2.p.size, key: keyOf(c2.p) })),
    }))),
  }, null, 2));
  console.log(`batch ${batch.id} submitted — run "node match.js collect" once it ends`);
}

async function collect() {
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'match-batch.json'), 'utf8'));
  const client = new Anthropic();
  const batch = await client.messages.batches.retrieve(state.batchId);
  console.log(`batch ${batch.id}: ${batch.processing_status}`, JSON.stringify(batch.request_counts));
  if (batch.processing_status !== 'ended') { console.log('not finished yet — re-run later'); return; }

  const cache = loadCache();
  let decided = 0, errored = 0;
  for await (const r of await client.messages.batches.results(state.batchId)) {
    if (r.result.type !== 'succeeded') { errored++; continue; }
    const chunk = state.chunks[+r.custom_id.split('-')[1]];
    const block = r.result.message.content.find(b => b.type === 'text');
    let parsed; try { parsed = JSON.parse(block.text); } catch { errored++; continue; }
    for (const res of parsed.results || []) {
      const g = chunk[res.id - 1];
      if (!g) continue;
      // "No match" is a decision worth keeping too — otherwise every refresh pays to
      // re-discover that a product simply isn't carried by the other stores.
      cache.decisions[g.anchorKey] = {
        matchedKeys: (res.matches || []).map(l => g.candidates[l.charCodeAt(0) - 65]?.key).filter(Boolean),
        confidence: res.confidence,
        fingerprint: g.fingerprint,
        model: state.model,
        decidedAt: new Date().toISOString(),
      };
      decided++;
    }
  }
  if (errored) console.log(`WARNING: ${errored} batch requests failed or returned unparseable output`);
  saveCache(cache);
  console.log(`cached ${decided} decisions (${Object.keys(cache.decisions).length} total)`);
  rebuild();
}

// Join cached decisions against current prices. This is what runs after every scrape —
// prices refresh, identity is reused, no model call.
function rebuild() {
  const cache = loadCache();
  const byStore = load();
  const index = new Map();
  for (const list of Object.values(byStore)) for (const p of list) index.set(keyOf(p), p);

  const items = [];
  let dropped = 0;
  for (const [anchorKey, d] of Object.entries(cache.decisions)) {
    if (!d.matchedKeys?.length) continue;
    const anchor = index.get(anchorKey);
    if (!anchor) { dropped++; continue; } // delisted since the decision was made
    const prices = { [anchor.store]: anchor.price };
    for (const k of d.matchedKeys) {
      const p = index.get(k);
      if (!p) continue;
      if (prices[p.store] == null || p.price < prices[p.store]) prices[p.store] = p.price;
    }
    if (Object.keys(prices).length < 2) { dropped++; continue; }
    // Emit the consumed record keys so the web app can group by these verified
    // matches and fall back to its own heuristic only for what's left over.
    const keys = [anchorKey, ...d.matchedKeys.filter(k => index.has(k))];
    items.push({ name: anchor.name, brand: anchor.brand, size: anchor.size, confidence: d.confidence, prices, keys });
  }

  fs.writeFileSync(path.join(DATA, 'matches.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), itemCount: items.length, items,
  }, null, 2));
  const byConf = {}; items.forEach(i => byConf[i.confidence] = (byConf[i.confidence] || 0) + 1);
  console.log(`wrote data/matches.json — ${items.length} matched items`, JSON.stringify(byConf));
  if (dropped) console.log(`${dropped} cached matches skipped (product no longer listed in one of the stores)`);
}

const cmd = process.argv[2];
const run = cmd === 'collect' ? collect()
  : cmd === 'propose' ? propose()
  : cmd === 'rebuild' ? Promise.resolve().then(rebuild)
  : Promise.reject(new Error('usage: node match.js propose|collect|rebuild'));
run.catch(e => { console.error('FATAL', e.message); process.exit(1); });
