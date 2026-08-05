'use strict';

/**
 * Self-test: `npm test`. No framework, no network.
 *
 * Covers the parts that are either easy to break silently (keyword folding,
 * price maths) or impossible to verify from a firewalled machine (the Tradera
 * SOAP parse). If a rule in data/lenses.json gets loosened and starts letting
 * lens caps through, this is what should go red.
 */

const fs = require('fs');
const path = require('path');

const { parseXml } = require('./xml');
const { classify, normalizeTitle } = require('./match');
const { score } = require('./score');
const tradera = require('./sources/tradera');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'lenses.json'), 'utf8'));
const settings = { ...catalog.settings, _sekToDkk: 0.64 };

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n      forventet: ${e}\n      fik:       ${a}`);
}

function ok(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

// ─── xml.js ──────────────────────────────────────────────────────────────────

check('xml: nested elements', parseXml('<a><b>1</b><c>x</c></a>'), { a: { b: 1, c: 'x' } });
check('xml: repeated siblings become an array', parseXml('<a><b>1</b><b>2</b></a>'), { a: { b: [1, 2] } });
check('xml: namespace prefixes stripped', parseXml('<soap:Env><x>1</x></soap:Env>'), { Env: { x: 1 } });
check('xml: self-closing / nil element is null', parseXml('<a><b xsi:nil="true" /></a>'), { a: { b: null } });
check('xml: booleans coerced', parseXml('<a><b>true</b><c>false</c></a>'), { a: { b: true, c: false } });
check('xml: entities decoded', parseXml('<a>Zeiss T&#42; &amp; co</a>'), { a: 'Zeiss T* & co' });
check('xml: CDATA kept as text', parseXml('<a><![CDATA[50mm <fint>]]></a>'), { a: '50mm <fint>' });
// A version-like string must NOT be coerced to a number.
check('xml: non-numeric left alone', parseXml('<a>2.8 GM</a>'), { a: '2.8 GM' });

// ─── Tradera SOAP parse (the path that cannot be verified live from here) ─────

const sampleXml = fs.readFileSync(path.join(ROOT, 'fixtures', 'raw-tradera-sample.xml'), 'utf8');
const parsed = tradera.parseSearchResponse(sampleXml);

check('tradera: item count', parsed.items.length, 3);
check('tradera: total pages', parsed.totalPages, 1);

const normed = parsed.items.map(tradera.normalize);
ok('tradera: ended item dropped', normed[2] === null, `fik ${JSON.stringify(normed[2])}`);

check('tradera: fixed-price item', pick(normed[0], ['id', 'priceSEK', 'isBuyNow', 'bidCount']), {
  id: 'tradera:612345678',
  priceSEK: 3200,
  isBuyNow: true,
  bidCount: 0,
});
check('tradera: auction priced on current high bid, not next bid', pick(normed[1], ['priceSEK', 'isBuyNow', 'bidCount']), {
  priceSEK: 2750,
  isBuyNow: false,
  bidCount: 9,
});
check('tradera: relative item url made absolute', normed[0].url, 'https://www.tradera.com/item/302300/612345678/sony-fe-85mm-f-1-8');
check('tradera: protocol-relative thumbnail fixed', normed[0].imageUrl, 'https://img.tradera.net/images/612/612345678_thumb.jpg');
ok('tradera: end date parsed to ISO', /^2026-08-\d\dT/.test(normed[1].endDate), normed[1].endDate);

// ─── Title normalisation ─────────────────────────────────────────────────────

check('norm: danish/swedish letters folded', normalizeTitle('Søger OBJEKTIV til Æske').text, 'soger objektiv til aeske');
check('norm: aperture forms unified', normalizeTitle('Sony FE 50mm F/1,8').text, 'sony fe 50mm f1.8');
check('norm: 1:1.8 notation', normalizeTitle('Sony 50mm 1:1.8').text, 'sony 50mm f1.8');
check('norm: zoom range collapsed', normalizeTitle('Sony 24 - 70 mm f/2,8').text, 'sony 24-70mm f2.8');
check('norm: model code squashed', normalizeTitle('Sony SEL 50 F18 F').squashed, 'sonysel50f18f');

// ─── Rejections: the false positives that matter ──────────────────────────────

const rejects = [
  ['Objektivdæksel til Sony FE 50mm f/1.8', 'accessory'],
  ['Modlysblænde til Sony 24-70mm GM II', 'accessory'],
  ['UV-filter 55mm til Sony FE 50mm', 'accessory'],
  ['Tom æske til Sony FE 85mm GM - kun æske', 'accessory'],
  ['Søger Sony FE 35mm f/1.8 - kontant', 'wanted'],
  ['Sökes: Sony FE 55mm f/1.8', 'wanted'],
  ['Købes: Sony 50mm 1.8 til E-mount', 'wanted'],
  ['Sony FE 50mm f/1.8 med svamp i linsen', 'broken'],
  ['Sony FE 85mm f/1.8 - defekt autofokus', 'broken'],
  ['Sony DT 50mm f/1.8 SAM til A-mount', 'wrong-mount'],
  ['Minolta AF 50mm f/1.7 til Sony Alpha', 'wrong-mount'],
  ['Canon EF 50mm f/1.8 STM', 'wrong-mount'],
  ['Yongnuo 50mm f/1.8 autofokus', 'not-sony'],
  ['Sony FE 600mm f/4 GM OSS', 'no-match'],
];

for (const [title, expectedCode] of rejects) {
  const r = classify({ title }, catalog);
  ok(
    `afvis [${expectedCode}]: "${title}"`,
    r.rejected && r.rejectCode === expectedCode,
    r.rejected ? `blev afvist som "${r.rejectCode}": ${r.reason}` : `blev BEHOLDT som ${r.lens?.name}`
  );
}

// ─── Acceptances, including the ones the noise filters could wrongly eat ──────

const accepts = [
  // An accessory word AFTER an inclusion word is a bonus, not the item for sale.
  ['Sony FE 50mm f/1.8 med for- og bagkapsel', 'fe-50-1.8'],
  ['Sony FE 85mm f/1.8, inkl. modlysblænde og filter', 'fe-85-1.8'],
  ['Sony FE 50mm f/1.8 SEL50F18F', 'fe-50-1.8'],
  ['SEL55F18Z Zeiss Sonnar 55mm', 'fe-55-1.8-za'],
  ['Sony FE 24-70mm f/2.8 GM II', 'fe-24-70-2.8gm2'],
  // The GM II exclude rule must keep version 1 and version 2 apart.
  ['Sony FE 24-70mm f/2.8 GM (version 1)', 'fe-24-70-2.8gm'],
  ['Sony FE 85mm f/1.4 GM II', 'fe-85-1.4gm2'],
  ['Sony FE 85mm f/1.4 GM', 'fe-85-1.4gm'],
  // Sony writes this one "GM OSS II", with the OSS wedged between GM and II.
  ['Sony FE 70-200mm f/2.8 GM OSS II', 'fe-70-200-2.8gm2'],
  ['Sony FE 70-200mm f/2.8 GMII', 'fe-70-200-2.8gm2'],
  // ...and the f/4 sibling must not be dragged in by the shared focal length.
  ['Sony FE 70-200mm f/4 G OSS', 'fe-70-200-4g'],
  // 55mm prime must not be swallowed by the 55-210mm zoom, or vice versa.
  ['Sony E 55-210mm OSS', 'e-55-210'],
  ['Sony FE 35mm f/1.8 - fin stand', 'fe-35-1.8'],
];

for (const [title, expectedId] of accepts) {
  const r = classify({ title }, catalog);
  ok(
    `behold "${title}" -> ${expectedId}`,
    !r.rejected && r.lens.id === expectedId,
    r.rejected ? `afvist: ${r.reason}` : `matchede ${r.lens.id} (${r.reason})`
  );
}

// Cosmetic wear is a flag, not a rejection.
const worn = classify({ title: 'Sony FE 90mm Macro SEL90M28G - lidt ridser på tuben' }, catalog);
ok('brugsspor flagges, ikke afvises', !worn.rejected && worn.flags.includes('brugsspor'), JSON.stringify(worn));

// ─── Scoring ─────────────────────────────────────────────────────────────────

const lens50 = catalog.lenses.find((l) => l.id === 'fe-50-1.8');
const lens2470 = catalog.lenses.find((l) => l.id === 'fe-24-70-2.8gm2');

// 850 kr against a 1699 kr new price is a 49.97% discount — just under the 50%
// "great" threshold, which makes this a useful boundary case to pin down.
const cheap = score({ source: 'dba', priceDKK: 800, isBuyNow: true }, lens50, settings);
check('score: dba landed price adds domestic shipping', pick(cheap, ['landedDKK', 'rating']), {
  landedDKK: 850,
  rating: 'good',
});

const sek = score({ source: 'tradera', priceSEK: 900, isBuyNow: true }, lens50, settings);
check('score: SEK converted then shipped', sek.landedDKK, Math.round(900 * 0.64) + 120);

const tooCheap = score({ source: 'dba', priceDKK: 150, isBuyNow: true }, lens2470, settings);
ok('score: implausibly cheap fixed price rejected', tooCheap.rejected && tooCheap.rejectCode === 'implausible', JSON.stringify(tooCheap));

// ...but a 1 kr opening bid on a real auction is normal and must survive.
const openBid = score(
  { source: 'tradera', priceSEK: 1, isBuyNow: false, bidCount: 0, endDate: future(72) },
  lens2470,
  settings
);
ok('score: 1 kr åbningsbud beholdes', !openBid.rejected, JSON.stringify(openBid));
ok('score: 0-bud auktion markeres som openAuction', openBid.openAuction === true && openBid.rating === 'open');

const bidUp = score(
  { source: 'tradera', priceSEK: 12000, isBuyNow: false, bidCount: 14, endDate: future(3) },
  lens2470,
  settings
);
ok('score: auktion med bud får rigtig rabat', bidUp.openAuction === false && bidUp.rating === 'great', JSON.stringify(bidUp));
ok('score: <24t markeres endingSoon', bidUp.endingSoon === true);

const dearer = score({ source: 'dba', priceDKK: 20000, isBuyNow: true }, lens2470, settings);
ok('score: dyrere end nypris afvises', dearer.rejected && dearer.rejectCode === 'above-new', JSON.stringify(dearer));

// ─── FX cache ────────────────────────────────────────────────────────────────

const { getSekToDkk } = require('./fx');

(async () => {
  // The fallback must NOT be persisted as a fetched rate — otherwise the next run
  // sees a "fresh" 12-hour cache and never asks the ECB again, and a made-up rate
  // becomes permanent.
  const fb = await getSekToDkk({ cache: null, fallback: 0.64, offline: true });
  ok('fx: offline uden cache bruger reservekurs', fb.rate === 0.64 && fb.source === 'fallback', JSON.stringify(fb));
  ok('fx: reservekurs har ingen fetchedAt (må ikke caches)', fb.fetchedAt === null, JSON.stringify(fb));

  const fresh = { rate: 0.7, fetchedAt: new Date().toISOString() };
  const hit = await getSekToDkk({ cache: fresh, fallback: 0.64, offline: true });
  ok('fx: frisk cache genbruges', hit.rate === 0.7 && hit.source === 'cache', JSON.stringify(hit));

  const old = { rate: 0.7, fetchedAt: new Date(Date.now() - 48 * 3600000).toISOString() };
  const stale = await getSekToDkk({ cache: old, fallback: 0.64, offline: true });
  ok('fx: forældet cache foretrækkes stadig over reservekurs', stale.rate === 0.7 && stale.source === 'stale-cache', JSON.stringify(stale));

  report();
})();

// ─── Catalogue integrity ─────────────────────────────────────────────────────

const ids = new Set();
for (const l of catalog.lenses) {
  ok(`katalog: unikt id "${l.id}"`, !ids.has(l.id));
  ids.add(l.id);
  ok(`katalog: ${l.id} brugtpris < nypris`, l.usedBaselineDKK < l.newPriceDKK, `${l.usedBaselineDKK} >= ${l.newPriceDKK}`);
  for (const p of [...(l.match || []), ...(l.exclude || [])]) {
    try {
      new RegExp(p);
      pass++;
    } catch (err) {
      failures.push(`katalog: ${l.id} har ugyldigt regex /${p}/ — ${err.message}`);
    }
  }
}

// Every catalogue lens must recognise its own name, or the rule is decoration.
for (const l of catalog.lenses) {
  const r = classify({ title: l.name }, catalog);
  ok(
    `katalog: "${l.name}" genkender sig selv`,
    !r.rejected && r.lens.id === l.id,
    r.rejected ? `afvist: ${r.reason}` : `matchede ${r.lens.id}`
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────
//
// Called from the async FX block above, which resumes only after every
// synchronous test has run — so this sees the complete tally.

function report() {
  console.log(`\n${pass} tests bestået, ${failures.length} fejlet\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  FEJL  ${f}`);
    console.error('');
    process.exit(1);
  }
}

function pick(obj, keys) {
  return keys.reduce((acc, k) => ((acc[k] = obj[k]), acc), {});
}

function future(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}
