// Types shared by the server API and the web client.

export type EngineName = "api" | "browser" | "fake";
export type EngineMode = "auto" | EngineName;

export interface Vehicle {
  id: string;
  plate: string;
  nickname: string;
}

export interface Profile {
  vehicles: Vehicle[];
  defaultVehicleId: string | null;
  /** E.164, e.g. "+14145551234". Receipts are texted here. */
  phone: string;
  promoCode: string;
  /** TapNPark rate name, e.g. "MAC Member - 3 Hours". Empty = first rate listed. */
  preferredRate: string;
  engine: EngineMode;
}

export interface Rate {
  rateId: string;
  name: string;
  /** Name without the lot prefix, e.g. "3 Hours". */
  shortName: string;
  amount: number;
  requiresPassphrase: boolean;
}

/** The real steps of a purchase. Both engines report progress against these. */
export const STEPS = [
  { id: "connect", label: "Open the lot on TapNPark" },
  { id: "plate", label: "Enter plate and phone" },
  { id: "rate", label: "Choose the parking time" },
  { id: "promo", label: "Apply the promo code" },
  { id: "verify", label: "Check the total is $0.00" },
  { id: "checkout", label: "Check out" },
  { id: "receipt", label: "Get the end time" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type RunStatus =
  | "queued"
  | "running"
  // Finished outcomes:
  | "success"
  | "dry_run_ok"
  | "already_parked"
  | "needs_payment"
  | "promo_rejected"
  | "violation"
  | "lot_mismatch"
  | "invalid_plate"
  | "rate_unavailable"
  | "passphrase_required"
  | "cancelled"
  | "timeout"
  | "unknown"
  | "error";

export const FINISHED_STATUSES: RunStatus[] = [
  "success",
  "dry_run_ok",
  "already_parked",
  "needs_payment",
  "promo_rejected",
  "violation",
  "lot_mismatch",
  "invalid_plate",
  "rate_unavailable",
  "passphrase_required",
  "cancelled",
  "timeout",
  "unknown",
  "error",
];

export interface RunOutcome {
  status: Exclude<RunStatus, "queued" | "running">;
  message: string;
  /** ISO time the parking session ends (success only). */
  endTime?: string;
  /** What TapNPark says is owed at checkout, after the promo. */
  amountDue?: number;
  amountPaid?: number;
  rateName?: string;
  promoApplied?: boolean;
  /** True once the irreversible step was attempted. */
  committed?: boolean;
  /** Extra facts for display, e.g. which lot the camera saw the car in. */
  detail?: Record<string, string>;
}

export interface RunStep {
  id: StepId;
  status: StepStatus;
  detail?: string;
}

export interface Run {
  id: string;
  createdAt: string;
  finishedAt?: string;
  plate: string;
  vehicleName: string;
  rateName: string;
  dryRun: boolean;
  engine: EngineName;
  /** Set when the fast engine broke and the browser engine took over. */
  fellBackFrom?: EngineName;
  status: RunStatus;
  steps: RunStep[];
  outcome?: RunOutcome;
  hasScreenshot: boolean;
  /** Notable things that happened along the way (fallbacks, TapNPark notices). */
  logs: string[];
}

export type RunEvent =
  | { type: "snapshot"; run: Run }
  | { type: "step"; step: StepId; status: StepStatus; detail?: string }
  | { type: "log"; message: string }
  | { type: "engine"; engine: EngineName; fellBackFrom?: EngineName }
  | { type: "done"; run: Run };

export interface StartRunRequest {
  vehicleId: string;
  rateName?: string;
  dryRun?: boolean;
  /** Buy even though our history says this plate is already parked. */
  force?: boolean;
  /** Continue even if TapNPark's camera saw the car in a different lot. */
  allowLotMismatch?: boolean;
  /** One per tap, so a double-tap or retry never starts two purchases. */
  idempotencyKey: string;
}

export interface Status {
  lotName: string;
  engine: EngineMode;
  activeRun: Run | null;
  /** Latest successful purchase whose session hasn't ended yet. */
  parkedUntil: { plate: string; endTime: string; runId: string } | null;
}

export type ApiError = {
  error: string;
  message: string;
  run?: Run;
  until?: string;
};
