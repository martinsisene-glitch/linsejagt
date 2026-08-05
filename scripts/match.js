'use strict';

/**
 * Turn a messy human-written listing title into "this is lens X, or it is noise".
 *
 * Lens titles on DBA and Tradera are written by hand in two languages, so the
 * matcher normalises aggressively first, then leans on Sony's SEL model codes,
 * and only falls back to focal-length/aperture patterns.
 */

// ─── Normalisation ───────────────────────────────────────────────────────────

/**
 * Fold Scandinavian letters and punctuation to a plain-ASCII lowercase form.
 * Applied to BOTH listing titles and the keyword lists below, so the two sides
 * can never drift apart.
 */
function fold(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[àáâãä]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/æ/g, 'ae')
    .replace(/[""''`´]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const foldAll = (terms) => terms.map(fold);

/**
 * Produce two views of a title:
 *   text     — folded, with apertures and focal lengths canonicalised so "f/1,8"
 *              and "F 1.8" both become "1.8", and "24 - 70 mm" becomes "24-70mm".
 *   squashed — alphanumerics only, so "SEL 50 F18 F" becomes "sel50f18f".
 */
function normalizeTitle(raw) {
  let text = fold(raw);

  // Decimal comma -> decimal point (1,8 -> 1.8)
  text = text.replace(/(\d),(\d)/g, '$1.$2');
  // f/1.8, f:1.8, f 1.8 -> f1.8   and   1:1.8 -> f1.8
  text = text.replace(/\bf\s*[/:]?\s*(\d+(?:\.\d+)?)/g, 'f$1');
  text = text.replace(/\b1\s*:\s*(\d+\.\d+)/g, 'f$1');
  // Collapse focal lengths and zoom ranges
  text = text.replace(/(\d+)\s*[-–—]\s*(\d+)\s*mm/g, '$1-$2mm');
  text = text.replace(/(\d+)\s*mm/g, '$1mm');

  return { text: text.trim(), squashed: text.replace(/[^a-z0-9]/g, '') };
}

// ─── Noise vocabularies ──────────────────────────────────────────────────────

// Someone WANTING to buy, not selling. Common on DBA and a pure waste of a click.
const WANTED_TERMS = foldAll([
  'søger', 'søges', 'købes', 'efterlyses', 'ønskes købt', 'ønsker at købe',
  'sökes', 'köpes', 'önskas köpa', 'wanted', 'looking for', 'wtb',
]);

// Accessories that name the lens they fit. The classic false positive: a 150 kr
// lens hood for a 17.000 kr lens reads as a 99% discount.
const ACCESSORY_TERMS = foldAll([
  'objektivdæksel', 'objektivlock', 'linsdammskydd', 'lens cap', 'front cap',
  'rear cap', 'bagkapsel', 'baglock', 'frontkapsel', 'objektivdæksler',
  'modlysblænde', 'solblænde', 'lens hood', 'motljusskydd',
  'uv-filter', 'uv filter', 'polfilter', 'nd-filter', 'nd filter', 'filtersæt',
  'filterring', 'step-up ring', 'adapterring', 'mellemring', 'mellanring',
  'objektivadapter', 'lens adapter', 'monteringsadapter', 'speedbooster', 'speed booster',
  'objektivtaske', 'lens case', 'lens pouch', 'objektivväska',
  'brugsanvisning', 'bruksanvisning', 'manual til',
  'kun æske', 'tom æske', 'kun kasse', 'endast kartong', 'box only', 'kun emballage',
  'reparationsdele', 'reservedele', 'reservdelar',
]);

// If one of these appears just before an accessory term, the accessory is being
// INCLUDED with a real lens ("Sony 50mm med for- og bagkapsel") — not the item
// for sale. Without this guard, well-described listings get thrown away.
// Note the gap allows any character: "inkl." puts a full stop immediately after
// the keyword, so excluding punctuation here would defeat the whole guard.
const INCLUSION_RE = /\b(med|inkl|inklusive|inkluderet|medfølger|medföljer|samt|incl|including|with|plus)\b[\s\S]{0,32}$/;

// Genuinely broken glass — you do not want these at any price.
const BROKEN_TERMS = foldAll([
  'defekt', 'defect', 'virker ikke', 'fungerar inte', 'ej fungerande', 'trasig',
  'til dele', 'til reservedele', 'för delar', 'for parts', 'as-is', 'as is',
  'svamp', 'fungus', 'skimmel', 'mögel', 'mug i linsen', 'dug indvendigt',
  'kan ikke fokusere', 'autofokus virker ikke', 'af virker ikke', 'ødelagt',
  'knust', 'krossad', 'sprække i glas', 'ridse i glasset', 'glasset er ridset',
]);

// Cosmetic or minor issues — worth knowing about, not worth hiding.
const FLAG_TERMS = foldAll([
  'ridser', 'ridset', 'repor', 'repad', 'kosmetiske skader', 'brugsspor', 'bruksslitage',
  'støv indvendigt', 'lidt støv', 'damm inuti', 'dust inside',
  'ingen returret', 'sælges som beset', 'säljes i befintligt skick',
]);

// Camera bodies — if one is named, the price probably covers more than the lens.
const BODY_TERMS = foldAll([
  'a7iii', 'a7 iii', 'a7ii', 'a7 ii', 'a7iv', 'a7 iv', 'a7rii', 'a7riii', 'a7riv', 'a7rv',
  'a7sii', 'a7siii', 'a7c', 'a9ii', 'a6000', 'a6100', 'a6300', 'a6400', 'a6500',
  'a6600', 'a6700', 'a5000', 'a5100', 'nex-', 'zv-e10', 'zv-e1', 'fx3', 'fx30',
  'kamerahus', 'camera body', 'kamerahaus',
]);

const BUNDLE_TERMS = foldAll([
  'pakke', 'paket', 'bundle', 'sælges samlet', 'säljes samlat', 'flere objektiver', 'flera objektiv',
]);

// Sony/E-mount gate for pattern (non-code) matches. "50mm f/1.8" alone could be
// any brand on any mount, so a loose pattern must be corroborated by the brand.
const SONY_GATE = /sony|\bfe\b|e-?mount|emount|\bsel\d|\bnex\b|alpha|\ba7\b|\ba6\d{3}\b/;

// Mounts that are emphatically not E-mount, however Sony-branded they look.
const WRONG_MOUNT =
  /a-?mount|\bdt\b\s*\d|minolta|maxxum|konica|\bef\b\s*\d|\bef-s\b|\brf\b\s*\d|nikon\s*[fz]\b|\bmft\b|micro\s*4\/3|micro\s*four|fuji(film)?\s*x/;

// ─── Matching ────────────────────────────────────────────────────────────────

function findTerm(text, terms) {
  for (const t of terms) {
    const at = text.indexOf(t);
    if (at !== -1) return { term: t, at };
  }
  return null;
}

/**
 * Classify one listing against the catalogue.
 *
 * Returns { lens, confidence, flags, rejected, reason }. Rejections carry a human
 * reason so `--explain` can tell you exactly why something disappeared.
 */
function classify(listing, catalog) {
  const { text, squashed } = normalizeTitle(listing.title);
  const flags = [];

  const reject = (reason, code) => ({ lens: null, confidence: null, flags, rejected: true, reason, rejectCode: code });

  const wanted = findTerm(text, WANTED_TERMS);
  if (wanted) return reject(`købsannonce ("${wanted.term}")`, 'wanted');

  const accessory = findTerm(text, ACCESSORY_TERMS);
  if (accessory && !INCLUSION_RE.test(text.slice(0, accessory.at))) {
    return reject(`tilbehør, ikke objektiv ("${accessory.term}")`, 'accessory');
  }

  const broken = findTerm(text, BROKEN_TERMS);
  if (broken) return reject(`defekt ("${broken.term}")`, 'broken');

  const wrongMount = text.match(WRONG_MOUNT);
  if (wrongMount) return reject(`forkert bajonet ("${wrongMount[0].trim()}")`, 'wrong-mount');

  if (findTerm(text, FLAG_TERMS)) flags.push('brugsspor');
  if (findTerm(text, BODY_TERMS)) flags.push('kamerahus nævnt');
  if (findTerm(text, BUNDLE_TERMS)) flags.push('pakke');

  // 1. Model code — definitive, needs no brand corroboration.
  const byCode = catalog.lenses.filter((l) =>
    (l.codes || []).some((code) => squashed.includes(code.toLowerCase()))
  );
  if (byCode.length) {
    return {
      lens: byCode[0],
      confidence: 'code',
      flags,
      rejected: false,
      reason: `modelkode ${byCode[0].codes[0]}`,
    };
  }

  // 2. Loose patterns — only trusted if the title also identifies as Sony/E-mount.
  if (!SONY_GATE.test(text)) return reject('ingen Sony/E-mount-markør i titlen', 'not-sony');

  const byPattern = [];
  for (const lens of catalog.lenses) {
    const hit = (lens.match || []).find((p) => new RegExp(p).test(text));
    if (!hit) continue;
    if ((lens.exclude || []).some((p) => new RegExp(p).test(text))) continue;
    byPattern.push({ lens, pattern: hit });
  }

  if (!byPattern.length) return reject('matchede ingen linse i kataloget', 'no-match');

  if (byPattern.length > 1) {
    // Ambiguous: bias toward the CHEAPEST candidate. Guessing the expensive lens
    // would inflate the headline discount, which is the one error that actually
    // costs you a wasted trip.
    byPattern.sort((a, b) => a.lens.newPriceDKK - b.lens.newPriceDKK);
    flags.push('usikker model');
  }

  const best = byPattern[0];
  return {
    lens: best.lens,
    confidence: byPattern.length > 1 ? 'ambiguous' : 'pattern',
    flags,
    rejected: false,
    reason: `mønster /${best.pattern}/${byPattern.length > 1 ? ` (${byPattern.length} kandidater)` : ''}`,
  };
}

module.exports = { classify, normalizeTitle, fold };
