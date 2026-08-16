import { realpathSync, watch, type FSWatcher } from 'node:fs';
import type { CorpusChangeWatcher } from '../indexing/lifecycle.js';

/**
 * Debounced filesystem watching. Where recursive watching is unavailable the manager's bounded
 * reconciliation interval remains the source of freshness, so this never becomes a correctness
 * dependency.
 */
export class FileSystemChangeWatcher implements CorpusChangeWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly rootPath: string,
    private readonly debounceMs = 1_000,
  ) {}

  public start(onChange: () => void): void {
    const trigger = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(onChange, this.debounceMs);
      this.timer.unref?.();
    };
    try {
      // Canonicalize first: recursive watching aborts the process inside libuv when it is given a
      // non-canonical path such as a Windows 8.3 short name.
      const canonical = realpathSync.native(this.rootPath);
      this.watcher = watch(canonical, { recursive: true, persistent: false }, trigger);
      this.watcher.on('error', () => this.close());
    } catch {
      this.watcher = undefined;
    }
  }

  public close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
