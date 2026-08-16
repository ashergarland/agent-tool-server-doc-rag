import type { IndexManager } from '../indexing/lifecycle.js';
import type { DocumentationSearchService } from '../search/service.js';

export interface Services {
  readonly search: DocumentationSearchService;
  readonly index: IndexManager;
}

export const createServices = (
  index: IndexManager,
  search: DocumentationSearchService,
): Services => ({ index, search });
