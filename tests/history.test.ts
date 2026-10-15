import { describe, expect, it } from "vitest";
import { parkedUntil, recentUnknown, upsertRun } from "../shared/history.ts";
import type { Run } from "../shared/types.ts";

const NOW = Date.parse("2026-10-15T15:00:00Z");
function run(over: Partial<Run>): Run {
  return {
    id: Math.random().toString(36).slice(2),
    createdAt: "2026-10-15T14:00:00Z",
    plate: "ABC1234",
    vehicleName: "ABC1234",
    rateName: "MAC Member - 3 Hours",
    dryRun: false,
    engine: "api",
    status: "success",
    steps: [],
    hasScreenshot: false,
    logs: [],
    ...over,
  };
}

describe("local history guards", () => {
  it("finds a session that hasn't ended", () => {
    const runs = [run({ outcome: { status: "success", message: "", endTime: "2026-10-15T17:00:00Z" } })];
    expect(parkedUntil(runs, "ABC1234", NOW)).toMatchObject({ plate: "ABC1234", endTime: "2026-10-15T17:00:00Z" });
    expect(parkedUntil(runs, "OTHER1", NOW)).toBeNull();
  });

  it("ignores ended sessions and test runs", () => {
    const runs = [
      run({ outcome: { status: "success", message: "", endTime: "2026-10-15T14:30:00Z" } }),
      run({ dryRun: true, status: "dry_run_ok", outcome: { status: "dry_run_ok", message: "" } }),
    ];
    expect(parkedUntil(runs, undefined, NOW)).toBeNull();
  });

  it("flags a recent unclear purchase, but not an old one or one followed by a success", () => {
    expect(recentUnknown([run({ status: "unknown", createdAt: "2026-10-15T14:50:00Z" })], "ABC1234", NOW)).not.toBeNull();
    expect(recentUnknown([run({ status: "unknown", createdAt: "2026-10-15T13:00:00Z" })], "ABC1234", NOW)).toBeNull();
    expect(
      recentUnknown([run({ status: "success", createdAt: "2026-10-15T14:55:00Z" }), run({ status: "unknown", createdAt: "2026-10-15T14:50:00Z" })], "ABC1234", NOW),
    ).toBeNull();
  });

  it("upserts newest first and caps the list", () => {
    const a = run({ id: "a", createdAt: "2026-10-15T10:00:00Z" });
    const b = run({ id: "b", createdAt: "2026-10-15T11:00:00Z" });
    let list = upsertRun([], a);
    list = upsertRun(list, b);
    list = upsertRun(list, { ...a, status: "error" });
    expect(list.map((r) => `${r.id}:${r.status}`)).toEqual(["b:success", "a:error"]);
    expect(upsertRun(list, run({ id: "c", createdAt: "2026-10-15T12:00:00Z" }), 2).map((r) => r.id)).toEqual(["c", "b"]);
  });
});
