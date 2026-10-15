import type { EngineName, Rate, RunOutcome, StepId, StepStatus } from "../../../shared/types.ts";

export interface PurchaseRequest {
  lotCode: string;
  plate: string;
  /** E.164 */
  phone: string;
  promoCode: string;
  /** TapNPark rate name to buy; empty = first listed. */
  rateName: string;
  /** Do everything except the irreversible checkout. */
  dryRun: boolean;
  allowLotMismatch: boolean;
}

export interface EngineContext {
  signal: AbortSignal;
  step(id: StepId, status: StepStatus, detail?: string): void;
  log(message: string): void;
  /**
   * Call immediately before the irreversible step. Returns false if the run
   * was cancelled, in which case the engine must stop without buying. Once it
   * returns true the run can no longer be cancelled.
   */
  commit(): boolean;
  saveScreenshot(png: Uint8Array): Promise<void>;
}

export interface Engine {
  readonly name: EngineName;
  /** null if usable, otherwise why not (e.g. Chromium missing). */
  unavailableReason(): Promise<string | null>;
  purchase(req: PurchaseRequest, ctx: EngineContext): Promise<RunOutcome>;
  /** Live rates for the lot (used for the duration picker). */
  listRates?(lotCode: string, signal?: AbortSignal): Promise<Rate[]>;
}

/**
 * Thrown when an engine hits something it doesn't understand (site changed,
 * network failure, unexpected response). Business outcomes such as "promo
 * rejected" are returned as RunOutcome instead.
 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly committed = false,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export function outcome(
  status: RunOutcome["status"],
  message: string,
  extra: Omit<RunOutcome, "status" | "message"> = {},
): RunOutcome {
  return { status, message, ...extra };
}
