import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const booleanish = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  context.addIssue({ code: 'custom', message: 'Expected a boolean value' });
  return z.NEVER;
});

export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-doc-rag'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_MODE: z.enum(['api-key', 'disabled']).default('api-key'),
  API_KEYS: csv.default([]),

  // One process serves exactly one corpus and one authorization boundary.
  CORPUS_SOURCE: z.enum(['filesystem', 'azure-blob', 'none']).optional(),
  DOCS_ROOT: z.string().min(1).optional(),
  CORPUS_WATCH: booleanish.default(true),
  AZURE_STORAGE_ACCOUNT_NAME: z
    .string()
    .regex(/^[a-z0-9]{3,24}$/, 'Expected a storage account name')
    .optional(),
  AZURE_STORAGE_CONTAINER: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,62}$/, 'Expected a container name')
    .optional(),
  AZURE_STORAGE_PREFIX: z
    .string()
    .max(256)
    .regex(/^[\p{L}\p{N}._\-/]*$/u, 'Prefix may only contain path-safe characters')
    .optional(),

  CORPUS_REFRESH_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(0),
  CORPUS_MAX_DEPTH: z.coerce.number().int().min(1).max(32).default(12),
  CORPUS_MAX_DIRECTORY_ENTRIES: z.coerce.number().int().min(1).max(50_000).default(2_000),
  CORPUS_MAX_DOCUMENTS: z.coerce.number().int().min(1).max(50_000).default(2_000),
  CORPUS_MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(1_048_576),
  CORPUS_MAX_TOTAL_BYTES: z.coerce.number().int().min(1_024).max(268_435_456).default(33_554_432),
  CORPUS_MAX_CONCURRENT_READS: z.coerce.number().int().min(1).max(32).default(4),

  INDEX_MAX_CHUNKS: z.coerce.number().int().min(1).max(500_000).default(20_000),
  INDEX_MAX_TERMS: z.coerce.number().int().min(1_000).max(5_000_000).default(200_000),
  INDEX_MAX_MEMORY_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(1_073_741_824)
    .default(134_217_728),
  INDEX_BUILD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  CHUNK_MAX_CHARS: z.coerce.number().int().min(200).max(8_000).default(1_600),
  CHUNK_MIN_CHARS: z.coerce.number().int().min(0).max(4_000).default(160),
  SECTION_MAX_CHARS: z.coerce.number().int().min(16).max(512).default(200),

  SEARCH_ALGORITHM: z.enum(['bm25', 'tfidf']).default('bm25'),
  SEARCH_MIN_SCORE: z.coerce.number().min(0).max(1_000).default(0.35),
  SEARCH_RELATIVE_CUTOFF: z.coerce.number().min(0).max(1).default(0.2),
  SEARCH_MAX_CANDIDATES: z.coerce.number().int().min(1).max(10_000).default(200),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(25).default(10),
  SEARCH_MAX_PER_SOURCE: z.coerce.number().int().min(1).max(25).default(3),
  SEARCH_MAX_CONTENT_CHARS: z.coerce.number().int().min(200).max(8_000).default(1_600),
  SEARCH_MAX_TOTAL_CHARS: z.coerce.number().int().min(200).max(64_000).default(8_000),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(2_000),
  SEARCH_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(4),
  SEARCH_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1_000).default(32),
});

export type Env = z.infer<typeof envSchema>;

export type CorpusSourceKind = 'filesystem' | 'azure-blob' | 'none';

export interface CorpusLimits {
  readonly maxDepth: number;
  readonly maxDirectoryEntries: number;
  readonly maxDocuments: number;
  readonly maxDocumentBytes: number;
  readonly maxTotalBytes: number;
  readonly maxConcurrentReads: number;
}

export interface IndexLimits {
  readonly maxChunks: number;
  readonly maxTerms: number;
  readonly maxMemoryBytes: number;
  readonly buildTimeoutMs: number;
  readonly chunkMaxChars: number;
  readonly chunkMinChars: number;
  readonly sectionMaxChars: number;
}

export interface SearchLimits {
  readonly algorithm: 'bm25' | 'tfidf';
  readonly minScore: number;
  readonly relativeCutoff: number;
  readonly maxCandidates: number;
  readonly maxResults: number;
  readonly maxResultsPerSource: number;
  readonly maxContentChars: number;
  readonly maxTotalChars: number;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly queueLimit: number;
}

export type CorpusConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'filesystem'; readonly rootPath: string; readonly watch: boolean }
  | {
      readonly kind: 'azure-blob';
      readonly accountName: string;
      readonly containerName: string;
      readonly prefix: string;
    };

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
  readonly corpus: CorpusConfig;
  readonly refreshIntervalMs: number;
  readonly corpusLimits: CorpusLimits;
  readonly indexLimits: IndexLimits;
  readonly search: SearchLimits;
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

const forbiddenStorageCredentialVariables = [
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_SAS_TOKEN',
  'AZURE_STORAGE_SAS',
  'AZURE_STORAGE_KEY',
  'AZURE_STORAGE_ACCOUNT_KEY',
] as const;

const selectSourceKind = (env: Env): CorpusSourceKind => {
  if (env.CORPUS_SOURCE) return env.CORPUS_SOURCE;
  if (env.DOCS_ROOT) return 'filesystem';
  if (env.AZURE_STORAGE_ACCOUNT_NAME && env.AZURE_STORAGE_CONTAINER) return 'azure-blob';
  return 'none';
};

const buildCorpusConfig = (env: Env, isProduction: boolean): CorpusConfig => {
  const kind = selectSourceKind(env);
  if (kind === 'none') return { kind: 'none' };

  if (kind === 'filesystem') {
    if (!env.DOCS_ROOT) {
      throw new ConfigurationError('CORPUS_SOURCE=filesystem requires DOCS_ROOT');
    }
    if (isProduction && !isAbsolute(env.DOCS_ROOT)) {
      throw new ConfigurationError('DOCS_ROOT must be an absolute path in production');
    }
    const rootPath = resolve(env.DOCS_ROOT);
    const applicationRoot = resolve(process.cwd());
    if (
      isProduction &&
      (rootPath === applicationRoot || applicationRoot.startsWith(`${rootPath}/`))
    ) {
      throw new ConfigurationError(
        'DOCS_ROOT must be a dedicated corpus directory, not the application directory or one of its parents',
      );
    }
    return { kind: 'filesystem', rootPath, watch: env.CORPUS_WATCH };
  }

  if (!env.AZURE_STORAGE_ACCOUNT_NAME || !env.AZURE_STORAGE_CONTAINER) {
    throw new ConfigurationError(
      'CORPUS_SOURCE=azure-blob requires AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER',
    );
  }
  const prefix = (env.AZURE_STORAGE_PREFIX ?? '').replace(/^\/+/, '');
  if (prefix.includes('..')) {
    throw new ConfigurationError('AZURE_STORAGE_PREFIX must not contain relative segments');
  }
  return {
    kind: 'azure-blob',
    accountName: env.AZURE_STORAGE_ACCOUNT_NAME,
    containerName: env.AZURE_STORAGE_CONTAINER,
    prefix: prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`,
  };
};

export const buildConfig = (env: Env, processEnv: NodeJS.ProcessEnv = process.env): AppConfig => {
  const isProduction = env.NODE_ENV === 'production';
  if (env.CHUNK_MIN_CHARS >= env.CHUNK_MAX_CHARS) {
    throw new ConfigurationError('CHUNK_MIN_CHARS must be smaller than CHUNK_MAX_CHARS');
  }
  if (env.AUTH_MODE === 'disabled' && isProduction) {
    throw new ConfigurationError('AUTH_MODE=disabled is not permitted in production');
  }
  if (env.AUTH_MODE === 'api-key') {
    if (env.API_KEYS.length === 0) {
      throw new ConfigurationError('AUTH_MODE=api-key requires API_KEYS');
    }
    if (env.API_KEYS.some((key) => key.length < 32)) {
      throw new ConfigurationError('Every API key must be at least 32 characters');
    }
  }

  const corpus = buildCorpusConfig(env, isProduction);
  if (corpus.kind === 'azure-blob') {
    const provided = forbiddenStorageCredentialVariables.filter(
      (name) => (processEnv[name] ?? '').trim() !== '',
    );
    if (provided.length > 0) {
      throw new ConfigurationError(
        `Blob corpora use managed identity only; remove ${provided.join(', ')}`,
      );
    }
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    service: {
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      gitSha: env.GIT_SHA,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    },
    logLevel: env.LOG_LEVEL,
    auth:
      env.AUTH_MODE === 'disabled'
        ? { mode: 'disabled' }
        : { mode: 'api-key', apiKeys: env.API_KEYS },
    corpus,
    refreshIntervalMs: env.CORPUS_REFRESH_INTERVAL_MS,
    corpusLimits: {
      maxDepth: env.CORPUS_MAX_DEPTH,
      maxDirectoryEntries: env.CORPUS_MAX_DIRECTORY_ENTRIES,
      maxDocuments: env.CORPUS_MAX_DOCUMENTS,
      maxDocumentBytes: env.CORPUS_MAX_DOCUMENT_BYTES,
      maxTotalBytes: env.CORPUS_MAX_TOTAL_BYTES,
      maxConcurrentReads: env.CORPUS_MAX_CONCURRENT_READS,
    },
    indexLimits: {
      maxChunks: env.INDEX_MAX_CHUNKS,
      maxTerms: env.INDEX_MAX_TERMS,
      maxMemoryBytes: env.INDEX_MAX_MEMORY_BYTES,
      buildTimeoutMs: env.INDEX_BUILD_TIMEOUT_MS,
      chunkMaxChars: env.CHUNK_MAX_CHARS,
      chunkMinChars: env.CHUNK_MIN_CHARS,
      sectionMaxChars: env.SECTION_MAX_CHARS,
    },
    search: {
      algorithm: env.SEARCH_ALGORITHM,
      minScore: env.SEARCH_MIN_SCORE,
      relativeCutoff: env.SEARCH_RELATIVE_CUTOFF,
      maxCandidates: env.SEARCH_MAX_CANDIDATES,
      maxResults: env.SEARCH_MAX_RESULTS,
      maxResultsPerSource: env.SEARCH_MAX_PER_SOURCE,
      maxContentChars: env.SEARCH_MAX_CONTENT_CHARS,
      maxTotalChars: env.SEARCH_MAX_TOTAL_CHARS,
      timeoutMs: env.SEARCH_TIMEOUT_MS,
      maxConcurrent: env.SEARCH_MAX_CONCURRENT,
      queueLimit: env.SEARCH_QUEUE_LIMIT,
    },
  };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data, source);
};
