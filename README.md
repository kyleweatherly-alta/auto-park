# Auto-Park

One-tap parking for the **MAC Member Parking** lot on TapNPark (lot `Q60x6xih`). Open it, pick a time, tap **Park**. It applies your promo code and buys the session only if the total comes to **$0.00**. Then it shows when the session ends.

**Live:** https://auto-park.kyle-weatherly.workers.dev (public, no login)

- **Your details stay on your phone.** Your plate, phone number, promo code and history are saved only in your browser. The server uses them for one purchase and keeps nothing, so a visitor sees an empty form, never yours.
- **Live progress.** The checklist shows the real steps, and you can cancel at any point up to checkout.
- **No double buys.** Only one purchase per plate runs at a time, a repeated tap is ignored, and the app asks first if your plate is already parked.
- **Two ways to buy.** The fast engine talks to TapNPark's API (about 1.5 s); it's the only one online. On this Mac there's also a browser engine that taps through TapNPark's website (about 4 s). In *Automatic* mode the browser takes over if the fast engine breaks before checkout.
- **Extras.** History, multiple vehicles, remembered choices, and test runs that stop before checkout.

See [SPEC.md](SPEC.md) for how the original app worked and [CHANGES.md](CHANGES.md) for what's different.

---

## Using it

1. Open the live link on your phone and tap **Set up**. Enter your plate, the phone number for receipts, and your promo code.
2. Optional: **Share → Add to Home Screen**, so it opens like an app.
3. Tap **Park ‹your plate›**. You're parked when it says "Parked until …", and TapNPark texts you the receipt.

Before relying on a new parking time or promo code, open **Settings** and tap **Run a test**. It goes all the way to checkout and stops, so you can confirm the total is $0.00 without buying anything.

Each browser keeps its own details. Another phone, or a private window, starts empty. **Settings → Forget my details on this device** clears them.

## Deploy updates (Cloudflare)

The site is a Cloudflare Worker (`wrangler.jsonc`). It serves the built web app as static assets and sends `/api/*` to one Durable Object, which runs purchases in memory and stores nothing. To publish a change:

```bash
npm run deploy
```

That builds the web app and runs `wrangler deploy`. You must be logged in with `npx wrangler login`. Settings live in `vars` in `wrangler.jsonc`:
- `PARK_ENGINE` is `api`.
- `RUNS_PER_HOUR` caps how many purchases each visitor can start per hour (30).
- `LOT_CODE` and `LOT_NAME` identify the lot.

There are no secrets to set.

To try the Worker locally before deploying:

```bash
npm run cf:dev
```

Then open http://localhost:8790.

## Run it on this Mac

Requirements: Node 20.11+ (tested on Node 24).

```bash
npm install
```

```bash
cp .env.example .env
```

Set `PARK_ENGINE` in `.env`. Use `fake` while developing; nothing is bought. The other choices are `auto`, `api` and `browser`. Then:

```bash
npm run dev
```

Open http://localhost:5173. The API runs on port 8787 behind Vite's proxy. In the Claude desktop app you can also open the **Auto-Park** preview.

**Simulation mode** (`PARK_ENGINE=fake`, or *Settings → Purchase method → Simulation*) never contacts TapNPark. Plates starting with these prefixes trigger the failure screens:

| Plate prefix | Outcome |
|---|---|
| `TESTPARKED` | Already parked |
| `TESTMISMATCH` | Camera lot mismatch, with "Buy anyway" |
| `TESTDUE` | Total isn't $0, so it stops |
| `TESTPROMO` | Promo rejected |
| `TESTBROKEN` | Engine error before checkout |
| `TESTUNKNOWN` | Error during checkout (outcome unknown) |

The **browser engine** needs Chromium:

```bash
npm run install:browser
```

For a production-style local server:

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:8787.

### Tests and checks

```bash
npm test
```

Runs 65 tests. They cover:
- input validation and the this-device history guards,
- both engines' guard rails,
- the run manager: per-plate locking, the concurrency cap, idempotency, fallback, cancel and timeout,
- the public API: validation, rate limiting and cross-site blocking, and a check that phone numbers and promo codes never come back from the server.

```bash
npm run typecheck
```

This checks both the Mac and Cloudflare builds.

```bash
npm run check:tapnpark
```

`check:tapnpark` is read-only. It confirms TapNPark's API and screens still look the way Auto-Park expects. It sends no plate, phone or code. Run it if purchases start failing.

---

## Privacy and safety

- The server stores **nothing personal**. Each purchase request carries the plate, phone and promo code from the visitor's own browser. The server keeps the run (plate, steps, result) in memory for 30 minutes so a phone can reconnect to it. Phone numbers and promo codes never appear in run data, and no log line includes them.
- Personal details are saved only in each browser's `localStorage`.
- Anyone can use the site with their own details, but only for this lot. Each visitor can start 30 purchases per hour, and at most 5 run at once. Requests from other websites are refused.

## How a purchase works

1. Open the lot (`/welcome?qr=Q60x6xih`), which starts an anonymous TapNPark session.
2. Enter the plate. TapNPark reports an existing session or a camera lot mismatch here, and Auto-Park stops on either.
3. Choose the rate. If your saved time isn't offered, it stops instead of guessing.
4. Apply the promo code.
5. **Check that the total is $0.00.** If it isn't, it stops, and nothing is paid.
6. Check out. This is the only irreversible step, and Cancel is disabled from here on.
7. Read the receipt to get the end time.

If anything fails before step 6, nothing was bought and **Try again** is safe. If the connection drops during step 6, the result is marked **Check your texts**, and that device asks before buying again for that plate for 30 minutes.

The fast engine uses TapNPark's private web API, which was reverse-engineered from their web app in October 2026. It's undocumented and could change. Every response is checked against the expected shape, so a change shows up as a clear error before checkout.

## Project layout

```
server/src/
  app.ts            Hono API (status, rates, runs, Server-Sent Events), shared by the Mac and the Worker
  runs.ts           Run manager: per-plate lock, idempotency, timeout, cancel, fallback (in memory)
  node.ts           Mac entry point (all engines, serves the built web app)
  engines/          api.ts (fast), browser.ts (Playwright, Mac only), fake.ts (simulation)
  tapnpark/client.ts  TapNPark API client with response validation
worker/index.ts     Cloudflare Worker + Durable Object entry point
shared/             Types, validation and history guards used by server and web
web/src/            React UI; store.ts keeps the profile and history in the browser
tests/              Vitest suites
scripts/            check-tapnpark.ts, make-icons.ts
```
