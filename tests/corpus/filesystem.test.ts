import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemCorpusSource } from '../../src/corpus/filesystem.js';
import { CorpusUnavailableError, SkipTally, type CorpusDocument } from '../../src/corpus/types.js';
import { testConfig } from '../helpers/config.js';

const directories: string[] = [];

const corpus = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'doc-rag-fs-'));
  directories.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
};

const limits = testConfig().corpusLimits;

const collect = async (
  source: FileSystemCorpusSource,
  skips = new SkipTally(),
): Promise<{ documents: CorpusDocument[]; skips: SkipTally }> => {
  const documents: CorpusDocument[] = [];
  for await (const document of source.list({ skips })) documents.push(document);
  return { documents, skips };
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('filesystem corpus source', () => {
  it('enumerates supported documents with relative identifiers only', async () => {
    const root = corpus({
      'guides/setup.md': '# Setup\n\nInstall the server.',
      'api/client.ts': 'export const client = 1;',
      'notes/image.png': 'binary-ish',
      'node_modules/pkg/readme.md': '# Ignored',
      '.git/config': 'ignored',
      '.env': 'API_KEYS=secret',
    });
    const { documents, skips } = await collect(
      new FileSystemCorpusSource({ rootPath: root, limits }),
    );

    expect(documents.map((document) => document.id)).toEqual(['api/client.ts', 'guides/setup.md']);
    expect(documents.every((document) => !document.id.includes(root))).toBe(true);
    expect(skips.entries().map((entry) => entry.reason)).toContain('ignored_path');
    expect(skips.entries().map((entry) => entry.reason)).toContain('unsupported_extension');
  });

  it('skips symbolic links, oversized and empty documents', async () => {
    const root = corpus({
      'guides/big.md': 'x'.repeat(4_096),
      'guides/empty.md': '',
      'guides/real.md': '# Real\n\nContent.',
    });
    const outsideRoot = corpus({ 'secret.md': '# Outside' });
    try {
      symlinkSync(join(outsideRoot, 'secret.md'), join(root, 'guides', 'link.md'));
    } catch {
      // Symbolic link creation can require elevation; the remaining assertions still apply.
    }

    const { documents, skips } = await collect(
      new FileSystemCorpusSource({
        rootPath: root,
        limits: { ...limits, maxDocumentBytes: 1_024 },
      }),
    );

    expect(documents.map((document) => document.id)).toEqual(['guides/real.md']);
    const reasons = skips.entries().map((entry) => entry.reason);
    expect(reasons).toContain('oversized');
    expect(reasons).toContain('empty');
  });

  it('bounds traversal depth', async () => {
    const root = corpus({ 'a/b/c/d/deep.md': '# Deep' });
    const { documents, skips } = await collect(
      new FileSystemCorpusSource({ rootPath: root, limits: { ...limits, maxDepth: 2 } }),
    );

    expect(documents).toHaveLength(0);
    expect(skips.entries().map((entry) => entry.reason)).toContain('limit_depth');
  });

  it('reads bounded content and reports truncation', async () => {
    const root = corpus({ 'guides/long.md': 'abcdefghij'.repeat(10) });
    const source = new FileSystemCorpusSource({ rootPath: root, limits });
    const { documents } = await collect(source);

    const full = await source.read(documents[0]!, { maxBytes: 1_024 });
    expect(full?.truncated).toBe(false);
    expect(full?.text).toHaveLength(100);

    const bounded = await source.read(documents[0]!, { maxBytes: 20 });
    expect(bounded?.truncated).toBe(true);
    expect(bounded?.text).toHaveLength(20);
  });

  it('refuses reads that escape the root', async () => {
    const root = corpus({ 'guides/setup.md': '# Setup' });
    const source = new FileSystemCorpusSource({ rootPath: root, limits });
    const escaped = await source.read(
      {
        id: '../escape.md',
        extension: '.md',
        sizeBytes: 10,
        revision: 'x',
        modifiedAt: undefined,
      },
      { maxBytes: 1_024 },
    );
    expect(escaped).toBeUndefined();
  });

  it('rejects binary content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-rag-bin-'));
    directories.push(root);
    writeFileSync(join(root, 'binary.md'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const source = new FileSystemCorpusSource({ rootPath: root, limits });
    const { documents } = await collect(source);

    expect(await source.read(documents[0]!, { maxBytes: 1_024 })).toBeUndefined();
  });

  it('reports a missing root as an unavailable corpus', async () => {
    const source = new FileSystemCorpusSource({
      rootPath: join(tmpdir(), 'doc-rag-missing-root'),
      limits,
    });
    await expect(collect(source)).rejects.toBeInstanceOf(CorpusUnavailableError);
  });
});
