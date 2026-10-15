/** In-memory sliding-window limiter: at most `max` hits per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit and returns 0, or returns ms until the key may try again. */
  take(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return this.windowMs - (now - list[0]!);
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.prune(now);
    return 0;
  }

  private prune(now: number) {
    for (const [k, list] of this.hits) if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}
