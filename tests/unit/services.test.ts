import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { LocalDocsProvider } from '../../src/provider/local-docs.js';
import { testConfig } from '../helpers/config.js';
import { TestDocumentationProvider } from '../helpers/provider.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('documentation provider and services', () => {
  it('indexes supported local files and ranks relevant chunks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-rag-'));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, 'azure.md'),
      '# Container Apps\n\nInitialize the Azure client with DefaultAzureCredential.',
    );
    writeFileSync(join(directory, 'unrelated.txt'), 'Database migration reference.');
    writeFileSync(join(directory, 'ignored.bin'), 'Azure client');

    const provider = new LocalDocsProvider({
      rootPath: directory,
      chunkSize: 256,
      chunkOverlap: 20,
      maxFileBytes: 1024,
    });
    const results = await provider.search('Azure Container Apps client', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: 'azure.md', section: 'Container Apps' });
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(await provider.search('nonexistent terminology', 5)).toEqual([]);
  });

  it('wires an injectable application', async () => {
    const application = createApplication({
      config: testConfig(),
      provider: new TestDocumentationProvider(),
    });
    expect(application.registry.list()).toHaveLength(1);
    await application.http.close();
  });
});
