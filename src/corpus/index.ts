import type { AppConfig } from '../config/index.js';
import { createAzureBlobContainerReader } from './azure-client.js';
import { AzureBlobCorpusSource } from './blob.js';
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
  if (config.corpus.kind === 'azure-blob') {
    return new AzureBlobCorpusSource({
      prefix: config.corpus.prefix,
      limits: config.corpusLimits,
      reader: createAzureBlobContainerReader({
        accountName: config.corpus.accountName,
        containerName: config.corpus.containerName,
      }),
    });
  }
  return undefined;
};

export * from './types.js';
