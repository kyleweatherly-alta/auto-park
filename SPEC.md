# Auto-Park — Spec of the current app

Source of truth: the live app at https://auto-park-filler.replit.app (inspected 2026-10-15) and its shipped front-end bundle (`/assets/index-ex2pbBYO.js`). The server code is **not** public, so anything about the backend below is inferred from the API contract and the step labels the UI shows. Those parts are marked _(inferred)_.

No purchase was made while writing this spec: "Buy Parking" was never clicked, and nothing was POSTed to the app's API.

> Personal values (plate, phone, promo code) are masked in this file because it will probably end up in a git repo.

---

## 1. What it does and who it's for

**Kyle hates the MAC parking app** is a one-person tool that buys a parking session in the **"MAC Member Parking"** lot on TapNPark (lot code `Q60x6xih`) without making you tap through TapNPark's mobile web flow every time.

You open the page, check that your plate, phone and promo code are pre-filled, and tap **Buy Parking**. A server then drives TapNPark's website in a headless browser: it enters the plate and phone, confirms the plate, picks the duration, applies the promo/validation code and checks out. TapNPark texts the receipt to the phone number.

- **User:** one person (Kyle), usually on a phone, standing next to the car.
- **Value:** 1 tap instead of about 8 screens. The member promo code is applied every time without retyping.

---

## 2. Screens and states

There is one page (`/`) with four states: `idle` → `running` → `complete` | `error`.

### 2.1 Idle (form)

| Element | Type | Default | Behaviour / validation |
|---|---|---|---|
| Header | 🅿️ emoji, H1 "Kyle hates the MAC parking app", subtitle "Automates your parking purchase at Lot Q60x6xih" | — | Static. The Inter font's contextual alternates render the lot code as **"Q60×6xih"** (× instead of x). |
| **License Plate** | `input type=text`, placeholder `ABC1234` | `•••••••` (hard-coded in the JS bundle, then overwritten by `GET /api/config`) | Forced to UPPERCASE as you type. No length or character checks. Spaces and dashes are kept. |
| **Phone Number** | `input type=tel`, placeholder is a real phone number (`•••-•••-••••`) | `•••-•••-••••` (hard-coded, then from config) | No validation. Free text is accepted. |
| **Promo Code** | `input type=text`, placeholder `Optional` | `•••••` (hard-coded, then from config) | Forced to UPPERCASE. Optional. |
| **Buy Parking** | button | — | Disabled while config is loading, or when plate or phone is blank after trimming. No message says *why* it is disabled. |

Loading: all three inputs are disabled (50% opacity) until `GET /api/config` resolves. If that request fails, the form unlocks with the hard-coded defaults.

Structure: there is no `<form>` element, so pressing **Enter does not submit**. The labels are not tied to their inputs (no `for`/`id`), so screen readers announce each field by its placeholder ("ABC1234"), not by its label. There are no `autocomplete` hints. The viewport meta sets `maximum-scale=1`, which **disables pinch-zoom**.

### 2.2 Running

- A summary box shows Plate, Phone and Promo (Promo only if non-empty).
- A spinner and the text "Running automation…".
- An 8-step checklist:
  1. Opening TapNPark website…
  2. Clicking Buy Parking…
  3. Entering license plate…
  4. Entering phone number…
  5. Confirming plate…
  6. Selecting parking duration…
  7. Entering promo code…
  8. Clicking Check Out…
- **The checklist is fake progress.** It advances on a client-side timer (one step every 3.5 s) and stops at step 8. It has no connection to what the server is actually doing.
- There is no cancel button and no timeout.

### 2.3 Complete

- ✅ "Complete!", then the server's `message` (default "Parking purchase complete!"), then a **Start Over** button that returns to Idle.
- The screen shows no end time, amount, receipt or confirmation number.

### 2.4 Error

- ⚠️ "Something went wrong", then the server's `message` in a red box (default "Something went wrong."), then a **Try Again** button.
- **Try Again** only returns to Idle. Tapping Buy again starts a **new purchase attempt**, even if the first one may have gone through.
- If the request throws, or the response isn't JSON (for example a proxy timeout page), the screen says "Network error — could not reach the server.", which can be misleading.

---

## 3. End-to-end workflow

1. The page loads, then `GET /api/config` returns `{ plate, phone, promoCode }` and fills the form.
2. The user optionally edits the fields, then taps **Buy Parking**.
3. The client builds the payload: `plate = trim().toUpperCase()`, `phone = digits only`, `promoCode = trim()`.
4. The client sends `POST /api/config` with `{ plate, phone: <raw trimmed, not digits-only>, promoCode }`. This saves the inputs for next time. **Errors are swallowed, and it saves even if the purchase later fails.**
5. The client sends `POST /api/park` with the payload. The request stays open for the whole automation run (roughly 20–40 s _(inferred)_).
6. _(inferred)_ The server launches headless Chromium and runs TapNPark's flow:
   1. Opens `https://app.tapnpark.com/?qr=Q60x6xih`, which redirects to `/welcome?qr=Q60x6xih` ("MAC Member Parking": *Buy Parking*, *Buy FlexPark*, *Sign In*).
   2. Clicks **Buy Parking**, which opens `/purchase/singlepass` ("Please provide your information").
   3. Fills **License plate** (TapNPark placeholder `ABC123`).
   4. Fills **Phone Number** (TapNPark pre-fills `+1`; there is also an "Email Instead?" toggle), then clicks **Agree and Continue** (which accepts TapNPark's Terms of Use and Privacy Policy).
   5. In the **Confirm Plate** modal ("Please confirm your license plate is correct before proceeding"), clicks Confirm.
   6. On the rate selection screen (`/selectrate`), picks a parking rate/duration. **Which rate it picks is unknown.**
   7. At checkout (`/cart`), enters the **Promo or validation Code** and applies it. The line items include the rate, a Promotion/Discount line, and possibly a Service Fee and Taxes.
   8. Clicks **Check Out**. At $0 this should land on `/purchase/confirmation` ("This parking session ends at …", with receipt options). If a balance is due, TapNPark shows a card payment form ("Loading payment form…"). The bot has no card, so it presumably fails here.
7. The server responds `{ status: "complete" | <other>, message }`, and the UI shows Complete or Error.

### TapNPark states the original may not handle _(unknown; the original's server code isn't available)_

These come from TapNPark's own UI strings:

- "This plate already has an active session for this location", which offers **Extend Session**.
- "This plate is currently in violation status. Parking activation is no longer available."
- "This parking rate requires a passphrase to complete the order."
- Promo code rejected or not applied, so a non-zero total leads to the payment form.
- "The submitted plate is invalid."

---

## 4. Data, storage and external services

| What | Where | Notes |
|---|---|---|
| Plate, phone, promo code | Server-side, a single global record behind `GET/POST /api/config` | Storage medium unknown (a file, Replit DB, or memory) _(inferred)_. There is one profile and no history. |
| Same three values | **Hard-coded into the public JS bundle** as fallbacks | Anyone who downloads the page can read them. |
| Purchase history | Not stored | — |
| Cookies / localStorage | None used by the app (only Replit's hosting cookie) | — |

**API (no authentication on any endpoint):**

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/config` | — | `{ plate, phone, promoCode }` |
| POST | `/api/config` | `{ plate, phone, promoCode }` | ignored by the client |
| POST | `/api/park` | `{ plate, phone (digits), promoCode }` | `{ status: "complete" \| ..., message }` |

**External services:**

- **TapNPark** (Inflow, Inc.): the web app at `app.tapnpark.com`, an Expo/React Native Web app whose backend is `park.prod.inflowservice.com`. It is driven through a headless browser _(inferred from the step labels)_.
- **Google Fonts** (Inter).

**Front-end stack (from the bundle):** Vite, React 19, Tailwind, the wouter router, and TanStack Query (the client is created but unused).

---

## 5. Problems found

### Security / privacy (most serious)

1. **No access control.** The app is public. Anyone with the URL can:
   - read your plate and phone number (`GET /api/config`),
   - overwrite your saved profile (`POST /api/config`),
   - **trigger parking purchases** (`POST /api/park`).
2. Your **plate, phone and member promo code are baked into the client JS bundle**.
3. The phone placeholder is a real phone number.

### Correctness

4. **Fake progress.** The checklist is a 3.5 s timer. A failure at step 2 can still show steps 1–5 ticked.
5. **Double-purchase risk.** Nothing locks a run in flight on the server side. "Try Again" after a network error or timeout can buy a second session when the first one actually succeeded. The app also does not check for an existing active session first.
6. **Saves config before buying, and saves the phone in a different format** than it sends to the purchase endpoint.
7. A non-JSON error response (such as a timeout or proxy page) is reported as "Network error".
8. The rate/duration choice is hidden and unknown, and the promo is never confirmed as applied before checkout.

### UX / accessibility

9. Success shows no **end time**, cost or receipt. You have to wait for TapNPark's text.
10. The Buy button is silently disabled, and there are no inline validation messages. Plate and phone formats are not checked.
11. Enter doesn't submit. Labels are not linked to inputs. There are no autocomplete hints. Pinch-zoom is disabled. Some grey label text is low-contrast on the grey input background.
12. The lot code is displayed as "Q60×6xih" because of the font's contextual alternates.
13. Everything is hard-coded to one lot, one vehicle and one phone. There is no way to buy for a second car.
14. A run takes about 30 s with a spinner, and there is no cancel or timeout.

### Unknowns (need the original's server code to close)

- The exact selectors and rate choice used by the automation, its timeouts, how it detects success, and where the config is stored.

---

## 6. Proposed improvements (ranked by impact ÷ effort)

The baseline items are already planned: mobile-first layout, real form with inline validation, loading/empty states, remembered inputs, keyboard and contrast fixes, secrets in `.env`, and tests for the core logic. The items below go beyond that baseline.

| # | Improvement | Impact | Effort | Notes |
|---|---|---|---|---|
| 1 | **Lock it down.** Add a passcode login (signed httpOnly cookie) on the page and every API route, and move plate/phone/promo out of the JS bundle into server-side config. | High | Low | Closes the "anyone can buy parking or read your phone" hole. |
| 2 | **No double buys.** Add a server-side single-flight lock, an idempotency key per tap, and a check for "this plate already has an active session" before buying. | High | Low | Turns "Try Again" into a safe action. |
| 3 | **Real progress.** The server streams actual step events (SSE), so the checklist shows where it really is and exactly which step failed. Add a hard timeout and a Cancel button. | High | Low–Med | Replaces the 3.5 s fake timer. |
| 4 | **Useful confirmation.** Show the session end time, the total charged (expected $0), and the plate. Keep a screenshot of TapNPark's final screen on success and on failure. | High | Low | Makes every failure debuggable. |
| 5 | **Guard rails at checkout.** Verify the promo actually applied and the total is $0 before clicking Check Out, and stop otherwise. Give clear messages for an active session (offer *Extend*), violation status, passphrase rates and an invalid plate. | High | Med | The bot can never accidentally hit a payment page. |
| 6 | **One-tap mode.** Once your profile is saved, the home screen is one big "Park •••••••" button with Edit tucked away. Installable as a home-screen app (PWA). | Med–High | Low | Fewest clicks. |
| 7 | **Purchase history.** A short list of date, plate, end time and result. | Med | Low–Med | Needs tiny persistence (a single SQLite file). |
| 8 | **Multiple vehicles.** Saved plates as chips. Pick one and buy. | Med | Low–Med | — |
| 9 | **Faster engine (optional).** Call TapNPark's backend API directly instead of driving a headless browser: seconds instead of about 30 s, no Chromium, and it can be hosted anywhere. | High (speed) | Med–High | Undocumented private API: more likely to break and more of a Terms-of-Use grey area. Suggest this as a later experiment, kept behind the same interface. |
| 10 | **Configurable lot / duration.** Make the lot code and the rate choice settings instead of constants. | Low–Med | Low | — |
| 11 | **Scheduled buys or reminders** (for example, weekdays at 8:00). | Med | Med | Risk of paying when you didn't park. Lower priority. |

### Stack recommendation

Use a lighter stack than Next.js on Vercel: **Vite + React + TypeScript + Tailwind for the UI, plus one small Node (Express) server that runs Playwright**.

> **Decisions (2026-10-15):** No Replit. Auto-Park is public on Cloudflare Workers (auto-park.kyle-weatherly.workers.dev) with **no passcode**. To make that safe, the server stores nothing personal: each device keeps its own details in the browser.

- The core of this app is a long-running headless-Chromium job. On Vercel's serverless functions that is fragile: the Chromium bundle is large, cold starts are slow, and functions have time limits.
- The UI is a single screen, so Next.js's routing and SSR add nothing.
- If #9 (direct API) is adopted later, Vercel becomes a viable host.
- Persistence: none needed beyond the profile, unless #7 is approved. Then use one SQLite file.
