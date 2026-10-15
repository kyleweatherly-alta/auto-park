// Browser engine: drives app.tapnpark.com in headless Chromium, the way a
// person would. Slower (~4 s vs ~1.5 s) but it doesn't depend on TapNPark's private
// API staying the same, only on their screens. Values like the total and the
// end time are read from the app's own API responses as they go by, which is
// more reliable than scraping text.

import { existsSync } from "node:fs";
import type { Browser, Locator, Page, Response } from "playwright";
import { pickRate, shortRateName } from "../../../shared/rates.ts";
import type { RunOutcome } from "../../../shared/types.ts";
import { formatMoney } from "../../../shared/validate.ts";
import { API_BASE, WEB_BASE } from "../tapnpark/client.ts";
import { EngineError, outcome, type Engine, type EngineContext, type PurchaseRequest } from "./types.ts";

const STEP_TIMEOUT = 25_000;
const CHECKOUT_TIMEOUT = 45_000;

type Playwright = typeof import("playwright");

async function loadPlaywright(): Promise<Playwright | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

const apiHost = new URL(API_BASE).host;
const isApi = (path: string) => (r: Response) => {
  if (r.request().method() !== "POST") return false;
  const u = new URL(r.url());
  return u.host === apiHost && u.pathname === path;
};

async function json(r: Response | null): Promise<{ status: number; body: any } | null> {
  if (!r) return null;
  try {
    return { status: r.status(), body: await r.json() };
  } catch {
    return { status: r.status(), body: null };
  }
}

/** Resolve with the key of whichever locator becomes visible first. */
async function waitForAny<K extends string>(options: Record<K, Locator>, timeout: number, what: string, committed = false): Promise<K> {
  const entries = Object.entries(options) as [K, Locator][];
  try {
    return await Promise.any(entries.map(([k, loc]) => loc.first().waitFor({ state: "visible", timeout }).then(() => k)));
  } catch {
    throw new EngineError(`Timed out waiting for ${what} on TapNPark. Their screens may have changed.`, committed);
  }
}

export class BrowserEngine implements Engine {
  readonly name = "browser" as const;

  constructor(private readonly executablePath?: string) {}

  async unavailableReason() {
    const pw = await loadPlaywright();
    if (!pw) return "Playwright isn't installed.";
    try {
      const exe = this.executablePath || pw.chromium.executablePath();
      if (!existsSync(exe)) return `Chromium isn't installed (${exe}). Run: npm run install:browser`;
    } catch {
      return "Chromium isn't installed. Run: npm run install:browser";
    }
    return null;
  }

  async purchase(req: PurchaseRequest, ctx: EngineContext): Promise<RunOutcome> {
    const pw = await loadPlaywright();
    if (!pw) throw new EngineError("Playwright isn't installed.");
    const browser: Browser = await pw.chromium.launch({ headless: true, executablePath: this.executablePath || undefined });
    const onAbort = () => void browser.close().catch(() => {});
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, locale: "en-US" });
    page.setDefaultTimeout(STEP_TIMEOUT);
    let committed = false;
    const tracked: EngineContext = {
      ...ctx,
      commit: () => (committed = ctx.commit()),
    };
    try {
      return await this.run(page, req, tracked);
    } catch (err) {
      if (ctx.signal.aborted || err instanceof EngineError) throw err;
      // Playwright timeouts etc. Keep the first line; the rest is a call log.
      const msg = ((err as Error).message || String(err)).split("\n")[0];
      throw new EngineError(`Browser automation failed: ${msg}`, committed);
    } finally {
      try {
        await ctx.saveScreenshot(await page.screenshot({ fullPage: true }));
      } catch {
        // page already closed (e.g. cancelled)
      }
      ctx.signal.removeEventListener("abort", onAbort);
      await browser.close().catch(() => {});
    }
  }

  private async run(page: Page, req: PurchaseRequest, ctx: EngineContext): Promise<RunOutcome> {
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const text = (t: string | RegExp) => page.getByText(t);

    // 1. Open the lot (same URL the QR code on the sign opens)
    ctx.step("connect", "active");
    await page.goto(`${WEB_BASE}/?qr=${encodeURIComponent(req.lotCode)}`, { waitUntil: "domcontentloaded" });
    await waitForAny({ buy: button("Buy Parking") }, STEP_TIMEOUT, "the Buy Parking button");
    await button("Buy Parking").click();
    await page.getByPlaceholder("ABC123").waitFor();
    ctx.step("connect", "done");

    // 2. Plate + phone
    ctx.step("plate", "active", req.plate);
    await page.getByPlaceholder("ABC123").fill(req.plate);
    let tel = page.locator('input[type="tel"]');
    if (!(await tel.count())) {
      await text(/Phone Instead\?/).first().click();
      tel = page.locator('input[type="tel"]');
    }
    await tel.first().click();
    await tel.first().press("ControlOrMeta+a");
    await tel.first().pressSequentially(req.phone, { delay: 15 });
    const typed = (await tel.first().inputValue()).replace(/\D/g, "");
    if (!typed.endsWith(req.phone.slice(-10))) {
      await tel.first().fill(req.phone);
    }
    const ratesResponse = page.waitForResponse(isApi("/rates"), { timeout: STEP_TIMEOUT * 2 }).catch(() => null);
    const [plateRes] = await Promise.all([
      page.waitForResponse(isApi("/plate"), { timeout: STEP_TIMEOUT }).catch(() => null),
      button("Agree and Continue").click(),
    ]);
    const plateData = await json(plateRes);
    if (plateData && plateData.status >= 400) {
      ctx.step("plate", "failed");
      if (plateData.body?.failReason === "InvalidPlate") {
        return outcome("invalid_plate", `TapNPark rejected the plate ${req.plate}. Check it in Settings.`);
      }
      throw new EngineError(`TapNPark /plate failed (${plateData.body?.failReason ?? plateData.status}).`);
    }
    const next = await waitForAny(
      {
        confirm: button("Confirm Plate"),
        parked: text("You already have an active session"),
        mismatch: text("Lot Mismatch Detected"),
        rates: text("Parking Rates"),
        fieldError: text(/^The plate must|^Please enter a valid/),
      },
      STEP_TIMEOUT,
      "the plate check",
    );
    if (next === "fieldError") {
      ctx.step("plate", "failed");
      return outcome("invalid_plate", `TapNPark rejected the plate ${req.plate}. Check it in Settings.`);
    }
    if (next === "parked") {
      ctx.step("plate", "failed", "Already parked");
      return outcome("already_parked", `TapNPark says ${req.plate} already has an active session in this lot. Nothing was bought.`);
    }
    if (next === "mismatch") {
      const camera = plateData?.body?.warningData?.cameraLotName || "another lot";
      const qr = plateData?.body?.warningData?.qrLotName || "this lot";
      if (!req.allowLotMismatch) {
        ctx.step("plate", "failed", "Lot mismatch");
        return outcome(
          "lot_mismatch",
          `TapNPark's camera thinks your car is in ${camera}, not ${qr}. Nothing was bought. If you're sure you're in the right lot, use "Buy anyway".`,
          { detail: { cameraLot: camera, qrLot: qr } },
        );
      }
      await button("Proceed Anyways").click();
      await button("Confirm Plate")
        .click({ timeout: 5_000 })
        .catch(() => {});
    }
    if (next === "confirm") await button("Confirm Plate").click();
    await text("Parking Rates").first().waitFor();
    ctx.step("plate", "done", req.plate);

    // 3. Rate
    ctx.step("rate", "active");
    const ratesData = await json(await ratesResponse);
    const rates: any[] = Array.isArray(ratesData?.body?.rates) ? ratesData!.body.rates : [];
    if (!rates.length) throw new EngineError("Couldn't read the rate list from TapNPark.");
    const rate = pickRate(
      rates.map((r) => ({ ...r, name: String(r.rateName) })),
      req.rateName,
    );
    if (!rate) {
      ctx.step("rate", "failed");
      const available = rates.map((r) => shortRateName(String(r.rateName))).join(", ");
      return outcome("rate_unavailable", `"${shortRateName(req.rateName)}" isn't offered right now. Available: ${available}.`);
    }
    if (rate.requiresPassphrase) {
      ctx.step("rate", "failed");
      return outcome("passphrase_required", `"${shortRateName(rate.name)}" needs a passphrase, which Auto-Park doesn't support. Pick another duration.`);
    }
    const checkoutResponse = page.waitForResponse(isApi("/checkout"), { timeout: STEP_TIMEOUT }).catch(() => null);
    await text(String(rate.label ?? rate.rateName))
      .first()
      .click();
    if (rate.warningMessage) {
      ctx.log(`TapNPark notice: ${rate.warningMessage}`);
      await button("Proceed").click();
    }
    const checkoutData = await json(await checkoutResponse);
    if (!checkoutData) throw new EngineError("TapNPark didn't load the cart.");
    if (checkoutData.status >= 400) {
      ctx.step("rate", "failed");
      if (/^(sessionInViolation|SessionEnforced)$/i.test(checkoutData.body?.failReason ?? "")) {
        return outcome("violation", "TapNPark says this plate is in violation status, so it won't sell parking. Find a parking attendant.");
      }
      throw new EngineError(`TapNPark /checkout failed (${checkoutData.body?.failReason ?? checkoutData.status}).`);
    }
    let amountDue = Number(checkoutData.body?.transactionDetails?.amountDue);
    await text("Due Today:").first().waitFor();
    ctx.step("rate", "done", `${shortRateName(rate.name)} · ${formatMoney(Number(rate.rateAmount))}`);

    // 4. Promo
    let promoApplied = false;
    if (req.promoCode) {
      ctx.step("promo", "active", req.promoCode);
      await page.getByPlaceholder("CODE").fill(req.promoCode);
      const [promoRes] = await Promise.all([
        page.waitForResponse(isApi("/promo"), { timeout: STEP_TIMEOUT }).catch(() => null),
        button("Apply").click(),
      ]);
      const promoData = await json(promoRes);
      const td = promoData?.body?.transactionDetails;
      if (!promoData || promoData.status >= 400 || !td) {
        ctx.step("promo", "failed");
        const reason = promoData?.body?.failReason ? ` (${promoData.body.failReason})` : "";
        return outcome("promo_rejected", `TapNPark didn't accept the promo code ${req.promoCode}${reason}. Nothing was bought.`, { rateName: rate.name });
      }
      await text(/applied!/).first().waitFor();
      amountDue = Number(td.amountDue);
      promoApplied = true;
      ctx.step("promo", "done", td.promoCodeRedeemCopy || req.promoCode);
    } else {
      ctx.step("promo", "skipped", "No promo code");
    }

    // 5. Guard rail: the total from the API *and* on screen must both be $0.
    ctx.step("verify", "active");
    const dueRow = await text("Due Today:").first().locator("xpath=..").innerText().catch(() => "");
    const shown = Number(/\$\s*([\d,]+(?:\.\d+)?)/.exec(dueRow)?.[1]?.replace(/,/g, "") ?? NaN);
    const due = Number.isFinite(amountDue) ? amountDue : shown;
    if (!Number.isFinite(due) || due > 0.004 || (Number.isFinite(shown) && shown > 0.004)) {
      const amount = Number.isFinite(due) ? Math.max(due, Number.isFinite(shown) ? shown : 0) : NaN;
      ctx.step("verify", "failed", Number.isFinite(amount) ? `${formatMoney(amount)} due` : "Unknown total");
      return outcome(
        "needs_payment",
        Number.isFinite(amount)
          ? `The total is ${formatMoney(amount)}${promoApplied ? " after the promo" : ""}, not $0.00. Auto-Park stopped before paying. Check the promo code or pick another duration.`
          : "Couldn't confirm the total is $0.00, so Auto-Park stopped before paying.",
        { amountDue: Number.isFinite(amount) ? amount : undefined, rateName: rate.name, promoApplied },
      );
    }
    ctx.step("verify", "done", formatMoney(0));

    if (req.dryRun) {
      ctx.step("checkout", "skipped", "Test run");
      ctx.step("receipt", "skipped", "Test run");
      return outcome(
        "dry_run_ok",
        `Test run passed: ${shortRateName(rate.name)} would cost $0.00${promoApplied ? ` with ${req.promoCode}` : ""}. Nothing was bought.`,
        { amountDue: 0, rateName: rate.name, promoApplied },
      );
    }

    // 6. Checkout (irreversible)
    ctx.step("checkout", "active");
    if (!ctx.commit()) {
      ctx.step("checkout", "failed", "Cancelled");
      return outcome("cancelled", "Cancelled before checkout. Nothing was bought.", { rateName: rate.name });
    }
    const receiptResponse = page.waitForResponse(isApi("/receipt"), { timeout: CHECKOUT_TIMEOUT }).catch(() => null);
    await button("Checkout").click();
    const result = await waitForAny(
      {
        done: text("Checkout Complete!"),
        payment: text("Loading payment form..."),
        alreadyPaid: text("This session has already been paid for."),
      },
      CHECKOUT_TIMEOUT,
      "the checkout confirmation",
      true,
    );
    if (result === "payment" || page.url().includes("stripe.com")) {
      // Never fill in a card. Leaving now means nothing is charged.
      ctx.step("checkout", "failed", "Payment required");
      return outcome("needs_payment", "TapNPark asked for a card payment even though the total was $0.00. Auto-Park stopped before paying.", {
        amountDue: 0,
        rateName: rate.name,
        promoApplied,
      });
    }
    if (result === "alreadyPaid") {
      ctx.step("checkout", "failed", "Already paid");
      return outcome("already_parked", "TapNPark says this session was already paid for. Check your texts for the receipt.", {
        rateName: rate.name,
        committed: true,
      });
    }
    ctx.step("checkout", "done");

    // 7. Receipt
    ctx.step("receipt", "active");
    const receiptData = await json(await receiptResponse);
    const receipt = receiptData?.body?.receipt;
    const endTime: string | undefined = receipt?.endTime ?? undefined;
    ctx.step("receipt", endTime ? "done" : "failed", endTime ?? "Check your texts");
    return outcome("success", endTime ? "Parked." : "Parked. The end time is in TapNPark's text receipt.", {
      endTime,
      amountDue: 0,
      amountPaid: typeof receipt?.amountPaid === "number" ? receipt.amountPaid : 0,
      rateName: rate.name,
      promoApplied,
      committed: true,
      detail: receipt?.locationName ? { location: String(receipt.locationName) } : undefined,
    });
  }
}
