import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/src/app.ts";
import { FailureLimiter, signSession, verifySession } from "../server/src/auth.ts";
import { FakeEngine } from "../server/src/engines/fake.ts";
import { RatesService } from "../server/src/rates.ts";
import { RunManager } from "../server/src/runs.ts";
import { MemoryKV } from "../server/src/store/kv.ts";
import { Repo } from "../server/src/store/repo.ts";

const SECRET = "x".repeat(40);

async function makeApp() {
  const repo = new Repo(new MemoryKV(), { plate: "ABC1234", phone: "4145550199", promo: "PROMO1", rate: "", engine: "fake" });
  const fake = new FakeEngine(1);
  const runs = new RunManager({
    repo,
    engines: { api: fake, browser: fake, fake } as never,
    lotCode: "Q60x6xih",
    lotName: "MAC Member Parking",
    defaultEngine: "fake",
    timeoutMs: 5000,
    screenshotsDir: path.join(await mkdtemp(path.join(tmpdir(), "ap-")), "shots"),
    log: () => {},
  });
  const rates = new RatesService("Q60x6xih", () => fake);
  return createApp({
    config: { APP_PASSCODE: "123456", sessionSecret: SECRET, isProduction: false, LOT_NAME: "MAC Member Parking" },
    repo,
    runs,
    rates: { live: rates, fake: rates },
  });
}

async function loggedIn() {
  const app = await makeApp();
  const agent = request.agent(app);
  await agent.post("/api/login").send({ passcode: "123456" }).expect(204);
  return agent;
}

describe("session tokens", () => {
  it("verifies its own tokens and rejects tampering and expiry", () => {
    const { token } = signSession(SECRET, 1_000);
    expect(verifySession(SECRET, token, 2_000)).toBe(true);
    expect(verifySession("other-secret".repeat(4), token, 2_000)).toBe(false);
    expect(verifySession(SECRET, token.replace(/^\d/, "9"), 2_000)).toBe(false);
    expect(verifySession(SECRET, token, 1_000 + 91 * 24 * 3600_000)).toBe(false);
    expect(verifySession(SECRET, undefined)).toBe(false);
  });

  it("limits repeated failures", () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail("ip", 100);
    expect(l.retryAfter("ip", 200)).toBeGreaterThan(0);
    expect(l.retryAfter("ip", 1200)).toBe(0);
  });
});

describe("API", () => {
  it("locks everything except health and login behind the passcode", async () => {
    const app = await makeApp();
    await request(app).get("/api/health").expect(200);
    for (const [method, url] of [
      ["get", "/api/profile"],
      ["get", "/api/status"],
      ["get", "/api/runs"],
      ["get", "/api/rates"],
      ["post", "/api/runs"],
      ["put", "/api/profile"],
    ] as const) {
      await request(app)[method](url).send({}).expect(401);
    }
  });

  it("rejects a wrong passcode and rate-limits guessing", async () => {
    const app = await makeApp();
    for (let i = 0; i < 5; i++) await request(app).post("/api/login").send({ passcode: "000000" }).expect(401);
    await request(app).post("/api/login").send({ passcode: "123456" }).expect(429);
  });

  it("sets an httpOnly cookie on login", async () => {
    const app = await makeApp();
    const res = await request(app).post("/api/login").send({ passcode: "123456" }).expect(204);
    expect(String(res.headers["set-cookie"])).toMatch(/ap_session=.*HttpOnly/i);
  });

  it("blocks writes from other origins", async () => {
    const agent = await loggedIn();
    await agent.put("/api/profile").set("Origin", "https://evil.example").send({}).expect(403);
  });

  it("serves the seeded profile and validates edits", async () => {
    const agent = await loggedIn();
    const { body: profile } = await agent.get("/api/profile").expect(200);
    expect(profile).toMatchObject({ phone: "+14145550199", promoCode: "PROMO1", vehicles: [{ plate: "ABC1234" }] });

    const bad = await agent
      .put("/api/profile")
      .send({ ...profile, phone: "123", vehicles: [{ plate: "!!", nickname: "" }] })
      .expect(422);
    expect(bad.body.fields).toMatchObject({ phone: expect.any(String), "vehicles.0.plate": expect.any(String) });

    const good = await agent
      .put("/api/profile")
      .send({ ...profile, vehicles: [...profile.vehicles, { plate: "abc 123", nickname: "Truck" }] })
      .expect(200);
    expect(good.body.vehicles[1]).toMatchObject({ plate: "ABC123", nickname: "Truck", id: expect.any(String) });
  });

  it("runs a purchase and streams its progress", async () => {
    const agent = await loggedIn();
    const { body: profile } = await agent.get("/api/profile");
    const { body } = await agent
      .post("/api/runs")
      .send({ vehicleId: profile.vehicles[0].id, idempotencyKey: "abcdefgh-1" })
      .expect(202);
    const events = await agent.get(`/api/runs/${body.run.id}/events`).buffer(true).parse((res, cb) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => cb(null, data));
    });
    const parsed = String(events.body)
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(parsed[0].type).toBe("snapshot");
    expect(parsed.at(-1)).toMatchObject({ type: "done", run: { status: "success" } });

    const { body: history } = await agent.get("/api/runs").expect(200);
    expect(history.runs[0]).toMatchObject({ id: body.run.id, status: "success" });

    const { body: status } = await agent.get("/api/status").expect(200);
    expect(status.parkedUntil).toMatchObject({ plate: "ABC1234" });

    await agent.post("/api/runs").send({ vehicleId: profile.vehicles[0].id, idempotencyKey: "abcdefgh-2" }).expect(409);
  });

  it("validates run requests", async () => {
    const agent = await loggedIn();
    await agent.post("/api/runs").send({ vehicleId: "nope" }).expect(400);
    await agent.post("/api/runs").send({ vehicleId: "nope", idempotencyKey: "abcdefgh-3" }).expect(422);
  });

  it("lists rates", async () => {
    const agent = await loggedIn();
    const { body } = await agent.get("/api/rates").expect(200);
    expect(body.rates[0]).toMatchObject({ shortName: "3 Hours" });
  });
});
