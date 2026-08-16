import type { ContainerClient } from '@azure/storage-blob';
import {
  toCorpusUnavailable,
  type BlobContainerReader,
  type BlobDownload,
  type BlobItem,
} from './blob.js';

export interface AzureBlobReaderOptions {
  readonly accountName: string;
  readonly containerName: string;
}

/** Fixed public cloud endpoint. Arbitrary endpoints, SAS tokens and account keys are not supported. */
const endpointFor = (accountName: string, containerName: string): string =>
  `https://${accountName}.blob.core.windows.net/${containerName}`;

const readStream = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ content: Buffer; truncated: boolean }> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    chunks.push(buffer);
    if (total > maxBytes) break;
  }
  const content = Buffer.concat(chunks);
  return { content: content.subarray(0, maxBytes), truncated: content.length > maxBytes };
};

/**
 * Container-scoped reader backed by managed identity. The deployment alone selects the account,
 * container and prefix; callers can never redirect it.
 */
export const createAzureBlobContainerReader = (
  options: AzureBlobReaderOptions,
): BlobContainerReader => {
  let clientPromise: Promise<ContainerClient> | undefined;

  const client = async (): Promise<ContainerClient> => {
    clientPromise ??= (async () => {
      const [{ ContainerClient }, { DefaultAzureCredential }] = await Promise.all([
        import('@azure/storage-blob'),
        import('@azure/identity'),
      ]);
      return new ContainerClient(
        endpointFor(options.accountName, options.containerName),
        new DefaultAzureCredential(),
      );
    })();
    return clientPromise;
  };

  return {
    async *list({ prefix, signal }): AsyncIterable<BlobItem> {
      const container = await client();
      try {
        const listOptions = signal ? { prefix, abortSignal: signal } : { prefix };
        for await (const blob of container.listBlobsFlat(listOptions)) {
          yield {
            name: blob.name,
            contentLength: blob.properties.contentLength ?? 0,
            etag: blob.properties.etag ?? '',
            lastModified: blob.properties.lastModified?.toISOString(),
          };
        }
      } catch (error) {
        throw toCorpusUnavailable(error);
      }
    },

    async download(name, { maxBytes, signal }): Promise<BlobDownload | undefined> {
      const container = await client();
      try {
        const response = await container
          .getBlobClient(name)
          .download(0, maxBytes + 1, signal ? { abortSignal: signal } : {});
        if (!response.readableStreamBody) return undefined;
        const { content, truncated } = await readStream(response.readableStreamBody, maxBytes);
        return { content, truncated, etag: response.etag ?? '' };
      } catch (error) {
        const status = (error as { statusCode?: number } | null)?.statusCode;
        if (status === 404) return undefined;
        throw toCorpusUnavailable(error);
      }
    },
  };
};
