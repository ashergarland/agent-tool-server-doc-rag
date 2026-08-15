/**
 * Context measurement helpers. The estimator is intentionally model independent: it only bounds the
 * size of returned evidence so callers can budget their own context windows.
 *
 * Isolated from ranking and transports as an extraction candidate.
 */
export interface ContextMeasurement {
  readonly characters: number;
  readonly approximateTokens: number;
}

const averageCharactersPerToken = 4;

export const estimateTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / averageCharactersPerToken);

export const measureContext = (parts: readonly string[]): ContextMeasurement => {
  const characters = parts.reduce((total, part) => total + part.length, 0);
  return { characters, approximateTokens: Math.ceil(characters / averageCharactersPerToken) };
};
