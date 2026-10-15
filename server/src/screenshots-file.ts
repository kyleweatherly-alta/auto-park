// Node-only: keeps the most recent browser-engine screenshots on disk.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScreenshotStore } from "./screenshots.ts";

const KEEP = 30;

export class FileScreenshots implements ScreenshotStore {
  constructor(private readonly dir: string) {}

  private file(id: string) {
    return path.join(this.dir, `${id.replace(/[^a-f0-9-]/gi, "")}.png`);
  }

  async save(id: string, png: Uint8Array) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(id), png);
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".png"));
    if (files.length <= KEEP) return;
    const dated = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(this.dir, f))).mtimeMs })));
    dated.sort((a, b) => b.t - a.t);
    await Promise.all(dated.slice(KEEP).map(({ f }) => rm(path.join(this.dir, f), { force: true })));
  }

  async read(id: string) {
    try {
      return new Uint8Array(await readFile(this.file(id)));
    } catch {
      return null;
    }
  }
}
