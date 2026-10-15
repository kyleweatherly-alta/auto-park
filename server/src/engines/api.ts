// Fast engine: talks to TapNPark's JSON API directly (a few seconds, no browser).

import { formatMoney } from "../../../shared/validate.ts";
import { pickRate, shortRateName } from "../../../shared/rates.ts";
import type { Rate, RunOutcome } from "../../../shared/types.ts";
import { ContractError, TapNParkError, TapNParkSession } from "../tapnpark/client.ts";
import { EngineError, outcome, type Engine, type EngineContext, type PurchaseRequest } from "./types.ts";

const PROMO_MESSAGES: Record<string, string> = {
  InvalidCode: "TapNPark says the promo code isn't valid.",
  PromoInactive: "TapNPark says the promo code isn't active.",
  MaxUsageReached: "The promo code has reached its usage limit.",
  InvalidForRate: "The promo code can't be used with this parking time. Try a different duration.",
  InvalidForLot: "The promo code isn't valid for this lot.",
  PerCodeUserRestriction: "The promo code can't be applied because of eligibility or usage limits.",
  InvalidPassword: "The promo code needs a password.",
  MembershipRequired: "The promo code needs a TapNPark membership.",
};

export function toRate(r: { rateID: string; rateName: string; rateAmount: number; requiresPassphrase?: boolean | null }): Rate {
  return {
    rateId: r.rateID,
    name: r.rateName,
    shortName: shortRateName(r.rateName),
    amount: r.rateAmount,
    requiresPassphrase: !!r.requiresPassphrase,
  };
}

export class ApiEngine implements Engine {
  readonly name = "api" as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async unavailableReason() {
    return null;
  }

  async listRates(lotCode: string, signal?: AbortSignal): Promise<Rate[]> {
    const s = new TapNParkSession(this.fetchImpl, signal);
    await s.welcome(lotCode);
    return (await s.rates()).rates.map(toRate);
  }

  async purchase(req: PurchaseRequest, ctx: EngineContext): Promise<RunOutcome> {
    const s = new TapNParkSession(this.fetchImpl, ctx.signal);
    let committed = false;
    try {
      ctx.step("connect", "active");
      await s.welcome(req.lotCode);
      ctx.step("connect", "done");

      // Plate: TapNPark checks for an existing session and for camera/lot mismatches here.
      ctx.step("plate", "active", req.plate);
      let plate;
      try {
        plate = await s.plate(req.plate);
      } catch (err) {
        if (err instanceof TapNParkError && err.failReason === "InvalidPlate") {
          ctx.step("plate", "failed");
          return outcome("invalid_plate", `TapNPark rejected the plate ${req.plate}. Check it in Settings.`);
        }
        throw err;
      }
      if (plate.alreadyPaid) {
        ctx.step("plate", "failed", "Already parked");
        const extend = plate.alreadyPaidData?.canExtendSession ? " You can extend it in the TapNPark app." : "";
        return outcome("already_parked", `TapNPark says ${req.plate} already has an active session in this lot. Nothing was bought.${extend}`);
      }
      if (plate.warning && plate.warningData && !req.allowLotMismatch) {
        ctx.step("plate", "failed", "Lot mismatch");
        const camera = plate.warningData.cameraLotName || "another lot";
        const qr = plate.warningData.qrLotName || "this lot";
        return outcome(
          "lot_mismatch",
          `TapNPark's camera thinks your car is in ${camera}, not ${qr}. Nothing was bought. If you're sure you're in the right lot, use "Buy anyway".`,
          { detail: { cameraLot: camera, qrLot: qr } },
        );
      }
      ctx.step("plate", "done", req.plate);

      // Rate
      ctx.step("rate", "active");
      const { rates, noRatesMessage } = await s.rates();
      const rate = pickRate(rates.map((r) => ({ ...r, name: r.rateName })), req.rateName);
      if (!rate) {
        ctx.step("rate", "failed");
        const available = rates.map((r) => shortRateName(r.rateName)).join(", ");
        const msg = rates.length
          ? `"${shortRateName(req.rateName)}" isn't offered right now. Available: ${available}.`
          : `TapNPark isn't offering any rates right now.${noRatesMessage ? ` ${noRatesMessage}` : ""}`;
        return outcome("rate_unavailable", msg);
      }
      if (rate.requiresPassphrase) {
        ctx.step("rate", "failed");
        return outcome("passphrase_required", `"${shortRateName(rate.rateName)}" needs a passphrase, which Auto-Park doesn't support. Pick another duration.`);
      }
      if (rate.warningMessage) ctx.log(`TapNPark notice: ${rate.warningMessage}`);
      let details;
      try {
        details = await s.checkout(rate.rateID);
      } catch (err) {
        if (err instanceof TapNParkError && /^(sessionInViolation|SessionEnforced)$/i.test(err.failReason ?? "")) {
          ctx.step("rate", "failed");
          return outcome("violation", "TapNPark says this plate is in violation status, so it won't sell parking. Find a parking attendant.");
        }
        throw err;
      }
      const rateName = rate.rateName;
      ctx.step("rate", "done", `${shortRateName(rateName)} · ${formatMoney(rate.rateAmount)}`);

      // Promo
      let promoApplied = false;
      if (req.promoCode) {
        ctx.step("promo", "active", req.promoCode);
        try {
          const updated = await s.applyPromo(req.promoCode);
          if (!updated) {
            ctx.step("promo", "failed");
            return outcome("promo_rejected", `TapNPark didn't accept the promo code ${req.promoCode}. Nothing was bought.`, { rateName });
          }
          details = updated;
          promoApplied = true;
          ctx.step("promo", "done", details.promoCodeRedeemCopy || req.promoCode);
        } catch (err) {
          if (err instanceof TapNParkError && err.failReason && err.failReason !== "SystemError" && err.httpStatus && err.httpStatus < 500) {
            ctx.step("promo", "failed");
            const why = PROMO_MESSAGES[err.failReason] ?? `TapNPark rejected the promo code (${err.failReason}).`;
            return outcome("promo_rejected", `${why} Nothing was bought.`, { rateName });
          }
          throw err;
        }
      } else {
        ctx.step("promo", "skipped", "No promo code");
      }

      // Guard rail: never go past this point unless the total is $0.
      ctx.step("verify", "active");
      const amountDue = details.amountDue;
      if (amountDue > 0.004) {
        ctx.step("verify", "failed", `${formatMoney(amountDue)} due`);
        return outcome(
          "needs_payment",
          `The total is ${formatMoney(amountDue)}${promoApplied ? " after the promo" : ""}, not $0.00. Auto-Park stopped before paying. Check the promo code or pick another duration.`,
          { amountDue, rateName, promoApplied },
        );
      }
      ctx.step("verify", "done", formatMoney(amountDue));

      if (req.dryRun) {
        ctx.step("checkout", "skipped", "Test run");
        ctx.step("receipt", "skipped", "Test run");
        return outcome(
          "dry_run_ok",
          `Test run passed: ${shortRateName(rateName)} would cost ${formatMoney(amountDue)}${promoApplied ? ` with ${req.promoCode}` : ""}. Nothing was bought.`,
          { amountDue, rateName, promoApplied },
        );
      }

      // Checkout. From here on, failures are ambiguous: the purchase may have happened.
      ctx.step("checkout", "active");
      const termsAcceptedAt = new Date().toISOString();
      const intent = await s.paymentIntent({ rateID: rate.rateID, rateName, phone: req.phone, termsAcceptedAt });
      if (intent.requiresPayment) {
        // Never follow the card-payment link.
        ctx.step("checkout", "failed", "Payment required");
        return outcome("needs_payment", "TapNPark asked for a card payment even though the total was $0.00. Auto-Park stopped before paying.", {
          amountDue,
          rateName,
          promoApplied,
        });
      }
      if (!ctx.commit()) {
        ctx.step("checkout", "failed", "Cancelled");
        return outcome("cancelled", "Cancelled before checkout. Nothing was bought.", { rateName });
      }
      committed = true;
      let paid;
      try {
        paid = await s.pay({ phone: req.phone, termsAcceptedAt });
      } catch (err) {
        if (err instanceof TapNParkError && err.failReason === "SessionAlreadyPaid") {
          ctx.step("checkout", "failed", "Already paid");
          return outcome("already_parked", "TapNPark says this session was already paid for. Check your texts for the receipt.", {
            rateName,
            committed,
          });
        }
        throw err;
      }
      ctx.step("checkout", "done");

      // Receipt (best effort: the purchase already succeeded)
      ctx.step("receipt", "active");
      try {
        const receipt = await s.receipt(paid.receiptID);
        const endTime = receipt.endTime ?? undefined;
        ctx.step("receipt", "done", endTime);
        return outcome("success", "Parked.", {
          endTime,
          amountDue,
          amountPaid: receipt.amountPaid ?? amountDue,
          rateName,
          promoApplied,
          committed,
          detail: { receiptId: paid.receiptID, ...(receipt.locationName ? { location: receipt.locationName } : {}) },
        });
      } catch (err) {
        ctx.log(`Couldn't load the receipt: ${(err as Error).message}`);
        ctx.step("receipt", "failed", "Check your texts");
        return outcome("success", "Parked. TapNPark didn't return the end time; it's in the text receipt.", {
          amountDue,
          rateName,
          promoApplied,
          committed,
          detail: { receiptId: paid.receiptID },
        });
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (err instanceof TapNParkError || err instanceof ContractError) throw new EngineError(err.message, committed);
      throw new EngineError((err as Error).message || String(err), committed);
    }
  }
}
