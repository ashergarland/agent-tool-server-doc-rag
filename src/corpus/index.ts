import type { AppConfig } from '../config/index.js';
import { FileSystemCorpusSource } from './filesystem.js';
import type { CorpusSource } from './types.js';

/** Builds the single corpus source for this process, or undefined when none is configured. */
export const createCorpusSource = (config: AppConfig): CorpusSource | undefined => {
  if (config.corpus.kind === 'filesystem') {
    return new FileSystemCorpusSource({
      rootPath: config.corpus.rootPath,
      limits: config.corpusLimits,
    });
  }
  return undefined;
};

export * from './types.js';
