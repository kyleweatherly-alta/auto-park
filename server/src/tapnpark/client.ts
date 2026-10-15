// Thin client for the JSON API behind app.tapnpark.com.
//
// This is TapNPark's private API, reverse-engineered from their web app
// (2026-10). It is undocumented and may change without notice. Every response
// is checked against a schema so a change shows up as a clear error before
// anything is bought, rather than as a wrong purchase.

import { z } from "zod";

export const API_BASE = "https://park.prod.inflowservice.com";
export const WEB_BASE = "https://app.tapnpark.com";

export class TapNParkError extends Error {
  constructor(
    readonly path: string,
    /** TapNPark's failReason, if it sent one. */
    readonly failReason: string | null,
    readonly httpStatus: number | null,
    message?: string,
  ) {
    super(message ?? `TapNPark ${path} failed: ${failReason ?? (httpStatus ? `HTTP ${httpStatus}` : "network error")}`);
    this.name = "TapNParkError";
  }
}

/** The response didn't match what the web app expects: their API changed. */
export class ContractError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`TapNPark ${path} returned an unexpected response (${detail}). Their app may have changed.`);
    this.name = "ContractError";
  }
}

const welcomeSchema = z.object({ sessionToken: z.string().min(10) }).passthrough();

const plateSchema = z
  .object({
    alreadyPaid: z.boolean().optional().nullable(),
    alreadyPaidData: z
      .object({ canExtendSession: z.boolean().optional().nullable(), sessionID: z.string().optional().nullable() })
      .passthrough()
      .optional()
      .nullable(),
    warning: z.boolean().optional().nullable(),
    warningData: z
      .object({ cameraLotName: z.string().optional().nullable(), qrLotName: z.string().optional().nullable() })
      .passthrough()
      .optional()
      .nullable(),
    plateInConvenience: z.boolean().optional().nullable(),
  })
  .passthrough();

const rateSchema = z
  .object({
    rateID: z.string(),
    rateName: z.string(),
    label: z.string().optional().nullable(),
    rateAmount: z.number(),
    requiresPassphrase: z.boolean().optional().nullable(),
    warningMessage: z.string().optional().nullable(),
  })
  .passthrough();

const ratesSchema = z
  .object({ rates: z.array(rateSchema).nullable().optional(), noRatesMessage: z.string().optional().nullable() })
  .passthrough();

const transactionDetailsSchema = z
  .object({
    amountDue: z.number(),
    rateName: z.string().optional().nullable(),
    baseRate: z.number().optional().nullable(),
    computedDiscount: z.number().optional().nullable(),
    promoCodeRedeemCopy: z.string().optional().nullable(),
  })
  .passthrough();

const checkoutSchema = z.object({ transactionDetails: transactionDetailsSchema }).passthrough();
const promoSchema = z.object({ transactionDetails: transactionDetailsSchema.optional() }).passthrough();

const paymentIntentSchema = z
  .object({ requiresPayment: z.boolean(), stripeCheckoutLink: z.string().optional().nullable() })
  .passthrough();

const paySchema = z.object({ receiptID: z.string().min(1) }).passthrough();

const receiptSchema = z
  .object({
    receipt: z
      .object({
        startTime: z.string().optional().nullable(),
        endTime: z.string().optional().nullable(),
        amountPaid: z.number().optional().nullable(),
        locationName: z.string().optional().nullable(),
        plate: z.string().optional().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export type TapNParkRate = z.infer<typeof rateSchema>;
export type TransactionDetails = z.infer<typeof transactionDetailsSchema>;

type FetchLike = typeof fetch;

/** One anonymous TapNPark web session (the same thing scanning the lot's QR code starts). */
export class TapNParkSession {
  private token: string | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly signal?: AbortSignal,
  ) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      origin: WEB_BASE,
      referer: `${WEB_BASE}/`,
    };
    if (this.token && path !== "/welcome") headers.authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signal,
      });
    } catch (err) {
      if (this.signal?.aborted) throw err;
      throw new TapNParkError(path, null, null);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const failReason =
        json && typeof json === "object" && "failReason" in json ? String((json as { failReason: unknown }).failReason) : null;
      throw new TapNParkError(path, failReason, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ContractError(path, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body");
    }
    return parsed.data;
  }

  async welcome(lotCode: string) {
    const data = await this.post("/welcome", { qr: lotCode }, welcomeSchema);
    this.token = data.sessionToken;
    return data;
  }

  plate(plate: string) {
    return this.post("/plate", { plate }, plateSchema);
  }

  async rates() {
    const data = await this.post("/rates", undefined, ratesSchema);
    return { rates: data.rates ?? [], noRatesMessage: data.noRatesMessage ?? null };
  }

  async checkout(rateID: string) {
    return (await this.post("/checkout", { rateID, isPurchasingPass: false }, checkoutSchema)).transactionDetails;
  }

  /** Returns updated transaction details, or null if TapNPark didn't accept the code. */
  async applyPromo(promoCode: string) {
    return (await this.post("/promo", { promoCode }, promoSchema)).transactionDetails ?? null;
  }

  paymentIntent(args: { rateID: string; rateName: string; phone: string; termsAcceptedAt: string }) {
    const q = new URLSearchParams({
      isPurchasingPass: "false",
      requiresPayment: "true",
      termsAndConditionsOKTimestamp: args.termsAcceptedAt,
      rateID: args.rateID,
    });
    const cancel = new URLSearchParams({ isPurchasingPass: "false", rateID: args.rateID, rateName: args.rateName });
    return this.post(
      "/payment-intent",
      {
        cognitoIDToken: null,
        successURL: `${WEB_BASE}/purchase/confirmation?${q}`,
        cancelURL: `${WEB_BASE}/cart?${cancel}`,
        contactType: "Phone",
        email: null,
        phone: args.phone,
      },
      paymentIntentSchema,
    );
  }

  pay(args: { phone: string; termsAcceptedAt: string }) {
    return this.post(
      "/pay",
      {
        cognitoIDToken: null,
        stripeCheckoutSessionID: null,
        phoneNumber: args.phone,
        email: null,
        termsAndConditionsOKTimestamp: args.termsAcceptedAt,
      },
      paySchema,
    );
  }

  async receipt(receiptID: string) {
    return (await this.post("/receipt", { receiptID }, receiptSchema)).receipt;
  }
}
