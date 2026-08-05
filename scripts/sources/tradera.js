'use strict';

const fs = require('fs');
const path = require('path');
const { parseXml } = require('../xml');
const { request } = require('../http');

/**
 * Tradera official API (v3 SOAP), SearchService.Search.
 *
 * We deliberately use a handful of BROAD queries and filter locally, rather than
 * one query per catalogue lens. Tradera's developer quota is not generously
 * documented, and 24 lenses x 8 runs a day would be an unnecessary gamble; broad
 * queries cost ~16 calls per run regardless of how big the catalogue grows.
 *
 * GetSearchResult / GetSearchResultAdvanced on PublicService are deprecated —
 * SearchService is the supported path.
 */

const ENDPOINT = 'https://api.tradera.com/v3/searchservice.asmx';
const SOAP_ACTION = 'http://api.tradera.com/Search';
const NS = 'http://api.tradera.com';

function envelope({ appId, appKey, query, categoryId, pageNumber, orderBy }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <AuthenticationHeader xmlns="${NS}">
      <AppId>${esc(appId)}</AppId>
      <AppKey>${esc(appKey)}</AppKey>
    </AuthenticationHeader>
    <ConfigurationHeader xmlns="${NS}">
      <Sandbox>0</Sandbox>
      <MaxResultAge>0</MaxResultAge>
    </ConfigurationHeader>
  </soap:Header>
  <soap:Body>
    <Search xmlns="${NS}">
      <query>${esc(query)}</query>
      <categoryId>${esc(categoryId)}</categoryId>
      <pageNumber>${esc(pageNumber)}</pageNumber>
      <orderBy>${esc(orderBy)}</orderBy>
    </Search>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * @returns {Promise<{listings: Array, report: object}>}
 */
async function fetchListings({ settings, credentials, probeDir }) {
  const cfg = settings.tradera || {};
  const queries = cfg.queries || [];
  const pages = cfg.pagesPerQuery || 2;
  const categoryId = cfg.categoryId ?? 0;

  if (!credentials.appId || !credentials.appKey) {
    return {
      listings: [],
      report: {
        ok: false,
        fetched: 0,
        kept: 0,
        calls: 0,
        error: 'TRADERA_APP_ID/TRADERA_APP_KEY mangler — registrér på api.tradera.com og læg dem i GitHub secrets',
      },
    };
  }

  const seen = new Map();
  let calls = 0;
  let firstRawSaved = false;
  const errors = [];

  for (const query of queries) {
    for (let page = 1; page <= pages; page++) {
      let raw;
      try {
        const res = await request(ENDPOINT, {
          method: 'POST',
          label: `tradera "${query}" s.${page}`,
          minGapMs: 700,
          headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: SOAP_ACTION },
          body: envelope({ ...credentials, query, categoryId, pageNumber: page, orderBy: 'EndDateAscending' }),
        });
        calls++;
        raw = res.body;

        if (!res.ok) {
          errors.push(`"${query}" s.${page}: HTTP ${res.status} ${soapFault(raw) || ''}`.trim());
          break; // don't burn quota paging into an endpoint that just rejected us
        }
      } catch (err) {
        calls++;
        errors.push(`"${query}" s.${page}: ${err.message}`);
        break;
      }

      // Keep the first raw response so the SOAP shape can be verified from the
      // Actions artifact instead of guessed at.
      if (probeDir && !firstRawSaved) {
        try {
          fs.mkdirSync(probeDir, { recursive: true });
          fs.writeFileSync(path.join(probeDir, 'raw-tradera.xml'), raw, 'utf8');
          firstRawSaved = true;
        } catch (_) {}
      }

      const { items, totalPages } = parseSearchResponse(raw);
      if (!items.length) {
        const fault = soapFault(raw);
        if (fault) errors.push(`"${query}" s.${page}: SOAP fault: ${fault}`);
        break;
      }

      for (const item of items) {
        const norm = normalize(item);
        if (norm) seen.set(norm.id, norm);
      }

      if (totalPages && page >= totalPages) break;
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
      error: errors.length ? errors.slice(0, 3).join(' | ') : null,
    },
  };
}

function parseSearchResponse(xml) {
  let doc;
  try {
    doc = parseXml(xml);
  } catch (_) {
    return { items: [], totalPages: null };
  }

  // Envelope > Body > SearchResponse > SearchResult > Items > (array of items)
  const result = deepFind(doc, (v) => v && typeof v === 'object' && ('Items' in v || 'TotalNumberOfItems' in v));
  if (!result) return { items: [], totalPages: null };

  const bag = result.Items;
  const items = !bag ? [] : Array.isArray(bag) ? bag : Object.values(bag).flatMap((v) => (Array.isArray(v) ? v : [v]));

  return {
    items: items.filter((i) => i && typeof i === 'object'),
    totalPages: num(result.TotalNumberOfPages),
  };
}

/** Map a Tradera SearchItem onto the shared normalized listing shape. */
function normalize(it) {
  const id = it.Id ?? it.ItemId;
  const title = it.ShortDescription ?? it.LongDescription ?? it.Title;
  if (id == null || !title) return null;
  if (it.IsEnded === true || it.IsEnded === 'true') return null;

  const bin = num(it.BuyItNowPrice);
  const maxBid = num(it.MaxBid);
  const nextBid = num(it.NextBid);
  const bidCount = num(it.BidCount) ?? 0;
  const hasBids = bidCount > 0 || it.HasBids === true || it.HasBids === 'true';

  const fixedPrice = /fixed|shop|buy/i.test(String(it.ItemType || '')) || (bin != null && maxBid == null && nextBid == null);

  // Auctions are scored on what you would have to pay right now: the current
  // high bid if there is one, otherwise the opening bid.
  const priceSEK = fixedPrice ? bin : hasBids ? maxBid ?? nextBid : nextBid ?? maxBid;
  if (priceSEK == null) return null;

  return {
    id: `tradera:${id}`,
    source: 'tradera',
    title: String(title),
    url: it.ItemUrl ? absolute(String(it.ItemUrl)) : `https://www.tradera.com/item/${id}`,
    imageUrl: firstImage(it),
    priceSEK,
    buyNowSEK: bin,
    isBuyNow: fixedPrice,
    bidCount,
    endDate: iso(it.EndDate),
    sellerLocation: it.SellerAlias ? null : null,
  };
}

function firstImage(it) {
  const t = it.ThumbnailLink;
  if (typeof t === 'string' && t) return absolute(t);
  const links = it.ImageLinks;
  const flat = !links ? [] : Array.isArray(links) ? links : Object.values(links).flat();
  const first = flat.find((v) => typeof v === 'string' && v);
  return first ? absolute(first) : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepFind(obj, pred, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (pred(obj)) return obj;
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, pred, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function soapFault(xml) {
  const m = String(xml || '').match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  return m ? m[1].trim().slice(0, 200) : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function absolute(u) {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return 'https://www.tradera.com' + (u.startsWith('/') ? '' : '/') + u;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { fetchListings, parseSearchResponse, normalize };
