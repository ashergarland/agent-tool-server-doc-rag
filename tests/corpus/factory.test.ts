import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorpusSource } from '../../src/corpus/index.js';
import { FileSystemChangeWatcher } from '../../src/corpus/watch.js';
import { testConfig } from '../helpers/config.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('corpus factory', () => {
  it('builds a filesystem source for a filesystem corpus', () => {
    const source = createCorpusSource(testConfig());
    expect(source?.kind).toBe('filesystem');
  });

  it('builds a blob source for a blob corpus', () => {
    const source = createCorpusSource(
      testConfig({
        CORPUS_SOURCE: 'azure-blob',
        DOCS_ROOT: undefined,
        AZURE_STORAGE_ACCOUNT_NAME: 'corpusaccount',
        AZURE_STORAGE_CONTAINER: 'corpus',
      }),
    );
    expect(source?.kind).toBe('azure-blob');
  });

  it('builds no source when no corpus is configured', () => {
    expect(
      createCorpusSource(testConfig({ CORPUS_SOURCE: 'none', DOCS_ROOT: undefined })),
    ).toBeUndefined();
  });
});

describe('filesystem change watcher', () => {
  it('debounces change notifications and stops cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-rag-watch-'));
    directories.push(root);
    const watcher = new FileSystemChangeWatcher(root, 20);

    let changes = 0;
    watcher.start(() => {
      changes += 1;
    });

    writeFileSync(join(root, 'a.md'), '# A');
    writeFileSync(join(root, 'b.md'), '# B');
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Multiple rapid writes must collapse into at most one rebuild trigger.
    expect(changes).toBeLessThanOrEqual(1);
    watcher.close();

    writeFileSync(join(root, 'c.md'), '# C');
    const afterClose = changes;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changes).toBe(afterClose);
  });

  it('tolerates an unwatchable root', () => {
    const watcher = new FileSystemChangeWatcher(join(tmpdir(), 'doc-rag-missing-watch-root'));
    expect(() => watcher.start(() => undefined)).not.toThrow();
    expect(() => watcher.close()).not.toThrow();
  });
});
