export interface BlobClientOptions {
  readonly accountName: string;
  readonly containerName: string;
}

export const createBlobClient = (options: BlobClientOptions): BlobClient =>
  new BlobClient(options.accountName, options.containerName);

export class BlobClient {
  public constructor(
    private readonly accountName: string,
    private readonly containerName: string,
  ) {}

  public downloadRange(name: string, maxBytes: number): Promise<Buffer> {
    return fetchRange(this.accountName, this.containerName, name, maxBytes);
  }
}
