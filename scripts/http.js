'use strict';

/**
 * Polite HTTP helper shared by the source adapters.
 *
 * Identifies itself honestly (with a link back to the repo) and serialises requests
 * with a delay, because we are a guest on someone else's servers.
 */

const REPO_URL = 'https://github.com/martinsisene-glitch/linsejagt';

const UA = `LinsejagtBot/1.0 (personal used-lens price tracker; +${REPO_URL})`;

// A browser UA for sites that reject unknown clients outright. Used only where
// the bot UA gets a hard block, never to hide what we are doing.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialise outbound requests so we never hammer a host in parallel. */
async function throttle(minGapMs) {
  const wait = lastRequestAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Fetch with throttling, timeout and retry-on-transient-failure.
 * Returns { ok, status, body, headers }. Never throws on HTTP status codes —
 * callers decide what a 403 means for them.
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 2,
    minGapMs = 1000,
    browserUa = false,
    label = url,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1.5s, 4.5s
      await sleep(1500 * Math.pow(3, attempt - 1));
    }
    await throttle(minGapMs);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'User-Agent': browserUa ? BROWSER_UA : UA,
          'Accept-Language': 'da-DK,da;q=0.9,sv;q=0.8,en;q=0.7',
          ...headers,
        },
      });
      const text = await res.text();

      // Retry only on transient server-side problems, never on 4xx.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new Error(`${label}: HTTP ${res.status}`);
        continue;
      }
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, body: text, headers: res.headers };
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`${label}: timeout after ${timeoutMs}ms`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { request, sleep, UA, BROWSER_UA, REPO_URL };
