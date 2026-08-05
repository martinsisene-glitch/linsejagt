# Linsejagt

A single page that answers one question: **is there a good used deal on a Sony E-mount lens
right now?**

It pulls listings from **Tradera** (SE) and **DBA** (DK), converts everything to DKK including
shipping, and compares each listing against what the lens costs new — so the headline number is
"X% cheaper than buying new". Lenses marked `watch` also feed an RSS feed, so new listings can
push to your phone.

Runs entirely on GitHub Actions + GitHub Pages. There is no server: a cron job fetches, scores and
renders, then publishes a static page.

**Live:** https://martinsisene-glitch.github.io/linsejagt/
**RSS:** https://martinsisene-glitch.github.io/linsejagt/feed.xml

---

## Setup (one time)

### 1. Get Tradera API credentials

Register for the free Developer Program at <https://api.tradera.com/documentation>. You get an
**AppId** (a number) and an **AppKey** (a string).

The site uses the official API rather than scraping tradera.com, so it doesn't break every time
Tradera reships their frontend.

### 2. Push this repo

```bash
cd linsejagt
git add -A && git commit -m "Linsejagt: used Sony E-mount lens deal tracker"
git remote add origin git@github.com:martinsisene-glitch/linsejagt.git
git push -u origin main
```

### 3. Add the secrets

**Settings → Secrets and variables → Actions → New repository secret**, twice:

| Name | Value |
| --- | --- |
| `TRADERA_APP_ID` | your AppId |
| `TRADERA_APP_KEY` | your AppKey |

### 4. Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.** Not "Deploy from a branch".

### 5. Run it

**Actions → "Opdater og udgiv" → Run workflow.** After that it runs by itself every two hours.

---

## Day-to-day: `data/lenses.json`

This is the only file you normally touch. Each lens looks like:

```json
{
  "id": "fe-50-1.8",
  "name": "Sony FE 50mm f/1.8",
  "codes": ["SEL50F18F"],
  "newPriceDKK": 1699,
  "usedBaselineDKK": 950,
  "priceVerified": false,
  "watch": true,
  "match":   ["fe\\s*50mm.*1\\.8"],
  "exclude": ["1\\.4", "\\bgm\\b", "zeiss"]
}
```

- **`newPriceDKK`** drives the headline discount. **The 24 prices shipped in this repo are
  estimates, not verified** — they are all `"priceVerified": false`, and the site footer says so
  out loud. Check the ones you actually care about against a Danish retailer and flip the flag; the
  footer count will go up.
- **`usedBaselineDKK`** is a normal used price, used for the "cheap *for the used market*" figure.
- **`watch: true`** means "tell me about this one" — drives the RSS feed and the *new since last
  visit* banner.
- **`codes`** are Sony's SEL model numbers, and they are by far the most reliable matcher. Add
  every code variant you see.
- **`match` / `exclude`** are regexes run against a *normalised* title: `f/1,8` → `1.8`,
  `24 - 70 mm` → `24-70mm`, `ø`→`o`, `æ`→`ae`. Write patterns in that normalised form.

Adding a lens costs one entry. Broad searches are used against both sources, so the number of API
calls does **not** grow with the catalogue.

---

## Commands

```bash
npm test          # 300+ assertions: matching, scoring, XML parse, catalogue integrity
npm run offline   # build the whole site from fixtures/ — no network needed at all
npm run explain   # same, but print why EVERY listing was kept or dropped
npm run build     # live fetch (needs TRADERA_APP_ID / TRADERA_APP_KEY in the environment)
npm run probe     # live fetch + save raw source responses into fixtures/
```

**Zero dependencies, deliberately.** There is no `npm install` step anywhere, including in CI.
That is partly hygiene and partly practical: the machine this was built on sits behind a corporate
firewall that blocks both the npm registry and the two target sites, so `node scripts/build.js
--fixtures` had to work with nothing but a bare `node`.

`npm run explain` is the tool to reach for when something looks wrong:

```
    59%  Sony FE 50mm f/1.8
         "Sony FE 50mm f/1.8 SEL50F18F - mycket fint skick"
         696 kr landet (576 + 120 fragt) · ny 1699 kr · 27% vs brugt
         match: modelkode SEL50F18F
...
  [accessory] "UV-filter 55mm til Sony FE 50mm f/1.8"
         tilbehør, ikke objektiv ("uv-filter")
```

---

## How it decides what's noise

The expensive failure mode isn't missing a deal — it's a **150 kr lens hood for a 17.000 kr lens
showing up as a 99% discount**. So listings are dropped when they look like:

| Reason | Example |
| --- | --- |
| `wanted` | "Søger Sony FE 35mm f/1.8" — someone *buying*, not selling |
| `accessory` | caps, hoods, filters, adapters, empty boxes, manuals |
| `broken` | fungus, defective AF, "til dele" |
| `wrong-mount` | A-mount, Minolta, Canon EF, Nikon, Fuji X |
| `not-sony` | a loose focal-length match with no Sony/E-mount marker |
| `implausible` | fixed price under 15% of a normal used price — a numeric backstop for accessories the keywords missed |
| `above-new` | dearer than buying it new |

Two details worth knowing, because both are deliberate and both look like bugs otherwise:

- **"med bagkapsel" is not an accessory listing.** An accessory keyword preceded by *med / inkl /
  medfølger* means the accessory is thrown in with a real lens, so the listing survives. Without
  that guard, well-described listings get thrown away.
- **A 1 kr no-reserve auction does not show a discount.** It is technically 99% off and it is
  completely meaningless — it would pin every fresh auction to the top of the list forever. Those
  are labelled `startbud` and ranked in a second tier by which closes first. Once there is at
  least one bid, the real discount is shown.

Cosmetic wear (`ridser`, `brugsspor`, dust) is a **flag on the card**, not a rejection.

---

## Layout

```
data/lenses.json          the catalogue — the file you edit
data/state.json           bot-committed: listing key -> first seen (drives "NEW")
scripts/build.js          orchestrator + CLI
scripts/match.js          title -> lens, and all the noise filters
scripts/score.js          DKK conversion, landed cost, % under new
scripts/sources/*.js      Tradera (SOAP API) and DBA (scrape) adapters
scripts/xml.js            60-line SOAP XML parser, so there are no dependencies
scripts/selftest.js       npm test
web/                      hand-written index.html / style.css / app.js, copied verbatim
fixtures/                 offline test listings + a sample SOAP response
site/                     generated, gitignored, uploaded to Pages
```

"NEW" works on two levels: `data/state.json` records when each listing was *first* seen and is
committed by the bot, so ages survive between runs; the page then compares against a `lastVisit`
timestamp in `localStorage`, so "3 new since you last looked" is right for *your* device rather
than being a global "new since the last build".

---

## Known rough edges

- **DBA has no official API.** The old `api.dba.dk` is dead and DBA now runs on Schibsted's
  Recommerce platform, so [`scripts/sources/dba.js`](scripts/sources/dba.js) tries several URL
  shapes and several extraction strategies (JSON-LD → `__NEXT_DATA__` → generic embedded JSON) and
  reports which combination worked. It was written without being able to reach dba.dk, so expect
  the first live run to need adjustment — use `npm run probe` (or the workflow's *probe* input) to
  capture the real HTML and see what the page actually contains. If DBA turns out to be behind bot
  protection, Tradera still works on its own.
- **Tradera's rate limit is not clearly documented.** Hence broad searches (8 queries × 2 pages ≈
  16 calls per run) instead of one query per lens. The build logs the call count — keep an eye on
  it for the first few days and lengthen the cron if Tradera complains.
- **The SOAP response shape is inferred from the docs**, not from a real response, since
  api.tradera.com was unreachable during development. `fixtures/raw-tradera-sample.xml` encodes
  that assumption and `npm test` checks it, so if the real shape differs, the test tells you where.
- **New prices go stale.** They're manual by design. The footer shows how many are still
  unverified so the staleness is visible rather than silent.
- Empty results from a source are treated as a **failure**, not an empty market — a scraper that
  silently stops working is the main long-term risk, so the workflow goes red and the page shows a
  warning banner.

## Courtesy

DBA's `robots.txt` doesn't disallow search pages, but a permissive robots.txt isn't contractual
permission. This is a low-volume personal tracker: requests are sequential, ~1.4s apart, only the
five queries the catalogue needs, with an honest User-Agent linking back here. Please keep it that
way if you widen the catalogue — and it's worth a glance at DBA's terms.
