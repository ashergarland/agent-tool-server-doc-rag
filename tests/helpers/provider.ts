import type { DocumentationProvider, DocumentationSearchResult } from '../../src/provider/types.js';

export class TestDocumentationProvider implements DocumentationProvider {
  public search(query: string, limit: number): Promise<readonly DocumentationSearchResult[]> {
    return Promise.resolve(
      [
        {
          source: 'azure/container-apps.md',
          section: 'Create a client',
          content: `Initialize the Azure Container Apps client for ${query}.`,
          score: 0.9,
        },
      ].slice(0, limit),
    );
  }
}
