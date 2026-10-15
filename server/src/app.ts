import { Hono, type Context } from "hono";
import { z } from "zod";
import type { EngineMode, RunEvent } from "../../shared/types.ts";
import { normalizeNickname, normalizePhone, normalizePlate, normalizePromo } from "../../shared/validate.ts";
import { RateLimiter } from "./limits.ts";
import type { RatesService } from "./rates.ts";
import type { RunManager } from "./runs.ts";

export interface AppDeps {
  lotName: string;
  /** Purchase methods this deployment can run. */
  engines: EngineMode[];
  defaultEngine: EngineMode;
  runs: RunManager;
  rates: { live: RatesService; fake: RatesService };
  runsPerHour: number;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const startRunSchema = z.object({
  plate: z.string().max(40),
  phone: z.string().max(40),
  promoCode: z.string().max(60).default(""),
  rateName: z.string().max(120).optional(),
  vehicleName: z.string().max(60).optional(),
  engine: z.enum(["auto", "api", "browser", "fake"]).optional(),
  dryRun: z.boolean().optional(),
  allowLotMismatch: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(100),
});

function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function err(c: Context, status: 400 | 403 | 404 | 409 | 422 | 429 | 502, error: string, message: string, extra: object = {}) {
  return c.json({ error, message, ...extra }, status);
}

/** The JSON API. Public by design: it stores nothing personal and acts only on details sent with each request. */
export function createApi(deps: AppDeps) {
  const { runs } = deps;
  const limiter = new RateLimiter(deps.runsPerHour, 60 * 60 * 1000);
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    // Other websites can't start purchases from a visitor's browser.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === new URL(c.req.url).host;
        } catch {
          ok = false;
        }
        if (!ok) return err(c, 403, "bad_origin", "Request blocked.");
      }
    }
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    c.header("Cache-Control", "no-store");
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/status", (c) => c.json({ lotName: deps.lotName, engines: deps.engines, defaultEngine: deps.defaultEngine }));

  app.get("/api/rates", async (c) => {
    const svc = c.req.query("engine") === "fake" ? deps.rates.fake : deps.rates.live;
    try {
      return c.json({ rates: await svc.get() });
    } catch (e) {
      return err(c, 502, "rates_unavailable", `Couldn't load parking times from TapNPark. ${(e as Error).message}`);
    }
  });

  app.post("/api/runs", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "bad_request", "Invalid JSON.");
    }
    const body = startRunSchema.safeParse(raw);
    if (!body.success) return err(c, 400, "bad_request", "Invalid request.");
    const b = body.data;

    const fields: Record<string, string> = {};
    const plate = normalizePlate(b.plate);
    if (!plate.ok) fields.plate = plate.error;
    const phone = normalizePhone(b.phone);
    if (!phone.ok) fields.phone = phone.error;
    const promo = normalizePromo(b.promoCode);
    if (!promo.ok) fields.promoCode = promo.error;
    const nick = normalizeNickname(b.vehicleName ?? "");
    if (Object.keys(fields).length) return err(c, 422, "invalid", "Check your details in Settings.", { fields });

    const engine = b.engine ?? deps.defaultEngine;
    if (!deps.engines.includes(engine)) {
      return err(c, 422, "engine_unavailable", "That purchase method isn't available here. Pick another one in Settings.");
    }

    const wait = limiter.take(clientIp(c));
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return err(c, 429, "rate_limited", `Too many purchases started from here. Try again in ${Math.ceil(wait / 60000)} min.`);
    }

    const result = runs.start({
      plate: plate.ok ? plate.value : "",
      phone: phone.ok ? phone.value : "",
      promoCode: promo.ok ? promo.value : "",
      rateName: (b.rateName ?? "").trim(),
      vehicleName: nick.ok ? nick.value : "",
      engine,
      dryRun: !!b.dryRun,
      allowLotMismatch: !!b.allowLotMismatch,
      idempotencyKey: b.idempotencyKey,
    });
    if (result.ok) return c.json({ run: result.run }, result.existing ? 200 : 202);
    if (result.code === "busy") return err(c, 409, "busy", "A purchase for this plate is already in progress.", { run: result.run });
    return err(c, 429, "too_many", result.message);
  });

  app.get("/api/runs/:id", (c) => {
    const run = runs.getRun(c.req.param("id"));
    return run ? c.json({ run }) : err(c, 404, "not_found", "This purchase is no longer on the server.");
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const result = runs.cancel(c.req.param("id"));
    if (result.ok) return c.json({ ok: true }, 202);
    if (result.code === "too_late") return err(c, 409, "too_late", "Checkout has already started, so it can't be cancelled.");
    return err(c, 409, "not_running", "That purchase isn't in progress.");
  });

  app.get("/api/runs/:id/screenshot", async (c) => {
    const png = await runs.readScreenshot(c.req.param("id"));
    if (!png) return err(c, 404, "not_found", "No screenshot for this purchase.");
    return c.body(png as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "image/png" });
  });

  // Live progress as Server-Sent Events.
  app.get("/api/runs/:id/events", (c) => {
    const id = c.req.param("id");
    const enc = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe?.();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          if (!closed) controller.enqueue(enc.encode(text));
        };
        const send = (e: RunEvent) => {
          write(`data: ${JSON.stringify(e)}\n\n`);
          if (e.type === "done" && !closed) {
            cleanup();
            controller.close();
          }
        };
        unsubscribe = runs.subscribe(id, send);
        if (!unsubscribe) {
          write(`event: gone\ndata: ${JSON.stringify({ message: "This purchase is no longer on the server." })}\n\n`);
          cleanup();
          controller.close();
          return;
        }
        if (!closed) heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.all("/api/*", (c) => err(c, 404, "not_found", "Not found."));

  app.onError((e, c) => {
    console.error(e);
    return c.json({ error: "server_error", message: "Something went wrong on the server." }, 500);
  });

  return app;
}
