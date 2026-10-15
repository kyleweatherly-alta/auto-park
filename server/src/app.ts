import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { RunEvent } from "../../shared/types.ts";
import { COOKIE_NAME, FailureLimiter, passcodeMatches, readCookie, requireAuth, sameOriginWrites, signSession, verifySession } from "./auth.ts";
import type { Config } from "./config.ts";
import type { RatesService } from "./rates.ts";
import type { RunManager } from "./runs.ts";
import { parseProfile, type Repo } from "./store/repo.ts";

export interface AppDeps {
  config: Pick<Config, "APP_PASSCODE" | "sessionSecret" | "isProduction" | "LOT_NAME">;
  repo: Repo;
  runs: RunManager;
  rates: { live: RatesService; fake: RatesService };
  /** Built web client to serve (production). */
  webDir?: string;
}

const startRunSchema = z.object({
  vehicleId: z.string().min(1),
  rateName: z.string().max(120).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
  allowLotMismatch: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(100),
});

export function createApp(deps: AppDeps) {
  const { config, repo, runs } = deps;
  const app = express();
  const limiter = new FailureLimiter();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.use("/api", express.json({ limit: "32kb" }), sameOriginWrites);
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // --- Public ----------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/session", (req, res) => {
    res.json({ authenticated: verifySession(config.sessionSecret, readCookie(req, COOKIE_NAME)) });
  });

  app.post("/api/login", (req, res) => {
    const key = req.ip ?? "unknown";
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      res.status(429).json({ error: "too_many_attempts", message: `Too many wrong passcodes. Try again in ${Math.ceil(wait / 60000)} min.` });
      return;
    }
    const passcode = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    if (!passcode || !passcodeMatches(config.sessionSecret, config.APP_PASSCODE, passcode)) {
      limiter.fail(key);
      res.status(401).json({ error: "wrong_passcode", message: "That passcode isn't right." });
      return;
    }
    limiter.reset(key);
    const { token, expires } = signSession(config.sessionSecret);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: config.isProduction, sameSite: "lax", expires, path: "/" });
    res.status(204).end();
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(204).end();
  });

  // --- Everything below needs the passcode -----------------------------------
  app.use("/api", requireAuth(config.sessionSecret));

  app.get("/api/status", async (_req, res) => {
    res.json(await runs.status());
  });

  app.get("/api/profile", async (_req, res) => {
    res.json(await repo.getProfile());
  });

  app.put("/api/profile", async (req, res) => {
    const parsed = parseProfile(req.body);
    if (!parsed.ok) {
      res.status(422).json({ error: "invalid", message: "Please fix the highlighted fields.", fields: parsed.errors });
      return;
    }
    await repo.saveProfile(parsed.profile);
    res.json(parsed.profile);
  });

  app.get("/api/rates", async (_req, res) => {
    const profile = await repo.getProfile();
    const svc = profile.engine === "fake" ? deps.rates.fake : deps.rates.live;
    try {
      res.json({ rates: await svc.get() });
    } catch (err) {
      res.status(502).json({ error: "rates_unavailable", message: `Couldn't load parking times from TapNPark. ${(err as Error).message}` });
    }
  });

  app.get("/api/runs", async (_req, res) => {
    res.json({ runs: (await repo.listRuns()).slice(0, 50) });
  });

  app.post("/api/runs", async (req, res) => {
    const body = startRunSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Invalid request." });
      return;
    }
    const result = await runs.start(body.data);
    if (result.ok) {
      res.status(result.existing ? 200 : 202).json({ run: result.run });
    } else if (result.code === "busy") {
      res.status(409).json({ error: "busy", message: "A purchase is already in progress.", run: result.run });
    } else if (result.code === "already_parked") {
      res.status(409).json({ error: "already_parked", message: result.message, until: result.until });
    } else if (result.code === "maybe_parked") {
      res.status(409).json({ error: "maybe_parked", message: result.message });
    } else {
      res.status(422).json({ error: "invalid", message: result.message });
    }
  });

  app.get("/api/runs/:id", async (req, res) => {
    const run = await runs.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "not_found", message: "Run not found." });
      return;
    }
    res.json({ run });
  });

  app.post("/api/runs/:id/cancel", (req, res) => {
    const result = runs.cancel(req.params.id);
    if (result.ok) {
      res.status(202).json({ ok: true });
    } else if (result.code === "too_late") {
      res.status(409).json({ error: "too_late", message: "Checkout has already started, so it can't be cancelled." });
    } else {
      res.status(409).json({ error: "not_running", message: "That run isn't in progress." });
    }
  });

  app.get("/api/runs/:id/screenshot", async (req, res) => {
    const run = await runs.getRun(req.params.id);
    if (!run?.hasScreenshot) {
      res.status(404).json({ error: "not_found", message: "No screenshot for this run." });
      return;
    }
    try {
      const png = await readFile(runs.screenshotPath(run.id));
      res.type("png").send(png);
    } catch {
      res.status(404).json({ error: "not_found", message: "The screenshot has been cleaned up." });
    }
  });

  // Live progress as Server-Sent Events.
  app.get("/api/runs/:id/events", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (e: RunEvent) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === "done") res.end();
    };
    const unsubscribe = await runs.subscribe(req.params.id, send);
    if (!unsubscribe) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Run not found." })}\n\n`);
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found", message: "Not found." });
  });

  // --- Web client ------------------------------------------------------------
  if (deps.webDir && existsSync(deps.webDir)) {
    const index = path.join(deps.webDir, "index.html");
    app.use(express.static(deps.webDir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(index);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: "bad_request", message: "Invalid JSON." });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "server_error", message: "Something went wrong on the server." });
  });

  return app;
}
