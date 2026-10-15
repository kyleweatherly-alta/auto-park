import type { StepId, StepStatus } from "../shared/types.ts";
import type { EngineContext } from "../server/src/engines/types.ts";

type Handler = (body: any) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export const RATES = [
  { rateID: "R3", rateName: "MAC Member - 3 Hours", label: "MAC Member - 3 Hours", rateAmount: 8.8, requiresPassphrase: false, warningMessage: null },
  { rateID: "RD", rateName: "MAC Member - All Day (Expires 7pm)", label: "MAC Member - All Day (Expires 7pm)", rateAmount: 19.2, requiresPassphrase: false, warningMessage: null },
];

/** A scripted stand-in for TapNPark's API. Override any path per test. */
export function fakeTapNPark(overrides: Record<string, Handler> = {}) {
  const calls: { path: string; body: any; auth: string | null }[] = [];
  const handlers: Record<string, Handler> = {
    "/welcome": () => ({ body: { sessionToken: "token-1234567890", uiModules: [] } }),
    "/plate": () => ({ body: { alreadyPaid: false, warning: false, plateInConvenience: false } }),
    "/rates": () => ({ body: { rates: RATES, noRatesMessage: "Call the lot" } }),
    "/checkout": (b) => ({ body: { transactionDetails: { amountDue: b.rateID === "RD" ? 19.2 : 8.8, rateName: "x" } } }),
    "/promo": () => ({ body: { transactionDetails: { amountDue: 0, computedDiscount: 8.8, promoCodeRedeemCopy: "MAC validation" } } }),
    "/payment-intent": () => ({ body: { requiresPayment: false } }),
    "/pay": () => ({ body: { receiptID: "rcpt-1" } }),
    "/receipt": () => ({ body: { receipt: { endTime: "2026-10-15T22:00:00.000Z", amountPaid: 0, locationName: "MAC Member Parking", plate: "ABC1234" } } }),
    ...overrides,
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, body, auth: headers.authorization ?? null });
    const h = handlers[path];
    if (!h) return new Response("not found", { status: 404 });
    const r = await h(body);
    if (r.body instanceof Error) throw r.body;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls, paths: () => calls.map((c) => c.path) };
}

export function fakeContext(opts: { cancelBeforeCommit?: boolean } = {}) {
  const controller = new AbortController();
  const steps: { id: StepId; status: StepStatus; detail?: string }[] = [];
  const logs: string[] = [];
  let committed = false;
  const ctx: EngineContext = {
    signal: controller.signal,
    step: (id, status, detail) => steps.push({ id, status, detail }),
    log: (m) => logs.push(m),
    commit: () => {
      if (opts.cancelBeforeCommit) return false;
      committed = true;
      return true;
    },
    saveScreenshot: async () => {},
  };
  return { ctx, steps, logs, controller, isCommitted: () => committed };
}

export const baseRequest = {
  lotCode: "Q60x6xih",
  plate: "ABC1234",
  phone: "+14145550199",
  promoCode: "PROMO1",
  rateName: "MAC Member - 3 Hours",
  dryRun: false,
  allowLotMismatch: false,
};
