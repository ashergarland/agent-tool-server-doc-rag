import type { AppConfig } from '../config/index.js';
import type { DocumentationProvider } from '../provider/types.js';
import { DocumentationService } from './documentation.js';
import { Guardrails } from './guardrails.js';

export interface Services {
  readonly documentation: DocumentationService;
  readonly guardrails: Guardrails;
}

export const createServices = (config: AppConfig, provider: DocumentationProvider): Services => {
  const guardrails = new Guardrails(config);
  return { guardrails, documentation: new DocumentationService(provider) };
};
