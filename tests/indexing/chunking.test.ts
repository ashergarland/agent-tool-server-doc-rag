import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/indexing/chunking.js';
import { testConfig } from '../helpers/config.js';

const limits = testConfig().indexLimits;
/** Small documents merge into one chunk by default, so splitting is exercised with tight bounds. */
const splitLimits = { ...limits, chunkMinChars: 0, chunkMaxChars: 400 };

const chunk = (
  source: string,
  format: Parameters<typeof chunkDocument>[0]['format'],
  text: string,
  overrides: Partial<typeof limits> = {},
) =>
  chunkDocument({
    source,
    format,
    text,
    revision: 'rev1',
    truncated: false,
    limits: { ...limits, ...overrides },
  });

describe('chunking and provenance', () => {
  it('splits markdown on headings and keeps fenced code intact', () => {
    const chunks = chunk(
      'guides/setup.md',
      'markdown',
      [
        '# Setup',
        '',
        'Install the server first.',
        '',
        '## Configure',
        '',
        'Set the corpus root.',
        '',
        '```bash',
        '',
        'DOCS_ROOT=/srv/corpus npm start',
        '',
        '```',
      ].join('\n'),
      splitLimits,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.sectionPath).toEqual(['Setup']);
    const configureChunk = chunks.find((entry) => entry.sectionPath.includes('Configure'));
    expect(configureChunk?.sectionPath).toEqual(['Setup', 'Configure']);
    const fenced = chunks.find((entry) => entry.content.includes('DOCS_ROOT=/srv/corpus'));
    expect(fenced?.content).toContain('```bash');
    expect(fenced?.content.split('```').length).toBe(3);
  });

  it('records stable identifiers and line ranges', () => {
    const text = '# Title\n\nFirst paragraph.\n\nSecond paragraph.';
    const first = chunk('guides/a.md', 'markdown', text);
    const second = chunk('guides/a.md', 'markdown', text);

    expect(first[0]?.id).toBe(second[0]?.id);
    expect(first[0]?.startLine).toBe(1);
    expect(first.at(-1)?.endLine).toBeGreaterThanOrEqual(first[0]!.startLine);
    expect(first.every((entry) => entry.source === 'guides/a.md')).toBe(true);
    expect(first.every((entry) => entry.revision === 'rev1')).toBe(true);
  });

  it('drops script and style content from HTML', () => {
    const chunks = chunk(
      'reference/page.html',
      'html',
      [
        '<html><head><style>',
        'body { color: red; }',
        '</style>',
        '<script>',
        "const secret = 'never-indexed';",
        '</script></head>',
        '<body><h1>Glossary</h1><p>A chunk is a bounded slice.</p></body></html>',
      ].join('\n'),
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).toContain('bounded slice');
    expect(combined).not.toContain('never-indexed');
    expect(combined).not.toContain('color: red');
    expect(chunks.some((entry) => entry.sectionPath.includes('Glossary'))).toBe(true);
  });

  it('splits structured data on logical members', () => {
    const chunks = chunk(
      'reference/limits.yaml',
      'yaml',
      ['corpus:', '  maxDocuments: 2000', 'search:', '  maxResults: 10'].join('\n'),
    );

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((entry) => entry.content.includes('maxDocuments'))).toBe(true);
    expect(chunks.some((entry) => entry.sectionPath.length > 0)).toBe(true);
  });

  it('splits code on top-level declarations', () => {
    const chunks = chunk(
      'api/client.ts',
      'code',
      [
        'export interface Options {',
        '  readonly name: string;',
        '}',
        '',
        'export class Client {',
        '  public send(): void {}',
        '}',
      ].join('\n'),
      splitLimits,
    );

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((entry) => entry.sectionPath.join(' ').includes('interface Options'))).toBe(
      true,
    );
    expect(chunks.some((entry) => entry.sectionPath.join(' ').includes('class Client'))).toBe(true);
  });

  it('bounds chunk size without splitting grapheme clusters', () => {
    const emoji = '👩‍👩‍👧‍👦';
    const chunks = chunkDocument({
      source: 'notes/unicode.txt',
      format: 'text',
      text: emoji.repeat(200),
      revision: 'rev1',
      truncated: false,
      limits: { ...limits, chunkMaxChars: 200, chunkMinChars: 0 },
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const entry of chunks) {
      expect(entry.content.length).toBeLessThanOrEqual(200);
      expect(entry.content).not.toContain('\ufffd');
      expect(entry.content.startsWith('\u200d')).toBe(false);
    }
  });

  it('propagates document truncation into every chunk', () => {
    const chunks = chunkDocument({
      source: 'guides/big.md',
      format: 'markdown',
      text: '# Title\n\nBody text.',
      revision: 'rev1',
      truncated: true,
      limits,
    });

    expect(chunks.every((entry) => entry.truncated)).toBe(true);
  });
});
