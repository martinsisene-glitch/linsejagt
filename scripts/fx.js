'use strict';

const { request } = require('./http');

// Both SEK and DKK are quoted against EUR by the ECB, so this rate is stable
// week to week. A stale rate distorts discounts by a percent or two at most,
// which is why falling back to a constant is safe.
const MAX_CACHE_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Resolve the SEK -> DKK rate.
 *
 * Order of preference: fresh cache -> live ECB rate -> stale cache -> configured constant.
 * Returns { rate, source, fetchedAt } — `source` is surfaced in the site footer so a
 * silently stale rate is visible rather than invisible.
 */
async function getSekToDkk({ cache, fallback, offline = false }) {
  const cached = cache && typeof cache.rate === 'number' ? cache : null;
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt || 0) : Infinity;

  if (cached && age < MAX_CACHE_AGE_MS) {
    return { ...cached, source: 'cache' };
  }

  if (!offline) {
    try {
      const res = await request('https://api.frankfurter.dev/v1/latest?base=SEK&symbols=DKK', {
        label: 'frankfurter FX',
        timeoutMs: 10000,
        retries: 1,
      });
      const rate = res.ok ? JSON.parse(res.body)?.rates?.DKK : null;
      // Sanity-check: SEK/DKK has lived in 0.55-0.80 for decades. A number outside
      // that range means the API changed shape, not that the krona collapsed.
      if (typeof rate === 'number' && rate > 0.4 && rate < 1.0) {
        return { rate, fetchedAt: new Date().toISOString(), source: 'ecb' };
      }
      console.warn(`  ! FX: uventet svar fra frankfurter (rate=${rate}) — bruger reserve`);
    } catch (err) {
      console.warn(`  ! FX: kunne ikke hente kurs (${err.message}) — bruger reserve`);
    }
  }

  if (cached) return { ...cached, source: 'stale-cache' };
  return { rate: fallback, fetchedAt: null, source: 'fallback' };
}

module.exports = { getSekToDkk };
