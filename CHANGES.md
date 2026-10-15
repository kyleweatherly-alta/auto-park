# What changed from the original

The original is at https://auto-park-filler.replit.app; [SPEC.md](SPEC.md) describes it. Auto-Park 2.0 is a fresh codebase. The original's server code wasn't available, so the TapNPark automation was rebuilt from TapNPark's own web app.

## Security and privacy

| Before | Now |
|---|---|
| Anyone with the URL could read your plate and phone, change them, or **buy parking**. | Every API route needs a passcode login: a signed, httpOnly cookie that lasts 90 days. Wrong guesses are rate-limited. |
| Plate, phone and promo code were hard-coded in the public JavaScript. | They live only in server-side config and storage. The built client contains none of them (checked). |
| — | Security headers (CSP, no framing), cross-site write protection, no third-party fonts. |

## Correctness and safety

| Before | Now |
|---|---|
| The progress checklist was a 3.5 s timer. | Real progress, streamed from the server step by step. Reloading or reopening the page picks up where it was. |
| "Try Again" could buy a second session. | One purchase at a time, a repeated tap is ignored, and it asks first if the plate is already parked or a recent result was unclear. |
| Saved your inputs before buying, even if the purchase failed. | Choices are saved only when you save them or start a purchase. |
| Hidden duration choice; promo never checked. | You pick the time (live list from TapNPark), and the app **stops unless the total is $0.00** after the promo. It never follows a card-payment page. |
| No handling of TapNPark's special cases. | Clear messages for: already parked, camera lot mismatch (with "Buy anyway"), violation status, promo rejected (with the reason), passphrase rates, invalid plate, time no longer offered. |
| No timeout or cancel. | Cancel works up to checkout. A 2-minute timeout stops a stuck run before it buys. A failure during checkout is reported honestly as "check your texts". |
| Success said only "Complete!". | Shows **"Parked until 5:12 PM"**, time left, the time bought, and the amount paid. The browser engine also keeps a screenshot. |

## Speed

- **Fast engine (new):** calls TapNPark's API directly. A full test run against TapNPark (up to the checkout step) took **1.5 s**.
- **Browser engine:** the same test took **4.2 s**. The original showed a ~28 s fake progress timer; its real speed is unknown.
- **Automatic mode:** if the fast engine hits something unexpected before checkout, the browser engine finishes the job.

## Fewer taps

- Home screen is one big **Park ‹your plate›** button. The vehicle and time you used last are remembered.
- Multiple vehicles, chosen with one tap.
- History of every purchase and test run.
- **Test run** goes through everything except checkout. Use it to confirm the promo still works.

## Mobile and accessibility

- Built for phones first: large touch targets, safe-area padding, and pinch-zoom allowed (the original blocked it).
- Real form semantics: labels are tied to their inputs, Enter submits, inline validation messages, and focus moves to the first problem.
- Keyboard-accessible chips and dialogs, an announced progress area, and AA-contrast text.
- Fixed the lot code rendering as "Q60×6xih".

## Not verified yet

- **A real purchase hasn't been made with the new app.** Both engines passed a live test run against TapNPark on 2026-10-15 (your plate, 3 Hours, your member promo code → TapNPark's cart showed "Due Today $0", stopped before Checkout). The checkout step itself (`/payment-intent`, `/pay`, the receipt and end time) has only been exercised in simulation and unit tests.
- Only the 3 Hours rate was tested with your promo code. Use **Settings → Run a test** after picking another default time to check it before relying on it.
