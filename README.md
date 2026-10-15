# Auto-Park

One-tap parking for the **MAC Member Parking** lot on TapNPark (lot `Q60x6xih`). Open it, pick a time, tap **Park**. It applies your promo code and buys the session only if the total comes to **$0.00**. Then it shows when the session ends.

- **Passcode-protected.** Your plate, phone number and promo code are kept on the server, never in the page.
- **Live progress.** The checklist shows the real steps, and you can cancel at any point up to checkout.
- **No double buys.** Only one purchase can run at a time, a repeated tap is ignored, and it asks first if your plate is already parked.
- **Two ways to buy.** The fast engine talks to TapNPark's API (about 1.5 s). The browser engine taps through TapNPark's website (about 4–5 s, more on a slow connection). In *Automatic* mode, the browser takes over if the fast engine breaks before checkout.
- **Extras.** History, multiple vehicles, remembered choices, and test runs that stop before checkout.

See [SPEC.md](SPEC.md) for how the original app worked and [CHANGES.md](CHANGES.md) for what's different.

---

## Run it locally

Requirements: Node 20.11+ (tested on Node 24).

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `APP_PASSCODE` | What you type to unlock the app (4+ characters). |
| `SESSION_SECRET` | 32+ random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DEFAULT_PLATE`, `DEFAULT_PHONE`, `DEFAULT_PROMO` | Seed your profile on first run. You can edit them in the app later. |
| `DEFAULT_RATE` | e.g. `MAC Member - 3 Hours`. Leave it empty to use the first listed time. |
| `PARK_ENGINE` | `fake` (simulated; nothing is bought), `auto`, `api` or `browser`. **Start with `fake`.** |

Then:

```bash
npm run dev
```

Open http://localhost:5173. The API runs on port 8787 behind Vite's proxy.

**Simulation mode** (`PARK_ENGINE=fake`, or *Settings → Purchase method → Simulation*) never contacts TapNPark. Plates starting with these prefixes trigger the failure screens:

| Plate prefix | Outcome |
|---|---|
| `TESTPARKED` | Already parked |
| `TESTMISMATCH` | Camera lot mismatch, with "Buy anyway" |
| `TESTDUE` | Total isn't $0, so it stops |
| `TESTPROMO` | Promo rejected |
| `TESTBROKEN` | Engine error before checkout |
| `TESTUNKNOWN` | Error during checkout (outcome unknown) |

**Browser engine** needs Chromium:

```bash
npm run install:browser
```

### Tests and checks

```bash
npm test
```

Runs 59 tests: validation, both engines' guard rails, the run manager (single-flight, idempotency, fallback, cancel, timeout), and API auth.

```bash
npm run typecheck
```

```bash
npm run check:tapnpark
```

`check:tapnpark` is read-only. It confirms TapNPark's API and screens still look the way Auto-Park expects. It sends no plate, phone or code. Run it if purchases start failing.

### Production build

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the app and API on `PORT` (default 8787). Set `NODE_ENV=production` so the login cookie is marked `Secure`; production refuses to start without a strong `SESSION_SECRET`.

---

## Using it day to day

Auto-Park is a local Claude Code project. It runs on this Mac and isn't hosted anywhere.

- **From the Claude desktop app:** ask Claude to start Auto-Park, or open the **Auto-Park** preview (its entry is in `~/.claude/launch.json`). It opens at http://localhost:5195.
- **From a terminal:** run `npm run build`, then `npm start`, and open http://localhost:8787.

Your profile, history and screenshots stay in `data/` on this Mac, and your settings stay in `.env`. Neither is committed to git. The app only works while it's running on the Mac, so there's no address to open from your phone.

Before relying on a new parking time or promo code, open **Settings** and tap **Run a test**. It goes all the way to checkout and stops, so you can confirm the total is $0.00 without buying anything.

---

## How a purchase works

1. Open the lot (`/welcome?qr=Q60x6xih`), which starts an anonymous TapNPark session.
2. Enter the plate. TapNPark reports an existing session or a camera lot mismatch here, and Auto-Park stops on either.
3. Choose the rate. If your saved time isn't offered, it stops instead of guessing.
4. Apply the promo code.
5. **Check that the total is $0.00.** If it isn't, it stops, and nothing is paid.
6. Check out. This is the only irreversible step, and Cancel is disabled from here on.
7. Read the receipt to get the end time.

If anything fails before step 6, nothing was bought and **Try again** is safe. If the connection drops during step 6, the result is marked **Check your texts**, and the app asks before buying again for that plate for 30 minutes.

The fast engine uses TapNPark's private web API, which was reverse-engineered from their web app in October 2026. It's undocumented and could change. Every response is checked against the expected shape, so a change shows up as a clear error before checkout. In *Automatic* mode, the browser engine then takes over.

## Project layout

```
server/src/
  app.ts            Express routes (auth, profile, rates, runs, Server-Sent Events)
  auth.ts           Passcode login, signed cookie, rate limiting
  runs.ts           Run manager: one at a time, idempotency, timeout, cancel, fallback, history
  engines/          api.ts (fast), browser.ts (Playwright), fake.ts (simulation)
  tapnpark/client.ts  TapNPark API client with response validation
  store/            JSON file storage, profile validation
shared/             Types and validation used by both server and web
web/src/            React UI (Home, Run progress/result, Settings, History, Login)
tests/              Vitest suites
scripts/            check-tapnpark.ts, make-icons.ts
```
