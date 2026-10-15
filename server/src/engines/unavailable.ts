import type { EngineName, RunOutcome } from "../../../shared/types.ts";
import { EngineError, type Engine } from "./types.ts";

/** Stand-in for an engine this build can't run (e.g. the browser engine on Cloudflare). */
export class UnavailableEngine implements Engine {
  constructor(
    readonly name: EngineName,
    private readonly reason: string,
  ) {}

  async unavailableReason() {
    return this.reason;
  }

  async purchase(): Promise<RunOutcome> {
    throw new EngineError(this.reason);
  }
}
