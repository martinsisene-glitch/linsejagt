'use strict';

const fs = require('fs');
const path = require('path');
const { request } = require('../http');

/**
 * DBA (Den Blå Avis) — no official public API.
 *
 * The old api.dba.dk mobile endpoint is dead, and DBA has since moved onto
 * Schibsted's Recommerce platform, so the live page shape had to be discovered
 * rather than looked up. This adapter therefore tries several URL shapes and
 * several extraction strategies, reports which combination worked, and can dump
 * the raw HTML for inspection (`--probe`) when none of them do.
 *
 * Politeness: sequential requests, ~1.4s apart, honest User-Agent, and only the
 * few queries the catalogue actually needs. DBA's robots.txt does not disallow
 * search pages, but a permissive robots.txt is not the same as permission — this
 * is a personal-use tracker, kept deliberately low-volume.
 */

// Tried in order; the first shape that yields listings wins and is reported.
const URL_SHAPES = [
  (q, page) => `https://www.dba.dk/soeg/?soeg=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`,
  (q, page) => `https://www.dba.dk/recommerce/forsale/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`,
  (q, page) => `https://www.dba.dk/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`,
];

async function fetchListings({ settings, probeDir }) {
  const cfg = settings.dba || {};
  const queries = cfg.queries || [];
  const pages = cfg.pagesPerQuery || 1;

  const seen = new Map();
  const errors = [];
  const strategiesUsed = new Set();
  let shapeIndex = null;
  let calls = 0;
  let probeSaved = false;

  for (const query of queries) {
    for (let page = 1; page <= pages; page++) {
      // Once a URL shape has proven itself, stop probing the others.
      const shapes = shapeIndex == null ? URL_SHAPES.map((f, i) => [f, i]) : [[URL_SHAPES[shapeIndex], shapeIndex]];
      let got = 0;

      for (const [shape, idx] of shapes) {
        const url = shape(query, page);
        let html;
        try {
          const res = await request(url, {
            label: `dba "${query}" s.${page}`,
            minGapMs: 1400,
            browserUa: true,
            headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9' },
          });
          calls++;
          if (!res.ok) {
            errors.push(`${short(url)}: HTTP ${res.status}`);
            continue;
          }
          html = res.body;
        } catch (err) {
          calls++;
          errors.push(`${short(url)}: ${err.message}`);
          continue;
        }

        if (probeDir && !probeSaved) {
          try {
            fs.mkdirSync(probeDir, { recursive: true });
            fs.writeFileSync(path.join(probeDir, 'raw-dba.html'), html, 'utf8');
            probeSaved = true;
          } catch (_) {}
        }

        const { listings, strategy } = extract(html);
        if (listings.length) {
          shapeIndex = idx;
          strategiesUsed.add(`${strategy}@shape${idx}`);
          for (const l of listings) seen.set(l.id, l);
          got = listings.length;
          break;
        }
        errors.push(`${short(url)}: 200 men ingen annoncer kunne udtrækkes (${html.length} bytes, markører: ${markers(html) || 'ingen'})`);
      }

      if (!got) break; // no point paging further on this query
    }
  }

  const listings = [...seen.values()];
  return {
    listings,
    report: {
      ok: listings.length > 0,
      fetched: listings.length,
      calls,
      queries: queries.length,
      strategy: [...strategiesUsed].join(', ') || null,
      error: listings.length ? null : errors.slice(0, 3).join(' | ') || 'ingen annoncer fundet',
    },
  };
}

// ─── Extraction strategies ───────────────────────────────────────────────────

function extract(html) {
  for (const [strategy, fn] of [
    ['json-ld', fromJsonLd],
    ['next-data', fromNextData],
    ['embedded-json', fromEmbeddedJson],
  ]) {
    try {
      const listings = fn(html);
      if (listings.length) return { listings, strategy };
    } catch (_) {
      /* try the next strategy */
    }
  }
  return { listings: [], strategy: null };
}

/** Schema.org ItemList / Product blocks — the cleanest option when present. */
function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let json;
    try {
      json = JSON.parse(m[1].trim());
    } catch (_) {
      continue;
    }
    collectListings(json, out);
  }
  return out;
}

/** Next.js pageProps payload. */
function fromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const out = [];
  collectListings(JSON.parse(m[1]), out);
  return out;
}

/**
 * Last resort: scan every JSON-looking script blob for objects that carry a
 * title, a price and a link. Deliberately loose — the keyword filters and the
 * price sanity gates downstream are what keep the noise out.
 */
function fromEmbeddedJson(html) {
  const out = [];
  const re = /<script[^>]*>([\s\S]{200,}?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    for (const blob of m[1].match(/\{[\s\S]*\}/g) || []) {
      try {
        collectListings(JSON.parse(blob), out);
      } catch (_) {
        /* not JSON — expected for most script tags */
      }
    }
  }
  return out;
}

/** Walk arbitrary JSON and pull out anything that looks like a classified ad. */
function collectListings(node, out, depth = 0) {
  if (depth > 12 || !node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const v of node) collectListings(v, out, depth + 1);
    return;
  }

  const title = str(node.name ?? node.title ?? node.heading ?? node.subject);
  const url = str(node.url ?? node.link ?? node.canonicalUrl ?? node.itemUrl ?? node.href);
  const price = priceOf(node);

  if (title && url && price != null && /dba\.dk|^\//.test(url)) {
    const id = idFrom(node, url);
    out.push({
      id: `dba:${id}`,
      source: 'dba',
      title,
      url: absolute(url),
      imageUrl: imageOf(node),
      priceDKK: price,
      isBuyNow: true, // DBA is fixed-price only; there are no auctions
      bidCount: null,
      endDate: null,
      sellerLocation: str(node.location?.name ?? node.location ?? node.city ?? node.area) || null,
    });
  }

  for (const v of Object.values(node)) collectListings(v, out, depth + 1);
}

function priceOf(node) {
  const raw =
    node.price ??
    node.priceDKK ??
    node.amount ??
    node.offers?.price ??
    node.offers?.lowPrice ??
    node.price?.amount;

  if (raw == null) return null;
  if (typeof raw === 'object') return priceOf(raw);

  const n = Number(String(raw).replace(/[^\d]/g, ''));
  // Anything above 500.000 kr in a lens search is a car or a house, not glass.
  return Number.isFinite(n) && n > 0 && n < 500000 ? n : null;
}

function imageOf(node) {
  const img = node.image ?? node.thumbnail ?? node.imageUrl ?? node.images;
  const v = Array.isArray(img) ? img[0] : img;
  if (typeof v === 'string') return absolute(v);
  if (v && typeof v === 'object') return str(v.url ?? v.contentUrl) ? absolute(str(v.url ?? v.contentUrl)) : null;
  return null;
}

function idFrom(node, url) {
  if (node.id != null) return String(node.id);
  const m = String(url).match(/id-(\d+)|\/(\d{6,})(?:[/?#]|$)/);
  return m ? m[1] || m[2] : String(url).replace(/[^a-z0-9]/gi, '').slice(-24);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function absolute(u) {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return 'https://www.dba.dk' + (u.startsWith('/') ? '' : '/') + u;
}

function short(u) {
  return u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70);
}

/** Which frontend markers a page contains — the key diagnostic when nothing parses. */
function markers(html) {
  return ['__NEXT_DATA__', 'application/ld+json', 'self.__next_f', '__remixContext', '__NUXT__', 'window.__INITIAL']
    .filter((k) => html.includes(k))
    .join(', ');
}

module.exports = { fetchListings, extract };
