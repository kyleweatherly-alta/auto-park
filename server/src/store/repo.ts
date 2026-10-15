import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeNickname, normalizePhone, normalizePlate, normalizePromo } from "../../../shared/validate.ts";
import type { Profile, Run } from "../../../shared/types.ts";
import type { KV } from "./kv.ts";

const PROFILE_KEY = "profile";
const RUNS_KEY = "runs";
const MAX_RUNS = 200;

const vehicleInput = z.object({
  id: z.string().max(64).optional(),
  plate: z.string(),
  nickname: z.string().default(""),
});

export const profileInput = z.object({
  vehicles: z.array(vehicleInput).max(10),
  defaultVehicleId: z.string().nullable().optional(),
  phone: z.string(),
  promoCode: z.string().default(""),
  preferredRate: z.string().max(120).default(""),
  engine: z.enum(["auto", "api", "browser", "fake"]).default("auto"),
});

export type FieldErrors = Record<string, string>;

/**
 * Validate and normalize a profile from the client. Returns field errors keyed
 * the way the form names its inputs (e.g. "vehicles.1.plate").
 */
export function parseProfile(input: unknown): { ok: true; profile: Profile } | { ok: false; errors: FieldErrors } {
  const parsed = profileInput.safeParse(input);
  if (!parsed.success) return { ok: false, errors: { form: "That doesn't look like a valid profile." } };
  const p = parsed.data;
  const errors: FieldErrors = {};

  const phone = normalizePhone(p.phone);
  if (!phone.ok) errors.phone = phone.error;
  const promo = normalizePromo(p.promoCode);
  if (!promo.ok) errors.promoCode = promo.error;
  if (p.vehicles.length === 0) errors.vehicles = "Add at least one vehicle.";

  const seen = new Set<string>();
  const vehicles = p.vehicles.map((v, i) => {
    const plate = normalizePlate(v.plate);
    if (!plate.ok) errors[`vehicles.${i}.plate`] = plate.error;
    else if (seen.has(plate.value)) errors[`vehicles.${i}.plate`] = "This plate is already listed.";
    else seen.add(plate.value);
    const nick = normalizeNickname(v.nickname);
    if (!nick.ok) errors[`vehicles.${i}.nickname`] = nick.error;
    return { id: v.id || randomUUID(), plate: plate.ok ? plate.value : v.plate, nickname: nick.ok ? nick.value : v.nickname };
  });

  if (Object.keys(errors).length) return { ok: false, errors };
  const defaultVehicleId = vehicles.some((v) => v.id === p.defaultVehicleId) ? p.defaultVehicleId! : vehicles[0]!.id;
  return {
    ok: true,
    profile: {
      vehicles,
      defaultVehicleId,
      phone: phone.ok ? phone.value : "",
      promoCode: promo.ok ? promo.value : "",
      preferredRate: p.preferredRate.trim(),
      engine: p.engine,
    },
  };
}

export interface Seed {
  plate: string;
  phone: string;
  promo: string;
  rate: string;
  engine: Profile["engine"];
}

export class Repo {
  constructor(
    private readonly kv: KV,
    private readonly seed: Seed,
  ) {}

  /** The saved profile, or one seeded from the environment on first run. */
  async getProfile(): Promise<Profile> {
    const raw = await this.kv.get(PROFILE_KEY);
    if (raw) return JSON.parse(raw) as Profile;
    const plate = normalizePlate(this.seed.plate);
    const phone = normalizePhone(this.seed.phone);
    const promo = normalizePromo(this.seed.promo);
    const vehicles = plate.ok ? [{ id: randomUUID(), plate: plate.value, nickname: "" }] : [];
    const seeded: Profile = {
      vehicles,
      defaultVehicleId: vehicles[0]?.id ?? null,
      phone: phone.ok ? phone.value : "",
      promoCode: promo.ok ? promo.value : "",
      preferredRate: this.seed.rate,
      engine: this.seed.engine,
    };
    // Save it so vehicle IDs stay stable between requests.
    await this.saveProfile(seeded);
    return seeded;
  }

  async saveProfile(profile: Profile): Promise<void> {
    await this.kv.set(PROFILE_KEY, JSON.stringify(profile));
  }

  /** Newest first. */
  async listRuns(): Promise<Run[]> {
    const raw = await this.kv.get(RUNS_KEY);
    return raw ? (JSON.parse(raw) as Run[]) : [];
  }

  async saveRun(run: Run): Promise<void> {
    const runs = (await this.listRuns()).filter((r) => r.id !== run.id);
    runs.unshift(run);
    await this.kv.set(RUNS_KEY, JSON.stringify(runs.slice(0, MAX_RUNS)));
  }
}
