'use strict';

const fs = require('fs');
const path = require('path');

const SITE_TITLE = 'Linsejagt — brugte Sony E-mount objektiver';

/**
 * Write the published site: data.json (everything the page needs), feed.xml (RSS
 * for watched lenses), and a verbatim copy of web/ (hand-authored HTML/CSS/JS).
 */
function render({ outDir, webDir, deals, catalog, fx, sourceReports, generatedAt }) {
  fs.mkdirSync(outDir, { recursive: true });

  copyDir(webDir, outDir);

  const data = buildData({ deals, catalog, fx, sourceReports, generatedAt });
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(data, null, 1), 'utf8');
  fs.writeFileSync(path.join(outDir, 'feed.xml'), buildFeed({ deals, catalog, generatedAt }), 'utf8');
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');

  return { dataBytes: JSON.stringify(data).length, feedItems: feedItemsFor(deals, catalog).length };
}

function buildData({ deals, catalog, fx, sourceReports, generatedAt }) {
  const verified = catalog.lenses.filter((l) => l.priceVerified).length;

  return {
    generatedAt,
    fx: { sekToDkk: round(fx.rate, 4), source: fx.source, fetchedAt: fx.fetchedAt },
    settings: catalog.settings,
    sources: sourceReports,
    catalogHealth: { total: catalog.lenses.length, verified },
    lenses: catalog.lenses.map((l) => ({
      id: l.id,
      name: l.name,
      newPriceDKK: l.newPriceDKK,
      usedBaselineDKK: l.usedBaselineDKK,
      watch: !!l.watch,
      priceVerified: !!l.priceVerified,
    })),
    deals: deals.map((d) => ({
      key: d.key,
      source: d.source,
      lensId: d.lens.id,
      lensName: d.lens.name,
      title: d.title,
      url: d.url,
      imageUrl: d.imageUrl || null,
      priceDKK: d.priceDKK,
      priceOriginal: d.priceSEK != null ? { amount: d.priceSEK, currency: 'SEK' } : null,
      shippingDKK: d.shippingDKK,
      landedDKK: d.landedDKK,
      newPriceDKK: d.lens.newPriceDKK,
      usedBaselineDKK: d.lens.usedBaselineDKK,
      vsNew: round(d.vsNew, 4),
      vsUsed: d.vsUsed == null ? null : round(d.vsUsed, 4),
      rating: d.rating,
      isBuyNow: !!d.isBuyNow,
      bidCount: d.bidCount ?? null,
      endDate: d.endDate || null,
      endingSoon: !!d.endingSoon,
      provisional: !!d.provisional,
      openAuction: !!d.openAuction,
      sellerLocation: d.sellerLocation || null,
      confidence: d.confidence,
      flags: d.flags,
      firstSeen: d.firstSeen,
      watch: !!d.lens.watch,
    })),
  };
}

// ─── RSS ─────────────────────────────────────────────────────────────────────

function feedItemsFor(deals, catalog) {
  const cutoff = Date.now() - (catalog.settings.feedDays || 14) * 86400000;
  return deals
    .filter((d) => d.lens.watch && Date.parse(d.firstSeen) >= cutoff)
    .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
}

function buildFeed({ deals, catalog, generatedAt }) {
  const items = feedItemsFor(deals, catalog)
    .map((d) => {
      const pct = Math.round(d.vsNew * 100);
      const kind = d.isBuyNow ? 'Køb nu' : `Auktion${d.bidCount ? ` (${d.bidCount} bud)` : ' (ingen bud endnu)'}`;
      // No discount claim on an auction nobody has bid on — the opening bid says
      // nothing about what it will actually sell for.
      const title = d.openAuction
        ? `${d.lens.name} — auktion, startbud ${fmtKr(d.landedDKK)} · ${srcName(d.source)}`
        : `${d.lens.name} — ${fmtKr(d.landedDKK)} (${pct}% under nypris) · ${srcName(d.source)}`;

      const body = [
        `<strong>${esc(d.title)}</strong>`,
        `${kind} · ${esc(srcName(d.source))}${d.sellerLocation ? ' · ' + esc(d.sellerLocation) : ''}`,
        `${d.openAuction ? 'Startbud' : 'Pris'}: ${fmtKr(d.priceDKK)}${d.priceSEK != null ? ` (${d.priceSEK} SEK)` : ''} + fragt ${fmtKr(d.shippingDKK)} = <strong>${fmtKr(d.landedDKK)}</strong>`,
        d.openAuction
          ? `Nypris: ${fmtKr(d.lens.newPriceDKK)} · normal brugtpris: ${fmtKr(d.lens.usedBaselineDKK)}`
          : `Nypris: ${fmtKr(d.lens.newPriceDKK)} → <strong>${pct}% billigere</strong>`,
        !d.openAuction && d.vsUsed != null
          ? `Normal brugtpris: ${fmtKr(d.lens.usedBaselineDKK)} (${Math.round(d.vsUsed * 100)}% under)`
          : '',
        d.endDate ? `Slutter: ${new Date(d.endDate).toLocaleString('da-DK')}` : '',
        d.flags.length ? `Bemærk: ${esc(d.flags.join(', '))}` : '',
      ]
        .filter(Boolean)
        .join('<br>');

      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(d.url)}</link>
      <guid isPermaLink="false">${esc(d.key)}</guid>
      <pubDate>${new Date(d.firstSeen).toUTCString()}</pubDate>
      <category>${esc(d.lens.name)}</category>
      <description>${esc(body)}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE_TITLE)}</title>
    <link>https://martinsisene-glitch.github.io/linsejagt/</link>
    <atom:link href="https://martinsisene-glitch.github.io/linsejagt/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Nye annoncer på de objektiver jeg holder øje med, fra Tradera og DBA.</description>
    <language>da-dk</language>
    <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function srcName(s) {
  return s === 'tradera' ? 'Tradera' : s === 'dba' ? 'DBA' : s;
}

function fmtKr(n) {
  return `${Number(n).toLocaleString('da-DK')} kr`;
}

function round(n, dp) {
  return typeof n === 'number' ? Number(n.toFixed(dp)) : n;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { render };
