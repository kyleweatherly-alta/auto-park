import type { Rate } from "../../shared/types.ts";
import type { Engine } from "./engines/types.ts";

const TTL_MS = 10 * 60 * 1000;

/** Live rate list for the duration picker, cached so opening the app stays instant. */
export class RatesService {
  private cache: { at: number; rates: Rate[] } | null = null;
  private inflight: Promise<Rate[]> | null = null;

  constructor(
    private readonly lotCode: string,
    private readonly source: () => Engine,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<Rate[]> {
    if (this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.rates;
    this.inflight ??= (async () => {
      try {
        const engine = this.source();
        if (!engine.listRates) throw new Error("This engine can't list rates.");
        const rates = await engine.listRates(this.lotCode, AbortSignal.timeout(15_000));
        this.cache = { at: this.now(), rates };
        return rates;
      } finally {
        this.inflight = null;
      }
    })();
    try {
      return await this.inflight;
    } catch (err) {
      // Serve stale data rather than nothing if TapNPark hiccups.
      if (this.cache) return this.cache.rates;
      throw err;
    }
  }

  clear() {
    this.cache = null;
  }
}
