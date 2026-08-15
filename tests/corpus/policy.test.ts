import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  formatFor,
  isIgnoredIdentifier,
  isIgnoredSegment,
  looksBinary,
  normalizeIdentifier,
  supportedExtensions,
} from '../../src/corpus/policy.js';

describe('corpus admission policy', () => {
  it('maps only formats that can be chunked reliably', () => {
    expect(formatFor('.md')).toBe('markdown');
    expect(formatFor('.YAML')).toBe('yaml');
    expect(formatFor('.ts')).toBe('code');
    expect(formatFor('.pdf')).toBeUndefined();
    expect(formatFor('.png')).toBeUndefined();
    expect(supportedExtensions).toContain('.html');
  });

  it('extracts extensions without treating dotfiles as extensions', () => {
    expect(extensionOf('guides/setup.md')).toBe('.md');
    expect(extensionOf('guides/.env')).toBe('');
    expect(extensionOf('guides/README')).toBe('');
  });

  it('ignores caches, build output, hidden entries and secret files', () => {
    expect(isIgnoredSegment('node_modules', true)).toBe(true);
    expect(isIgnoredSegment('.git', true)).toBe(true);
    expect(isIgnoredSegment('dist', true)).toBe(true);
    expect(isIgnoredSegment('guides', true)).toBe(false);
    expect(isIgnoredSegment('.env', false)).toBe(true);
    expect(isIgnoredSegment('service.pem', false)).toBe(true);
    expect(isIgnoredSegment('my-secrets.json', false)).toBe(true);
    expect(isIgnoredSegment('Thumbs.db', false)).toBe(true);
    expect(isIgnoredSegment('guide.md', false)).toBe(false);
    expect(isIgnoredIdentifier('node_modules/pkg/readme.md')).toBe(true);
    expect(isIgnoredIdentifier('guides/setup.md')).toBe(false);
  });

  it('rejects traversal, absolute and control-character identifiers', () => {
    expect(normalizeIdentifier('guides\\setup.md')).toBe('guides/setup.md');
    expect(normalizeIdentifier('./guides/setup.md')).toBe('guides/setup.md');
    expect(normalizeIdentifier('../escape.md')).toBeUndefined();
    expect(normalizeIdentifier('/etc/passwd')).toBeUndefined();
    expect(normalizeIdentifier('C:/Windows/system.ini')).toBeUndefined();
    expect(normalizeIdentifier('guides/set\u0000up.md')).toBeUndefined();
    expect(normalizeIdentifier('a'.repeat(600))).toBeUndefined();
  });

  it('detects binary content', () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from('plain documentation text', 'utf8'))).toBe(false);
    expect(looksBinary('text with a \u0000 null')).toBe(true);
    expect(looksBinary('regular text')).toBe(false);
  });
});
