/**
 * Lexical tokenization. Text is normalized to lowercase terms and identifiers are expanded into the
 * variants developers actually type: camelCase, PascalCase, snake_case, kebab-case, dotted names and
 * path segments. Compound identifiers are also retained whole so exact identifier matches rank.
 */
const unitPattern = /[\p{L}\p{N}_]+(?:[./-]+[\p{L}\p{N}_]+)*/gu;
const separatorPattern = /[./-]+/u;

const splitIdentifier = (segment: string): string[] => {
  const parts = segment
    .replaceAll(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replaceAll(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replaceAll(/(\p{L})(\p{N})/gu, '$1 $2')
    .replaceAll(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(/[_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
  return parts.length > 1 ? parts : [];
};

export const isCompoundTerm = (term: string): boolean => separatorPattern.test(term);

/**
 * Function words carry no retrieval evidence on their own. They stay in the index so phrases and
 * identifiers still match, but a query made only of them cannot produce evidence.
 */
export const stopWords: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'use',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

export const tokenize = (value: string, maxTokens = 20_000): string[] => {
  const terms: string[] = [];
  for (const match of value.matchAll(unitPattern)) {
    if (terms.length >= maxTokens) break;
    const unit = match[0];
    const segments = unit.split(separatorPattern).filter((segment) => segment.length > 0);
    if (segments.length > 1) terms.push(unit.toLowerCase());
    for (const segment of segments) {
      const lower = segment.toLowerCase();
      terms.push(lower);
      for (const part of splitIdentifier(segment)) {
        if (part !== lower) terms.push(part);
      }
    }
  }
  return terms;
};

export const termFrequencies = (value: string, weight = 1): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const term of tokenize(value)) counts.set(term, (counts.get(term) ?? 0) + weight);
  return counts;
};
