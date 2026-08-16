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

  it('handles end tags with whitespace without losing content or leaking scripts', () => {
    // `</script >` and `</h1 >` are valid HTML that a regular expression filter mis-parses,
    // either indexing script content or silently discarding the text that follows.
    const chunks = chunk(
      'reference/spaced.html',
      'html',
      '<h1>Title </h1 ><script>never_indexed_secret</script >visible tail<style>a{}</style\n>more tail',
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).not.toContain('never_indexed_secret');
    expect(combined).not.toContain('a{}');
    expect(combined).toContain('visible tail');
    expect(combined).toContain('more tail');
    expect(chunks.some((entry) => entry.sectionPath.includes('Title'))).toBe(true);
  });

  it('never indexes attribute values as visible text', () => {
    // A quoted attribute may contain '>', which naive tag stripping treats as the end of the tag.
    const chunks = chunk(
      'reference/attributes.html',
      'html',
      '<p title="a>b" data-token="never_indexed_attribute">visible body</p>',
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).toContain('visible body');
    expect(combined).not.toContain('never_indexed_attribute');
    expect(combined).not.toContain('a>b');
  });

  it('decodes entities exactly once', () => {
    // Chained replacements double-unescape: '&amp;lt;' must stay the literal text '&lt;'.
    const chunks = chunk(
      'reference/entities.html',
      'html',
      '<p>&amp;lt;not-a-tag&amp;gt; &lt;real&gt; &#65;&#x42; &unknownentity;</p>',
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).toContain('&lt;not-a-tag&gt;');
    expect(combined).toContain('<real>');
    expect(combined).toContain('AB');
    expect(combined).toContain('&unknownentity;');
  });

  it('drops unterminated raw text elements rather than indexing them', () => {
    const chunks = chunk(
      'reference/unclosed.html',
      'html',
      '<p>visible intro</p><script>never_indexed_tail',
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).toContain('visible intro');
    expect(combined).not.toContain('never_indexed_tail');
  });

  it('keeps HTML comments and stray angle brackets out of the index', () => {
    const chunks = chunk(
      'reference/comments.html',
      'html',
      '<p>before</p><!-- never_indexed_comment --><p>5 < 7 and 8 > 3</p>',
    );
    const combined = chunks.map((entry) => entry.content).join('\n');

    expect(combined).not.toContain('never_indexed_comment');
    expect(combined).toContain('before');
    expect(combined).toContain('5 < 7');
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
