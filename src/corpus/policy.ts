/**
 * Shared corpus admission policy: which documents may enter an index, and how their identifiers are
 * normalized. Applies to every corpus source so filesystem and Blob corpora behave identically.
 */
export type DocumentFormat = 'markdown' | 'text' | 'html' | 'json' | 'yaml' | 'code';

const formatByExtension = new Map<string, DocumentFormat>([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdx', 'markdown'],
  ['.txt', 'text'],
  ['.text', 'text'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.ts', 'code'],
  ['.tsx', 'code'],
  ['.js', 'code'],
  ['.jsx', 'code'],
  ['.mjs', 'code'],
  ['.cjs', 'code'],
  ['.py', 'code'],
  ['.go', 'code'],
  ['.cs', 'code'],
  ['.java', 'code'],
  ['.rb', 'code'],
  ['.rs', 'code'],
  ['.sh', 'code'],
  ['.sql', 'code'],
]);

/** Extensions the chunkers can segment reliably. Everything else is skipped, never guessed. */
export const supportedExtensions: readonly string[] = [...formatByExtension.keys()].sort();

export const formatFor = (extension: string): DocumentFormat | undefined =>
  formatByExtension.get(extension.toLowerCase());

export const extensionOf = (identifier: string): string => {
  const name = identifier.slice(identifier.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
};

const ignoredDirectoryNames = new Set([
  '.bundle',
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.idea',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.nyc_output',
  '.pytest_cache',
  '.svn',
  '.terraform',
  '.tox',
  '.venv',
  '.vs',
  '__pycache__',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
  'venv',
  'vendor',
  'System Volume Information',
  '$RECYCLE.BIN',
]);

const ignoredFileNames = new Set([
  '.ds_store',
  '.env',
  '.netrc',
  '.npmrc',
  '.pgpass',
  'credentials',
  'desktop.ini',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'package-lock.json',
  'thumbs.db',
]);

const secretFilePatterns = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore|asc|gpg|ppk)$/i,
  /(^|[._-])secrets?([._-]|$)/i,
  /(^|[._-])credentials?([._-]|$)/i,
];

/** Directory and file names that never enter an index, independent of the extension allow-list. */
export const isIgnoredSegment = (segment: string, isDirectory: boolean): boolean => {
  if (segment === '' || segment === '.' || segment === '..') return true;
  if (isDirectory) {
    return ignoredDirectoryNames.has(segment) || segment.startsWith('.');
  }
  const lower = segment.toLowerCase();
  if (ignoredFileNames.has(lower)) return true;
  if (segment.startsWith('.')) return true;
  return secretFilePatterns.some((pattern) => pattern.test(segment));
};

export const isIgnoredIdentifier = (identifier: string): boolean => {
  const segments = identifier.split('/');
  return segments.some((segment, position) =>
    isIgnoredSegment(segment, position < segments.length - 1),
  );
};

// Control characters are exactly what this guard must detect.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Normalizes a corpus-relative path into a stable identifier, or returns undefined when the path is
 * unsafe (traversal, absolute, control characters, or over-long).
 */
export const normalizeIdentifier = (relativePath: string): string | undefined => {
  const candidate = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (candidate === '' || candidate.length > 512) return undefined;
  if (controlCharacters.test(candidate)) return undefined;
  if (candidate.startsWith('/') || /^[a-zA-Z]:\//.test(candidate)) return undefined;
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return segments.join('/');
};

const maxSampledBytes = 8_192;

/** Detects content that cannot be treated as text: NUL bytes or a high control-character ratio. */
export const looksBinary = (sample: Buffer | string): boolean => {
  if (typeof sample === 'string') {
    const inspected = sample.slice(0, maxSampledBytes);
    if (inspected.includes('\u0000')) return true;
    let suspicious = 0;
    for (const character of inspected) {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0xfffd) suspicious += 1;
      else if (code < 9 || (code > 13 && code < 32)) suspicious += 1;
    }
    return inspected.length > 0 && suspicious / inspected.length > 0.05;
  }
  const inspected = sample.subarray(0, maxSampledBytes);
  if (inspected.includes(0)) return true;
  let suspicious = 0;
  for (const byte of inspected) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return inspected.length > 0 && suspicious / inspected.length > 0.05;
};
