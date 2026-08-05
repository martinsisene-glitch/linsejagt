'use strict';

/**
 * Linsejagt build.
 *
 *   node scripts/build.js                  live fetch from Tradera + DBA
 *   node scripts/build.js --fixtures       offline: read fixtures/, no network at all
 *   node scripts/build.js --explain        print why every listing was kept or dropped
 *   node scripts/build.js --probe          save raw source responses into fixtures/
 *   node scripts/build.js --only=tradera   run a single source
 *
 * Writes site/ (published to Pages) and updates data/state.json (committed, so
 * "first seen" timestamps survive between runs).
 */

const fs = require('fs');
const path = require('path');

const { classify } = require('./match');
const { score, compareDeals } = require('./score');
const { getSekToDkk } = require('./fx');
const { render } = require('./render');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'lenses.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const FIXTURES = path.join(ROOT, 'fixtures');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'site');

const STATE_TTL_DAYS = 30;

const SOURCES = {
  tradera: require('./sources/tradera'),
  dba: require('./sources/dba'),
};

// ─── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opts = {
  offline: argv.includes('--fixtures'),
  explain: argv.includes('--explain'),
  probe: argv.includes('--probe'),
  only: (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null,
};

main().catch((err) => {
  console.error(`\nBuild fejlede: ${err.stack || err.message}`);
  process.exit(1);
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const generatedAt = new Date().toISOString();
  const catalog = readJson(CATALOG);
  const state = fs.existsSync(STATE) ? readJson(STATE) : { fx: null, listings: {} };

  console.log(`Linsejagt — ${opts.offline ? 'OFFLINE (fixtures)' : 'live'} · ${catalog.lenses.length} objektiver i kataloget\n`);

  // 1. Currency
  const fx = await getSekToDkk({
    cache: state.fx,
    fallback: catalog.settings.fallbackSekToDkk,
    offline: opts.offline,
  });
  catalog.settings._sekToDkk = fx.rate;
  console.log(`Valuta: 1 SEK = ${fx.rate} DKK (${fx.source})\n`);

  // 2. Collect raw listings
  const names = Object.keys(SOURCES).filter((n) => !opts.only || opts.only === n);
  const raw = [];
  const sourceReports = {};

  for (const name of names) {
    const result = opts.offline ? loadFixture(name) : await fetchSource(name, catalog);
    raw.push(...result.listings);
    sourceReports[name] = result.report;
    const r = result.report;
    console.log(
      `${pad(name)} ${r.fetched} annoncer` +
        (r.calls ? ` · ${r.calls} kald` : '') +
        (r.strategy ? ` · via ${r.strategy}` : '') +
        (r.error ? `\n${pad('')} ! ${r.error}` : '')
    );
  }
  console.log();

  // 3. Classify and score
  const deals = [];
  const drops = [];

  for (const listing of raw) {
    const match = classify(listing, catalog);
    if (match.rejected) {
      drops.push({ listing, reason: match.reason, code: match.rejectCode });
      continue;
    }

    const priced = score(listing, match.lens, catalog.settings);
    if (priced.rejected) {
      drops.push({ listing, reason: priced.reason, code: priced.rejectCode, lens: match.lens });
      continue;
    }

    deals.push({
      ...listing,
      ...priced,
      key: listing.id,
      lens: match.lens,
      confidence: match.confidence,
      flags: match.flags,
      matchReason: match.reason,
      firstSeen: null, // stamped below
    });
  }

  // 4. Stamp first-seen from committed state, so "NEW" survives between runs
  const nowIso = generatedAt;
  // Only cache a rate we actually fetched. Persisting the hardcoded fallback with
  // a fresh timestamp would make the NEXT run treat it as a valid 12-hour cache
  // and never ask the ECB again — a made-up rate that quietly becomes permanent.
  const nextState = {
    fx: fx.fetchedAt ? { rate: fx.rate, fetchedAt: fx.fetchedAt } : state.fx || null,
    listings: {},
  };
  const cutoff = Date.now() - STATE_TTL_DAYS * 86400000;
  let freshCount = 0;

  for (const d of deals) {
    const prior = state.listings?.[d.key];
    d.firstSeen = prior?.firstSeen || nowIso;
    if (!prior) freshCount++;
    nextState.listings[d.key] = { firstSeen: d.firstSeen, lastSeen: nowIso };
  }

  // Keep recently-gone listings around briefly: an item that drops off one run
  // and comes back should not be announced as new twice.
  for (const [key, entry] of Object.entries(state.listings || {})) {
    if (nextState.listings[key]) continue;
    if (Date.parse(entry.lastSeen || entry.firstSeen) >= cutoff) nextState.listings[key] = entry;
  }

  deals.sort(compareDeals);

  // 5. Report
  const kept = tally(deals, (d) => d.source);
  for (const name of names) sourceReports[name].kept = kept[name] || 0;

  console.log(`${deals.length} annoncer beholdt, ${drops.length} sorteret fra:`);
  for (const [code, n] of Object.entries(tally(drops, (d) => d.code || 'ukendt')).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${code}`);
  }
  console.log();

  if (opts.explain) explain(deals, drops);

  // 6. Write
  const out = render({ outDir: OUT, webDir: WEB, deals, catalog, fx, sourceReports, generatedAt });
  fs.writeFileSync(STATE, JSON.stringify(nextState, null, 1), 'utf8');

  console.log(`Skrevet: site/index.html, site/data.json (${(out.dataBytes / 1024).toFixed(1)} kB), site/feed.xml (${out.feedItems} poster)`);
  console.log(`State:   data/state.json (${Object.keys(nextState.listings).length} kendte annoncer, ${freshCount} nye i denne kørsel)`);

  // A source that silently returns nothing is the main long-term failure mode
  // here, so make it loud and make it fail CI.
  const dead = names.filter((n) => !sourceReports[n].ok);
  if (dead.length && !opts.offline) {
    console.error(`\nFEJL: ingen brugbare annoncer fra: ${dead.join(', ')}`);
    console.error('Siden er stadig bygget, men den er ufuldstændig. Se fejlen ovenfor.');
    process.exitCode = 1;
  }
}

// ─── Sources ─────────────────────────────────────────────────────────────────

async function fetchSource(name, catalog) {
  try {
    return await SOURCES[name].fetchListings({
      settings: catalog.settings,
      credentials: { appId: process.env.TRADERA_APP_ID, appKey: process.env.TRADERA_APP_KEY },
      probeDir: opts.probe ? FIXTURES : null,
    });
  } catch (err) {
    return { listings: [], report: { ok: false, fetched: 0, calls: 0, error: err.message } };
  }
}

/**
 * Fixtures hold already-normalized listings (raw captures come later, from the
 * first successful Actions run). `endsInHours` is resolved at load time so the
 * countdowns in a fixture build are always plausible.
 */
function loadFixture(name) {
  const file = path.join(FIXTURES, `${name}.json`);
  if (!fs.existsSync(file)) {
    return { listings: [], report: { ok: false, fetched: 0, error: `fixtures/${name}.json mangler` } };
  }
  const listings = readJson(file).listings.map((l) => {
    const { endsInHours, ...rest } = l;
    return {
      ...rest,
      id: `${name}:${l.id}`,
      source: name,
      endDate: endsInHours != null ? new Date(Date.now() + endsInHours * 3600000).toISOString() : null,
    };
  });
  return { listings, report: { ok: true, fetched: listings.length, calls: 0, strategy: 'fixture' } };
}

// ─── Explain ─────────────────────────────────────────────────────────────────

function explain(deals, drops) {
  console.log('─── BEHOLDT ─────────────────────────────────────────────────────────');
  for (const d of deals) {
    console.log(`  ${pct(d.vsNew).padStart(5)}  ${d.lens.name}`);
    console.log(`         "${trunc(d.title, 74)}"`);
    console.log(
      `         ${d.landedDKK} kr landet (${d.priceDKK} + ${d.shippingDKK} fragt) · ny ${d.lens.newPriceDKK} kr` +
        (d.vsUsed != null ? ` · ${pct(d.vsUsed)} vs brugt` : '')
    );
    console.log(`         match: ${d.matchReason}${d.flags.length ? ` · flag: ${d.flags.join(', ')}` : ''}`);
  }

  console.log('\n─── FRASORTERET ─────────────────────────────────────────────────────');
  for (const d of drops) {
    console.log(`  [${d.code}] "${trunc(d.listing.title, 66)}"`);
    console.log(`         ${d.reason}`);
  }
  console.log();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tally(arr, keyOf) {
  return arr.reduce((acc, x) => {
    const k = keyOf(x);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function pad(s) {
  return String(s).padEnd(9);
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
