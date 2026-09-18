import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootBoundary, type ConfinedOpenedFile } from '@agent-tool-platform/runtime/fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemCorpusSource } from '../../src/corpus/filesystem.js';
import { CorpusUnavailableError, SkipTally, type CorpusDocument } from '../../src/corpus/types.js';
import { ingestCorpus } from '../../src/indexing/ingest.js';
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
  vi.restoreAllMocks();
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

  it('rejects an intermediate symlink or reparse-point escape', async () => {
    const root = corpus({ 'guides/setup.md': '# Setup' });
    const outsideRoot = corpus({ 'outside.md': '# Outside\n\nMust not be consumed.' });
    symlinkSync(
      outsideRoot,
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const source = new FileSystemCorpusSource({ rootPath: root, limits });
    const escaped = await source.read(
      {
        id: 'escape/outside.md',
        extension: '.md',
        sizeBytes: 31,
        revision: 'x',
        modifiedAt: undefined,
      },
      { maxBytes: 1_024 },
    );

    expect(escaped).toBeUndefined();
  });

  it('indexes the validated opened object when its pathname is replaced before consumption', async () => {
    const root = corpus({
      'changing.md': '# Original\n\nValidated opened object evidence.',
    });
    const outsideRoot = corpus({
      'replacement.md': '# Replacement\n\nOutside replacement content.',
    });
    const originalPath = join(root, 'changing.md');
    const movedPath = join(root, 'opened-object.md');
    const replacementPath = join(outsideRoot, 'replacement.md');
    const platformBoundary = new RootBoundary({
      root,
      requireRegularFile: true,
      maxFileBytes: limits.maxDocumentBytes,
    });
    const originalOpenFile = platformBoundary.openFile.bind(platformBoundary);
    vi.spyOn(RootBoundary.prototype, 'openFile').mockImplementation(
      async (input, options): Promise<ConfinedOpenedFile> => {
        const opened = await originalOpenFile(input, options);
        if (input === 'changing.md') {
          renameSync(originalPath, movedPath);
          renameSync(replacementPath, originalPath);
        }
        return opened;
      },
    );

    const config = testConfig({ CORPUS_MAX_CONCURRENT_READS: 1 });
    const result = await ingestCorpus({
      source: new FileSystemCorpusSource({ rootPath: root, limits: config.corpusLimits }),
      corpusLimits: config.corpusLimits,
      indexLimits: config.indexLimits,
    });
    const indexed = result.chunks.map((entry) => entry.content).join('\n');

    expect(indexed).toContain('Validated opened object evidence.');
    expect(indexed).not.toContain('Outside replacement content.');
  });

  it('closes confined descriptors after success, decoding failure, and cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-rag-close-'));
    directories.push(root);
    writeFileSync(join(root, 'valid.md'), '# Valid\n\nReadable text.');
    writeFileSync(join(root, 'invalid.md'), Buffer.from([0xc3, 0x28, 0x41, 0x42]));
    writeFileSync(join(root, 'cancel.md'), '# Cancel\n\nDo not consume.');

    const controller = new AbortController();
    const closed: string[] = [];
    const platformBoundary = new RootBoundary({
      root,
      requireRegularFile: true,
      maxFileBytes: limits.maxDocumentBytes,
    });
    const originalOpenFile = platformBoundary.openFile.bind(platformBoundary);
    vi.spyOn(RootBoundary.prototype, 'openFile').mockImplementation(
      async (input, options): Promise<ConfinedOpenedFile> => {
        const opened = await originalOpenFile(input, options);
        const wrapped: ConfinedOpenedFile = {
          relativePath: opened.relativePath,
          sizeBytes: opened.sizeBytes,
          preview: opened.preview,
          createReadStream: (streamOptions) => opened.createReadStream(streamOptions),
          close: async () => {
            closed.push(input);
            await opened.close();
          },
        };
        if (input === 'cancel.md') controller.abort();
        return wrapped;
      },
    );

    const source = new FileSystemCorpusSource({ rootPath: root, limits });
    const { documents } = await collect(source);
    const byId = new Map(documents.map((document) => [document.id, document]));

    expect(await source.read(byId.get('valid.md')!, { maxBytes: 1_024 })).toBeDefined();
    expect(await source.read(byId.get('invalid.md')!, { maxBytes: 1_024 })).toBeUndefined();
    await expect(
      source.read(byId.get('cancel.md')!, {
        maxBytes: 1_024,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(closed).toEqual(['valid.md', 'invalid.md', 'cancel.md']);
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
