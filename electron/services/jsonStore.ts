/**
 * A small JSON file store with atomic writes.
 *
 * The library index is the one piece of state whose loss would actually
 * hurt — every track, folder and analysis result lives in it. Writes go to
 * a temporary file and are renamed into place, so a crash or power cut
 * mid-write leaves the previous version intact rather than a half-written
 * file that fails to parse on next launch.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface JsonStoreOptions<T> {
  filePath: string;
  defaults: () => T;
  /** Coerce whatever was on disk into a valid `T`. Must not throw. */
  normalise: (raw: unknown) => T;
}

export class JsonStore<T> {
  private readonly filePath: string;
  private readonly defaults: () => T;
  private readonly normalise: (raw: unknown) => T;
  private cache: T | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JsonStoreOptions<T>) {
    this.filePath = options.filePath;
    this.defaults = options.defaults;
    this.normalise = options.normalise;
  }

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      this.cache = this.normalise(JSON.parse(text));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // The file exists but is unusable. Keep a copy so the user can
        // recover manually, then start fresh rather than refusing to boot.
        await this.quarantine().catch(() => undefined);
      }
      this.cache = this.defaults();
    }
    return this.cache;
  }

  /**
   * Replace the stored value.
   *
   * Writes are serialised through a promise chain so two rapid updates
   * cannot interleave their temp files and land out of order.
   */
  async write(value: T): Promise<T> {
    this.cache = value;
    const task = this.writeChain.then(() => this.writeNow(value));
    this.writeChain = task.catch(() => undefined);
    await task;
    return value;
  }

  async update(mutate: (current: T) => T): Promise<T> {
    const current = await this.read();
    return this.write(mutate(current));
  }

  private async writeNow(value: T): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    const payload = JSON.stringify(value, null, 2);

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'w');
      await handle.writeFile(payload, 'utf8');
      // Flush to the platter before the rename, or a crash can leave the
      // renamed file present but empty.
      await handle.sync().catch(() => undefined);
    } finally {
      await handle?.close().catch(() => undefined);
    }

    try {
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.filePath}.corrupt-${stamp}`;
    await fs.copyFile(this.filePath, target);
  }

  /** Drop the in-memory copy so the next read hits disk. */
  invalidate(): void {
    this.cache = null;
  }

  /** Content hash of the current value, for change detection in tests. */
  static fingerprint(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex');
  }
}
