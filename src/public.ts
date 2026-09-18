export { capability, createIndexManager } from './capability.js';
export {
  buildConfig,
  docRagCapabilityConfig,
  envSchema,
  type AppConfig,
  type CorpusConfig,
  type CorpusLimits,
  type DocRagConfig,
  type IndexLimits,
  type SearchLimits,
} from './config/index.js';
export { FileSystemCorpusSource } from './corpus/filesystem.js';
export {
  type CorpusDocument,
  type CorpusReadResult,
  type CorpusSource,
  type CorpusSourceKind,
} from './corpus/types.js';
export { IndexManager, type IndexSnapshot, type IndexState } from './indexing/lifecycle.js';
export { capabilityManifest } from './manifest.js';
export {
  DocumentationSearchService,
  type SearchInput,
  type SearchResponse,
  type SearchResultItem,
  type SearchStatus,
} from './search/service.js';
export { type Services } from './services/index.js';
export { capabilityTools, searchDocsOutputSchema, searchDocsTool } from './tools/definitions.js';
