import { describe, expect, it } from "vitest";
import { ApiEngine } from "../server/src/engines/api.ts";
import { EngineError } from "../server/src/engines/types.ts";
import { baseRequest, fakeContext, fakeTapNPark } from "./helpers.ts";

describe("ApiEngine", () => {
  it("buys parking end to end and reads the end time from the receipt", async () => {
    const tnp = fakeTapNPark();
    const { ctx, steps } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);

    expect(result).toMatchObject({ status: "success", endTime: "2026-10-15T22:00:00.000Z", amountPaid: 0, promoApplied: true, committed: true });
    expect(tnp.paths()).toEqual(["/welcome", "/plate", "/rates", "/checkout", "/promo", "/payment-intent", "/pay", "/receipt"]);
    // Same payloads TapNPark's own web app sends
    expect(tnp.calls[0]).toMatchObject({ body: { qr: "Q60x6xih" }, auth: null });
    expect(tnp.calls[1]).toMatchObject({ body: { plate: "ABC1234" }, auth: "Bearer token-1234567890" });
    expect(tnp.calls[3]!.body).toEqual({ rateID: "R3", isPurchasingPass: false });
    expect(tnp.calls[4]!.body).toEqual({ promoCode: "PROMO1" });
    expect(tnp.calls[5]!.body).toMatchObject({ contactType: "Phone", phone: "+14145550199", email: null });
    expect(tnp.calls[6]!.body).toMatchObject({ phoneNumber: "+14145550199", stripeCheckoutSessionID: null });
    expect(new URL(tnp.calls[5]!.body.successURL).searchParams.get("termsAndConditionsOKTimestamp")).toBe(tnp.calls[6]!.body.termsAndConditionsOKTimestamp);
    expect(steps.filter((s) => s.status === "done").map((s) => s.id)).toEqual(["connect", "plate", "rate", "promo", "verify", "checkout", "receipt"]);
  });

  it("dry run stops before anything irreversible", async () => {
    const tnp = fakeTapNPark();
    const { ctx, isCommitted } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase({ ...baseRequest, dryRun: true }, ctx);
    expect(result).toMatchObject({ status: "dry_run_ok", amountDue: 0 });
    expect(tnp.paths()).not.toContain("/payment-intent");
    expect(tnp.paths()).not.toContain("/pay");
    expect(isCommitted()).toBe(false);
  });

  it("stops before paying when the promo leaves a balance", async () => {
    const tnp = fakeTapNPark({ "/promo": () => ({ body: { transactionDetails: { amountDue: 3.5 } } }) });
    const { ctx } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);
    expect(result).toMatchObject({ status: "needs_payment", amountDue: 3.5 });
    expect(result.message).toContain("$3.50");
    expect(tnp.paths()).not.toContain("/payment-intent");
  });

  it("stops before paying when there is no promo code", async () => {
    const tnp = fakeTapNPark();
    const { ctx } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase({ ...baseRequest, promoCode: "" }, ctx);
    expect(result).toMatchObject({ status: "needs_payment", amountDue: 8.8 });
    expect(tnp.paths()).not.toContain("/promo");
    expect(tnp.paths()).not.toContain("/pay");
  });

  it("never follows a card-payment link", async () => {
    const tnp = fakeTapNPark({ "/payment-intent": () => ({ body: { requiresPayment: true, stripeCheckoutLink: "https://checkout.stripe.com/x" } }) });
    const { ctx } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);
    expect(result.status).toBe("needs_payment");
    expect(tnp.paths()).not.toContain("/pay");
  });

  it("explains a rejected promo code", async () => {
    const tnp = fakeTapNPark({ "/promo": () => ({ status: 400, body: { failReason: "MaxUsageReached" } }) });
    const { ctx } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);
    expect(result).toMatchObject({ status: "promo_rejected" });
    expect(result.message).toContain("usage limit");
  });

  it("reports an existing session instead of buying", async () => {
    const tnp = fakeTapNPark({ "/plate": () => ({ body: { alreadyPaid: true, alreadyPaidData: { canExtendSession: true, sessionID: "s1" } } }) });
    const { ctx } = fakeContext();
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);
    expect(result.status).toBe("already_parked");
    expect(result.message).toContain("extend");
    expect(tnp.paths()).toEqual(["/welcome", "/plate"]);
  });

  it("stops on a camera lot mismatch unless told to continue", async () => {
    const plate = () => ({ body: { warning: true, warningData: { cameraLotName: "Lot B", qrLotName: "MAC Member Parking" } } });
    const stopped = await new ApiEngine(fakeTapNPark({ "/plate": plate }).fetchImpl).purchase(baseRequest, fakeContext().ctx);
    expect(stopped).toMatchObject({ status: "lot_mismatch", detail: { cameraLot: "Lot B" } });

    const allowed = await new ApiEngine(fakeTapNPark({ "/plate": plate }).fetchImpl).purchase({ ...baseRequest, allowLotMismatch: true }, fakeContext().ctx);
    expect(allowed.status).toBe("success");
  });

  it("maps violation status", async () => {
    const tnp = fakeTapNPark({ "/checkout": () => ({ status: 400, body: { failReason: "sessionInViolation" } }) });
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, fakeContext().ctx);
    expect(result.status).toBe("violation");
  });

  it("refuses to guess when the chosen rate disappeared", async () => {
    const tnp = fakeTapNPark();
    const result = await new ApiEngine(tnp.fetchImpl).purchase({ ...baseRequest, rateName: "MAC Member - 9 Hours" }, fakeContext().ctx);
    expect(result.status).toBe("rate_unavailable");
    expect(result.message).toContain("3 Hours");
    expect(tnp.paths()).not.toContain("/checkout");
  });

  it("buys the chosen rate", async () => {
    const tnp = fakeTapNPark();
    await new ApiEngine(tnp.fetchImpl).purchase({ ...baseRequest, rateName: "MAC Member - All Day (Expires 7pm)" }, fakeContext().ctx);
    expect(tnp.calls.find((c) => c.path === "/checkout")!.body.rateID).toBe("RD");
  });

  it("treats an unexpected response shape as an engine error, before buying", async () => {
    const tnp = fakeTapNPark({ "/rates": () => ({ body: { rates: [{ id: 1 }] } }) });
    const err = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, fakeContext().ctx).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.committed).toBe(false);
    expect(err.message).toMatch(/unexpected response/);
  });

  it("marks failures during payment as committed (outcome unknown)", async () => {
    const tnp = fakeTapNPark({ "/pay": () => ({ body: new TypeError("socket hang up") }) });
    const err = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, fakeContext().ctx).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.committed).toBe(true);
  });

  it("still succeeds if only the receipt lookup fails", async () => {
    const tnp = fakeTapNPark({ "/receipt": () => ({ status: 500, body: { failReason: "SystemError" } }) });
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, fakeContext().ctx);
    expect(result.status).toBe("success");
    expect(result.endTime).toBeUndefined();
  });

  it("does not pay if the run was cancelled before checkout", async () => {
    const tnp = fakeTapNPark();
    const { ctx } = fakeContext({ cancelBeforeCommit: true });
    const result = await new ApiEngine(tnp.fetchImpl).purchase(baseRequest, ctx);
    expect(result.status).toBe("cancelled");
    expect(tnp.paths()).not.toContain("/pay");
  });

  it("lists rates with short names", async () => {
    const rates = await new ApiEngine(fakeTapNPark().fetchImpl).listRates("Q60x6xih");
    expect(rates.map((r) => r.shortName)).toEqual(["3 Hours", "All Day (Expires 7pm)"]);
  });
});
