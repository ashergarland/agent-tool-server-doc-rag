export interface DocumentationSearchResult {
  readonly source: string;
  readonly section: string | undefined;
  readonly content: string;
  readonly score: number;
}

export interface DocumentationProvider {
  search(query: string, limit: number): Promise<readonly DocumentationSearchResult[]>;
}
