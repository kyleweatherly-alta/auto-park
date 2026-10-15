import { describe, expect, it } from "vitest";
import { createApi } from "../server/src/app.ts";
import { FakeEngine } from "../server/src/engines/fake.ts";
import { UnavailableEngine } from "../server/src/engines/unavailable.ts";
import { RateLimiter } from "../server/src/limits.ts";
import { RatesService } from "../server/src/rates.ts";
import { RunManager } from "../server/src/runs.ts";
import { MemoryScreenshots } from "../server/src/screenshots.ts";

function makeApp(over: { runsPerHour?: number } = {}) {
  const fake = new FakeEngine(1);
  const runs = new RunManager({
    engines: { api: fake, browser: new UnavailableEngine("browser", "not here"), fake } as never,
    lotCode: "Q60x6xih",
    timeoutMs: 5000,
    screenshots: new MemoryScreenshots(),
    log: () => {},
  });
  const rates = new RatesService("Q60x6xih", () => fake);
  return createApi({
    lotName: "MAC Member Parking",
    engines: ["api", "fake"],
    defaultEngine: "fake",
    runs,
    rates: { live: rates, fake: rates },
    runsPerHour: over.runsPerHour ?? 30,
  });
}

const details = { plate: "abc 1234", phone: "(414) 555-0199", promoCode: "promo1" };
let n = 0;
const key = () => `test-key-${++n}-xxxx`;
const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

describe("public API", () => {
  it("needs no login and says which purchase methods it supports", async () => {
    const app = makeApp();
    expect((await app.request("/api/health")).status).toBe(200);
    expect(await (await app.request("/api/status")).json()).toEqual({ lotName: "MAC Member Parking", engines: ["api", "fake"], defaultEngine: "fake" });
  });

  it("sends security headers and no-store on API responses", async () => {
    const res = await makeApp().request("/api/status");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("runs a purchase from details in the request, streams progress, and keeps no phone or promo", async () => {
    const app = makeApp();
    const res = await post(app, "/api/runs", { ...details, engine: "fake", idempotencyKey: key() });
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run).toMatchObject({ plate: "ABC1234", status: "running" });

    const events = await readEvents(await app.request(`/api/runs/${run.id}/events`));
    expect(events[0].type).toBe("snapshot");
    expect(events.at(-1)).toMatchObject({ type: "done", run: { status: "success" } });

    const after = await (await app.request(`/api/runs/${run.id}`)).json();
    expect(after.run.status).toBe("success");
    const everything = JSON.stringify(events) + JSON.stringify(after);
    expect(everything).not.toContain("5550199");
    expect(everything).not.toContain("PROMO1");
  });

  it("validates details with field-level messages", async () => {
    const res = await post(makeApp(), "/api/runs", { plate: "!!", phone: "123", promoCode: "a b", idempotencyKey: key() });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.fields).sort()).toEqual(["phone", "plate", "promoCode"]);
  });

  it("rejects malformed requests", async () => {
    const app = makeApp();
    expect((await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" })).status).toBe(400);
    expect((await post(app, "/api/runs", { plate: "ABC1234" })).status).toBe(400);
  });

  it("refuses purchase methods this server can't run", async () => {
    const res = await post(makeApp(), "/api/runs", { ...details, engine: "browser", idempotencyKey: key() });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("engine_unavailable");
  });

  it("blocks purchases started from other websites", async () => {
    const res = await post(makeApp(), "/api/runs", { ...details, engine: "fake", idempotencyKey: key() }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("allows one purchase per plate at a time", async () => {
    const app = makeApp();
    const first = await post(app, "/api/runs", { ...details, engine: "fake", idempotencyKey: key() });
    expect(first.status).toBe(202);
    const second = await post(app, "/api/runs", { ...details, engine: "fake", idempotencyKey: key() });
    expect(second.status).toBe(409);
    expect((await second.json()).run.id).toBe((await first.json()).run.id);
  });

  it("rate-limits each visitor", async () => {
    const app = makeApp({ runsPerHour: 2 });
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (const plate of ["AAA111", "BBB222"]) {
      expect((await post(app, "/api/runs", { ...details, plate, engine: "fake", idempotencyKey: key() }, ip)).status).toBe(202);
    }
    const third = await post(app, "/api/runs", { ...details, plate: "CCC333", engine: "fake", idempotencyKey: key() }, ip);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    // A different visitor isn't affected.
    expect((await post(app, "/api/runs", { ...details, plate: "DDD444", engine: "fake", idempotencyKey: key() }, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(202);
  });

  it("answers 404 for runs it doesn't have, including the event stream", async () => {
    const app = makeApp();
    expect((await app.request("/api/runs/nope")).status).toBe(404);
    const text = await (await app.request("/api/runs/nope/events")).text();
    expect(text).toContain("event: gone");
  });

  it("lists rates", async () => {
    const { rates } = await (await makeApp().request("/api/rates?engine=fake")).json();
    expect(rates[0]).toMatchObject({ shortName: "3 Hours" });
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window", () => {
    const l = new RateLimiter(2, 1000);
    expect(l.take("ip", 0)).toBe(0);
    expect(l.take("ip", 100)).toBe(0);
    expect(l.take("ip", 200)).toBeGreaterThan(0);
    expect(l.take("ip", 1001)).toBe(0);
  });
});
