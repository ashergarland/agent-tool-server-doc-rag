import { isAbsolute, relative, resolve } from 'node:path';
import { defineCapabilityConfig, type PlatformConfig } from '@agent-tool-platform/runtime/config';
import { z } from 'zod';

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
  // One process serves exactly one corpus and one authorization boundary.
  CORPUS_SOURCE: z.enum(['filesystem', 'none']).optional(),
  DOCS_ROOT: z.string().min(1).optional(),
  CORPUS_WATCH: booleanish.default(true),

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
  // Scores are normalized to the share of attainable evidence, so this threshold is corpus-size
  // independent. 0.2 is the midpoint of the band that holds perfect recall with no false positives
  // in the committed evaluation; see npm run eval:retrieval.
  SEARCH_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.2),
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

export type CorpusSourceKind = 'filesystem' | 'none';

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
  | { readonly kind: 'filesystem'; readonly rootPath: string; readonly watch: boolean };

export interface AppConfig {
  readonly corpus: CorpusConfig;
  readonly refreshIntervalMs: number;
  readonly corpusLimits: CorpusLimits;
  readonly indexLimits: IndexLimits;
  readonly search: SearchLimits;
}

export type DocRagConfig = PlatformConfig & AppConfig;

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

const selectSourceKind = (env: Env): CorpusSourceKind => {
  if (env.CORPUS_SOURCE) return env.CORPUS_SOURCE;
  if (env.DOCS_ROOT) return 'filesystem';
  return 'none';
};

const buildCorpusConfig = (env: Env, isProduction: boolean): CorpusConfig => {
  const kind = selectSourceKind(env);
  if (kind === 'none') return { kind: 'none' };

  if (!env.DOCS_ROOT) {
    throw new ConfigurationError('CORPUS_SOURCE=filesystem requires DOCS_ROOT');
  }
  if (isProduction && !isAbsolute(env.DOCS_ROOT)) {
    throw new ConfigurationError('DOCS_ROOT must be an absolute path in production');
  }
  const rootPath = resolve(env.DOCS_ROOT);
  const applicationRoot = resolve(process.cwd());
  const applicationRelativeToRoot = relative(rootPath, applicationRoot);
  if (
    isProduction &&
    (applicationRelativeToRoot === '' ||
      (!applicationRelativeToRoot.startsWith('..') && !isAbsolute(applicationRelativeToRoot)))
  ) {
    throw new ConfigurationError(
      'DOCS_ROOT must be a dedicated corpus directory, not the application directory or one of its parents',
    );
  }
  return { kind: 'filesystem', rootPath, watch: env.CORPUS_WATCH };
};

export const buildConfig = (env: Env, isProduction = false): AppConfig => {
  if (env.CHUNK_MIN_CHARS >= env.CHUNK_MAX_CHARS) {
    throw new ConfigurationError('CHUNK_MIN_CHARS must be smaller than CHUNK_MAX_CHARS');
  }

  return {
    corpus: buildCorpusConfig(env, isProduction),
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

export const parseConfig = (
  source: NodeJS.ProcessEnv = process.env,
  isProduction = false,
): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data, isProduction);
};

export const docRagCapabilityConfig = defineCapabilityConfig({
  schema: envSchema,
  build({ base, env }): DocRagConfig {
    return { ...base, ...buildConfig(env, base.isProduction) };
  },
});
