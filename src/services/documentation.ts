import type { DocumentationProvider, DocumentationSearchResult } from '../provider/types.js';

export class DocumentationService {
  public constructor(private readonly provider: DocumentationProvider) {}

  public async search(input: {
    query: string;
    limit: number;
  }): Promise<{ results: readonly DocumentationSearchResult[] }> {
    return { results: await this.provider.search(input.query, input.limit) };
  }
}
