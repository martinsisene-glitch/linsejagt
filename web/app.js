'use strict';

/**
 * Reads data.json (written by scripts/build.js) and renders the deal list.
 * No framework, no build step — this file is served verbatim.
 */

const LAST_VISIT_KEY = 'linsejagt:lastVisit';

const el = (id) => document.getElementById(id);
const state = {
  data: null,
  sort: 'deal',
  min: 0,
  filters: new Set(),
  lastVisit: null,
};

// ─── Boot ────────────────────────────────────────────────────────────────────

(async function init() {
  // Read the previous visit BEFORE overwriting it, so "new since last time"
  // means new since the last time you actually looked.
  state.lastVisit = Number(localStorage.getItem(LAST_VISIT_KEY)) || null;
  try {
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  } catch (_) {
    /* private browsing — badges just fall back to the age-based rule */
  }

  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    el('meta').textContent = `Kunne ikke indlæse data.json (${err.message}).`;
    return;
  }

  wireControls();
  renderMeta();
  renderList();
})();

function wireControls() {
  el('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderList();
  });

  el('min').addEventListener('input', (e) => {
    state.min = Number(e.target.value);
    el('minOut').textContent = `${state.min}%`;
    renderList();
  });

  for (const chip of document.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter;
      // Source and type filters are mutually exclusive within their own pair.
      const pairs = { tradera: 'dba', dba: 'tradera', buynow: 'auction', auction: 'buynow' };
      if (state.filters.has(key)) {
        state.filters.delete(key);
      } else {
        state.filters.add(key);
        if (pairs[key]) state.filters.delete(pairs[key]);
      }
      syncChips();
      renderList();
    });
  }
}

function syncChips() {
  for (const chip of document.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(state.filters.has(chip.dataset.filter)));
  }
}

// ─── Header, banners, footer ─────────────────────────────────────────────────

function renderMeta() {
  const d = state.data;
  const when = new Date(d.generatedAt);
  const fxNote =
    d.fx.source === 'ecb' || d.fx.source === 'cache'
      ? `1 SEK = ${d.fx.sekToDkk} DKK`
      : `1 SEK = ${d.fx.sekToDkk} DKK (reservekurs — kunne ikke hentes)`;

  el('meta').textContent =
    `Opdateret ${when.toLocaleString('da-DK')} · ${d.deals.length} annoncer · ${fxNote}`;

  // A source that returns nothing is a broken scraper, not an empty market.
  const broken = Object.entries(d.sources).filter(([, s]) => !s.ok || s.kept === 0);
  if (broken.length) {
    el('sourceWarning').hidden = false;
    el('sourceWarning').textContent =
      'Bemærk: ' +
      broken
        .map(([name, s]) => `${name} leverede ingen brugbare annoncer${s.error ? ` (${s.error})` : ''}`)
        .join('; ') +
      '. Listen er derfor ufuldstændig.';
  }

  const newSince = countNew();
  if (newSince > 0) {
    el('newBanner').hidden = false;
    el('newBanner').textContent =
      state.lastVisit
        ? `${newSince} ${newSince === 1 ? 'ny annonce' : 'nye annoncer'} siden du sidst var her.`
        : `${newSince} ${newSince === 1 ? 'annonce' : 'annoncer'} er dukket op inden for de sidste ${d.settings.newBadgeHours} timer.`;
  }

  const h = d.catalogHealth;
  const unverified = h.total - h.verified;
  el('health').textContent =
    unverified > 0
      ? `Nypriser: ${h.verified} af ${h.total} er verificeret. ${unverified} er stadig estimater — rabatprocenter på dem er kun vejledende, indtil du tjekker prisen i data/lenses.json.`
      : `Alle ${h.total} nypriser er verificeret.`;
}

function isNew(deal) {
  const seen = Date.parse(deal.firstSeen);
  if (state.lastVisit) return seen > state.lastVisit;
  return Date.now() - seen < state.data.settings.newBadgeHours * 3600000;
}

function countNew() {
  return state.data.deals.filter(isNew).length;
}

// ─── List ────────────────────────────────────────────────────────────────────

function visibleDeals() {
  const f = state.filters;
  return state.data.deals.filter((d) => {
    if (d.vsNew * 100 < state.min) return false;
    if (f.has('watch') && !d.watch) return false;
    if (f.has('tradera') && d.source !== 'tradera') return false;
    if (f.has('dba') && d.source !== 'dba') return false;
    if (f.has('buynow') && !d.isBuyNow) return false;
    if (f.has('auction') && d.isBuyNow) return false;
    return true;
  });
}

const endTime = (d) => (d.endDate ? Date.parse(d.endDate) : Infinity);

const SORTS = {
  // Real prices first by discount; auctions with no bids yet have no meaningful
  // discount, so they form a second tier ordered by which closes first.
  // Mirrors compareDeals() in scripts/score.js.
  deal: (a, b) => {
    if (!!a.openAuction !== !!b.openAuction) return a.openAuction ? 1 : -1;
    return a.openAuction ? endTime(a) - endTime(b) : b.vsNew - a.vsNew;
  },
  price: (a, b) => a.landedDKK - b.landedDKK,
  new: (a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
  lens: (a, b) => a.lensName.localeCompare(b.lensName, 'da') || b.vsNew - a.vsNew,
  // Listings without an end date sort last rather than to the top.
  ending: (a, b) => endTime(a) - endTime(b),
};

function renderList() {
  const deals = visibleDeals().sort(SORTS[state.sort]);
  const list = el('list');

  el('count').textContent = `Viser ${deals.length} af ${state.data.deals.length} annoncer`;
  el('empty').hidden = deals.length > 0;

  list.textContent = '';
  const frag = document.createDocumentFragment();
  for (const d of deals) frag.appendChild(card(d));
  list.appendChild(frag);
}

function card(d) {
  const a = document.createElement('a');
  a.className = 'deal' + (isNew(d) ? ' is-new' : '');
  a.href = d.url;
  a.target = '_blank';
  a.rel = 'noopener';

  a.appendChild(thumb(d));

  const body = document.createElement('div');
  body.className = 'body';

  const lens = document.createElement('div');
  lens.className = 'lens';
  lens.textContent = d.lensName;
  body.appendChild(lens);

  const raw = document.createElement('p');
  raw.className = 'raw';
  raw.textContent = d.title;
  raw.title = d.title;
  body.appendChild(raw);

  body.appendChild(tags(d));
  a.appendChild(body);
  a.appendChild(priceBlock(d));
  return a;
}

function thumb(d) {
  if (d.imageUrl) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = d.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  const ph = document.createElement('div');
  ph.className = 'thumb ph';
  ph.textContent = 'intet\nfoto';
  return ph;
}

function tags(d) {
  const box = document.createElement('div');
  box.className = 'tags';

  const add = (text, cls) => {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '');
    s.textContent = text;
    box.appendChild(s);
  };

  if (isNew(d)) add('NY', 'new');
  add(d.source === 'tradera' ? 'Tradera' : 'DBA');
  add(d.isBuyNow ? 'Køb nu' : `Auktion${d.bidCount ? ` · ${d.bidCount} bud` : ' · 0 bud'}`);

  if (d.endDate) {
    const left = Date.parse(d.endDate) - Date.now();
    if (left > 0) add(`slutter ${humanLeft(left)}`, d.endingSoon ? 'soon' : '');
  }
  if (d.sellerLocation) add(d.sellerLocation);
  if (d.confidence === 'ambiguous') add('usikker model', 'flag');
  for (const f of d.flags) if (f !== 'usikker model') add(f, 'flag');

  return box;
}

function priceBlock(d) {
  const box = document.createElement('div');
  box.className = 'price';

  const landed = document.createElement('div');
  landed.className = 'landed';
  landed.textContent = kr(d.landedDKK);
  box.appendChild(landed);

  const pct = document.createElement('span');
  if (d.openAuction) {
    // No discount claim on an auction nobody has bid on yet — a 1 kr opening bid
    // says nothing about what the lens will actually go for.
    pct.className = 'pct open';
    pct.textContent = 'startbud';
  } else {
    pct.className = `pct ${d.rating === 'great' ? 'great' : d.rating === 'good' ? 'good' : 'fair'}`;
    pct.textContent = `${Math.round(d.vsNew * 100)}% under ny`;
  }
  box.appendChild(pct);

  const sub = document.createElement('div');
  sub.className = 'sub';
  const lines = [
    `${kr(d.priceDKK)} + ${kr(d.shippingDKK)} fragt`,
    d.priceOriginal ? `(${d.priceOriginal.amount.toLocaleString('da-DK')} ${d.priceOriginal.currency})` : '',
    `ny: ${kr(d.newPriceDKK)}`,
    d.vsUsed != null && !d.openAuction ? `brugt normalt: ${kr(d.usedBaselineDKK)}` : '',
    d.openAuction ? `brugt normalt: ${kr(d.usedBaselineDKK)} — bud kan stige` : d.provisional ? 'bud kan stige' : '',
  ].filter(Boolean);
  sub.textContent = lines.join(' · ');
  box.appendChild(sub);

  return box;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function kr(n) {
  return `${Number(n).toLocaleString('da-DK')} kr`;
}

function humanLeft(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `om ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `om ${hours} t`;
  return `om ${Math.round(hours / 24)} dage`;
}
