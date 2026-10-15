// Simulated engine for local development, demos and tests. Never contacts TapNPark.
//
// Plates starting with these prefixes trigger specific outcomes:
//   TESTPARKED → already parked     TESTMISMATCH → camera lot mismatch
//   TESTDUE    → total isn't $0     TESTPROMO    → promo rejected
//   TESTBROKEN → engine error before checkout
//   TESTUNKNOWN → engine error after checkout (ambiguous)
// Anything else succeeds.

import { pickRate, shortRateName } from "../../../shared/rates.ts";
import type { Rate, RunOutcome } from "../../../shared/types.ts";
import { formatMoney } from "../../../shared/validate.ts";
import { EngineError, outcome, type Engine, type EngineContext, type PurchaseRequest } from "./types.ts";

export const FAKE_RATES: Rate[] = [
  ["R-3H", "MAC Member - 3 Hours", 8.8],
  ["R-4H", "MAC Member - 4 Hours", 12],
  ["R-6H", "MAC Member - 6 Hours", 15.2],
  ["R-90", "MAC Member - 90 Minutes", 4.8],
  ["R-DAY", "MAC Member - All Day (Expires 7pm)", 19.2],
].map(([rateId, name, amount]) => ({
  rateId: rateId as string,
  name: name as string,
  shortName: shortRateName(name as string),
  amount: amount as number,
  requiresPassphrase: false,
}));

/** Rough session length for a rate name, used to fake an end time. */
export function fakeEndTime(rateName: string, now = new Date()): string {
  const end = new Date(now);
  const hours = /(\d+)\s*hour/i.exec(rateName);
  const minutes = /(\d+)\s*min/i.exec(rateName);
  if (hours) end.setHours(end.getHours() + Number(hours[1]));
  else if (minutes) end.setMinutes(end.getMinutes() + Number(minutes[1]));
  else end.setHours(19, 0, 0, 0);
  return end.toISOString();
}

export class FakeEngine implements Engine {
  readonly name = "fake" as const;

  constructor(private readonly stepMs = 700) {}

  async unavailableReason() {
    return null;
  }

  async listRates(): Promise<Rate[]> {
    return FAKE_RATES;
  }

  private wait(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const t = setTimeout(resolve, this.stepMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  async purchase(req: PurchaseRequest, ctx: EngineContext): Promise<RunOutcome> {
    const p = req.plate;
    const step = async (id: Parameters<EngineContext["step"]>[0], detail?: string) => {
      ctx.step(id, "active");
      await this.wait(ctx.signal);
      ctx.step(id, "done", detail);
    };

    await step("connect");
    ctx.step("plate", "active", p);
    await this.wait(ctx.signal);
    if (p.startsWith("TESTPARKED")) {
      ctx.step("plate", "failed", "Already parked");
      return outcome("already_parked", `TapNPark says ${p} already has an active session in this lot. Nothing was bought.`);
    }
    if (p.startsWith("TESTMISMATCH") && !req.allowLotMismatch) {
      ctx.step("plate", "failed", "Lot mismatch");
      return outcome(
        "lot_mismatch",
        `TapNPark's camera thinks your car is in Broadway & Wells, not MAC Member Parking. Nothing was bought. If you're sure you're in the right lot, use "Buy anyway".`,
        { detail: { cameraLot: "Broadway & Wells", qrLot: "MAC Member Parking" } },
      );
    }
    ctx.step("plate", "done", p);

    ctx.step("rate", "active");
    await this.wait(ctx.signal);
    if (p.startsWith("TESTBROKEN")) throw new EngineError("TapNPark /rates returned an unexpected response (rates: Required). Their app may have changed.");
    const rate = pickRate(FAKE_RATES, req.rateName);
    if (!rate) {
      ctx.step("rate", "failed");
      return outcome("rate_unavailable", `"${shortRateName(req.rateName)}" isn't offered right now.`);
    }
    ctx.step("rate", "done", `${rate.shortName} · ${formatMoney(rate.amount)}`);

    if (req.promoCode) {
      ctx.step("promo", "active");
      await this.wait(ctx.signal);
      if (p.startsWith("TESTPROMO")) {
        ctx.step("promo", "failed");
        return outcome("promo_rejected", "TapNPark says the promo code isn't valid. Nothing was bought.", { rateName: rate.name });
      }
      ctx.step("promo", "done", "Applied");
    } else {
      ctx.step("promo", "skipped", "No promo code");
    }

    ctx.step("verify", "active");
    await this.wait(ctx.signal);
    const due = p.startsWith("TESTDUE") || !req.promoCode ? rate.amount : 0;
    if (due > 0) {
      ctx.step("verify", "failed", `${formatMoney(due)} due`);
      return outcome("needs_payment", `The total is ${formatMoney(due)}, not $0.00. Auto-Park stopped before paying. Check the promo code or pick another duration.`, {
        amountDue: due,
        rateName: rate.name,
        promoApplied: !!req.promoCode,
      });
    }
    ctx.step("verify", "done", "$0.00");

    if (req.dryRun) {
      ctx.step("checkout", "skipped", "Test run");
      ctx.step("receipt", "skipped", "Test run");
      return outcome("dry_run_ok", `Test run passed: ${rate.shortName} would cost $0.00 with your promo code. Nothing was bought.`, {
        amountDue: 0,
        rateName: rate.name,
        promoApplied: true,
      });
    }

    ctx.step("checkout", "active");
    await this.wait(ctx.signal);
    if (!ctx.commit()) {
      ctx.step("checkout", "failed", "Cancelled");
      return outcome("cancelled", "Cancelled before checkout. Nothing was bought.", { rateName: rate.name });
    }
    if (p.startsWith("TESTUNKNOWN")) throw new EngineError("Lost connection to TapNPark during checkout.", true);
    ctx.step("checkout", "done");
    const endTime = fakeEndTime(rate.name);
    await step("receipt", endTime);
    return outcome("success", "Parked.", {
      endTime,
      amountDue: 0,
      amountPaid: 0,
      rateName: rate.name,
      promoApplied: true,
      committed: true,
      detail: { receiptId: `FAKE-${Date.now()}` },
    });
  }
}
