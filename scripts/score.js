'use strict';

/**
 * Price maths: get every listing to a comparable landed price in DKK, then
 * express it as a discount against the new price (the headline number) and
 * against a normal used price (is this cheap *for the used market*).
 *
 * Extends the scoreListing() shape from the earlier tradera-hw-scraper prototype
 * with currency conversion and the new-price comparison.
 */

/** Convert a listing's asking price to DKK. Tradera quotes SEK, DBA quotes DKK. */
function toDKK(listing, sekToDkk) {
  if (typeof listing.priceDKK === 'number') return listing.priceDKK;
  if (typeof listing.priceSEK === 'number') return Math.round(listing.priceSEK * sekToDkk);
  return null;
}

function shippingFor(listing, settings) {
  // Prefer the real shipping cost when a source gives us one.
  if (typeof listing.shippingDKK === 'number') return listing.shippingDKK;
  if (typeof listing.shippingSEK === 'number') {
    return Math.round(listing.shippingSEK * (settings._sekToDkk || settings.fallbackSekToDkk));
  }
  return settings.shippingDKK[listing.source] ?? 0;
}

/**
 * Score one matched listing.
 * Returns the listing enriched with price fields, or { rejected, reason } if it
 * fails a sanity gate.
 */
function score(listing, lens, settings) {
  const priceDKK = toDKK(listing, settings._sekToDkk);
  const shipping = shippingFor(listing, settings);

  if (priceDKK == null) {
    return { rejected: true, reason: 'ingen pris oplyst', rejectCode: 'no-price' };
  }

  const landedDKK = priceDKK + shipping;
  const isLiveAuction = !listing.isBuyNow && listing.endDate && Date.parse(listing.endDate) > Date.now();

  // Absurdly cheap fixed-price listings are almost always a mis-parse or an
  // accessory the keyword filters missed. Auctions are exempt: a real 20.000 kr
  // lens legitimately opens at 1 kr, and killing those would gut the whole point.
  if (!isLiveAuction && landedDKK < lens.usedBaselineDKK * 0.15) {
    return {
      rejected: true,
      reason: `urealistisk billig (${landedDKK} kr mod normalt ~${lens.usedBaselineDKK} kr) — sandsynligvis tilbehør`,
      rejectCode: 'implausible',
    };
  }

  // Dearer than new is not a deal by any definition.
  if (landedDKK > lens.newPriceDKK) {
    return {
      rejected: true,
      reason: `dyrere end nypris (${landedDKK} kr mod ${lens.newPriceDKK} kr ny)`,
      rejectCode: 'above-new',
    };
  }

  const vsNew = (lens.newPriceDKK - landedDKK) / lens.newPriceDKK;
  const vsUsed = lens.usedBaselineDKK
    ? (lens.usedBaselineDKK - landedDKK) / lens.usedBaselineDKK
    : null;

  const hoursLeft = listing.endDate
    ? (Date.parse(listing.endDate) - Date.now()) / 3600000
    : null;

  // A no-reserve auction opens at 1 kr. Reporting that as "99% under nypris" is
  // technically true and completely useless — it would pin every fresh auction to
  // the top of the list forever. These are surfaced without a discount figure and
  // ranked by when they end instead.
  const openAuction = isLiveAuction && !(listing.bidCount > 0);

  return {
    rejected: false,
    priceDKK,
    shippingDKK: shipping,
    landedDKK,
    vsNew,
    vsUsed,
    rating: openAuction ? 'open' : rate(vsNew, settings),
    isLiveAuction,
    openAuction,
    hoursLeft,
    endingSoon: hoursLeft != null && hoursLeft > 0 && hoursLeft < 24,
    // Any live auction can still be bid up, so its price is provisional.
    provisional: isLiveAuction,
  };
}

function rate(vsNew, settings) {
  if (vsNew >= settings.greatDealThreshold) return 'great';
  if (vsNew >= settings.goodDealThreshold) return 'good';
  if (vsNew >= 0) return 'fair';
  return 'poor';
}

/**
 * Default ordering: real prices first, ranked by discount. Auctions with no bids
 * yet have no meaningful discount, so they form a second tier ordered by which
 * one closes first. Mirrored in web/app.js so the page and the feed agree.
 */
function compareDeals(a, b) {
  if (!!a.openAuction !== !!b.openAuction) return a.openAuction ? 1 : -1;
  if (a.openAuction) {
    return (a.endDate ? Date.parse(a.endDate) : Infinity) - (b.endDate ? Date.parse(b.endDate) : Infinity);
  }
  return b.vsNew - a.vsNew;
}

module.exports = { score, toDKK, compareDeals };
