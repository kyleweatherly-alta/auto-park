import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimal key/value storage. Values are JSON strings. */
export interface KV {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class MemoryKV implements KV {
  readonly kind = "memory";
  private data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
}

/** One JSON file, written atomically (temp file + rename). */
export class FileKV implements KV {
  readonly kind = "file";
  private cache: Record<string, string> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.resolve(dir, "store.json");
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get(key: string) {
    return (await this.load())[key] ?? null;
  }

  async set(key: string, value: string) {
    const data = await this.load();
    data[key] = value;
    const snapshot = JSON.stringify(data);
    // Serialize writes so two quick saves can't interleave.
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.writing;
  }
}
