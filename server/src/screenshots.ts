/** Where browser-engine screenshots go. The cloud build has no browser engine, so it uses NoScreenshots. */
export interface ScreenshotStore {
  save(runId: string, png: Uint8Array): Promise<void>;
  read(runId: string): Promise<Uint8Array | null>;
}

export class NoScreenshots implements ScreenshotStore {
  async save() {}
  async read() {
    return null;
  }
}

export class MemoryScreenshots implements ScreenshotStore {
  private shots = new Map<string, Uint8Array>();
  async save(id: string, png: Uint8Array) {
    this.shots.set(id, png);
  }
  async read(id: string) {
    return this.shots.get(id) ?? null;
  }
}
