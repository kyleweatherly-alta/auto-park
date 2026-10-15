import { parkedUntil, recentUnknown } from "../../shared/history.ts";
import type { EngineMode, Profile, Run, Vehicle } from "../../shared/types.ts";
import { api, HttpError } from "./api.ts";
import { getHistory, recordRun } from "./store.ts";

export type StartOutcome =
  | { kind: "started"; run: Run }
  | { kind: "already_parked"; until: string }
  | { kind: "maybe_parked"; message: string }
  | { kind: "failed"; message: string; offline: boolean };

/**
 * Start a purchase with this device's details. Before buying for real it checks
 * this device's own history so a second tap doesn't buy a second session.
 */
export async function startPurchase(opts: {
  profile: Profile;
  vehicle: Vehicle;
  rateName: string;
  engine: EngineMode;
  idempotencyKey: string;
  dryRun?: boolean;
  force?: boolean;
  allowLotMismatch?: boolean;
}): Promise<StartOutcome> {
  const { profile, vehicle } = opts;
  if (!opts.dryRun && !opts.force) {
    const parked = parkedUntil(getHistory(), vehicle.plate);
    if (parked) return { kind: "already_parked", until: parked.endTime };
    if (recentUnknown(getHistory(), vehicle.plate)) {
      return { kind: "maybe_parked", message: "A recent purchase for this plate may have gone through. Check your texts before buying again." };
    }
  }
  try {
    const { run } = await api.startRun({
      plate: vehicle.plate,
      phone: profile.phone,
      promoCode: profile.promoCode,
      rateName: opts.rateName,
      vehicleName: vehicle.nickname,
      engine: opts.engine,
      dryRun: opts.dryRun,
      allowLotMismatch: opts.allowLotMismatch,
      idempotencyKey: opts.idempotencyKey,
    });
    recordRun(run);
    return { kind: "started", run };
  } catch (err) {
    const e = err as HttpError;
    if (e.body?.error === "busy" && e.body.run) {
      recordRun(e.body.run);
      return { kind: "started", run: e.body.run };
    }
    return { kind: "failed", message: e.message || "Couldn't start the purchase.", offline: e.status === 0 };
  }
}
