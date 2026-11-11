// BM25's usual defaults: k1 caps how much a repeated term adds, b how much a
// long message is penalised for its length.
const K1 = 1.2;
const B = 0.75;

// A stem shorter than this is too ambiguous to keep, so the word stays whole.
const MIN_STEM_LENGTH = 3;

// Tried in order; the first suffix that leaves a long enough stem is replaced.
// "ss" maps to itself so "class" keeps its last s.
const SUFFIXES: readonly (readonly [suffix: string, replacement: string])[] = [
  ['ss', 'ss'],
  ['ies', 'y'],
  ['ing', ''],
  ['ed', ''],
  ['es', ''],
  ['s', ''],
];

/**
 * Lowercased words of `text`, each reduced to its stem, so that inflections of
 * a word compare equal.
 */
export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map(stem);
}

/**
 * Strips one common English suffix, then a final "e", so "prices", "priced",
 * "pricing" and "price" all become "pric". Crude, but both the query and the
 * stored text go through it, so only which words meet matters, not whether a
 * stem is a real word.
 */
export function stem(word: string): string {
  let result = word;
  for (const [suffix, replacement] of SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    const candidate = word.slice(0, -suffix.length) + replacement;
    if (candidate.length >= MIN_STEM_LENGTH) {
      result = candidate;
      break;
    }
  }
  const withoutE = result.endsWith('e') ? result.slice(0, -1) : result;
  return withoutE.length >= MIN_STEM_LENGTH ? withoutE : result;
}

/**
 * The BM25 score of each document against the query, in document order.
 * Higher is better; a document sharing no term with the query scores 0.
 */
export function bm25(
  query: readonly string[],
  documents: readonly (readonly string[])[],
): number[] {
  const docs = documents.map((document) => ({
    length: document.length,
    counts: termCounts(document),
  }));
  const averageLength =
    docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;

  // Rarer terms weigh more: the idf of each distinct query term.
  const weights = new Map<string, number>();
  for (const term of new Set(query)) {
    const containing = docs.filter((doc) => doc.counts.has(term)).length;
    weights.set(
      term,
      Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5)),
    );
  }

  return docs.map(({ length, counts }) => {
    const lengthNorm = 1 - B + (B * length) / averageLength;
    let score = 0;
    for (const [term, weight] of weights) {
      const frequency = counts.get(term) ?? 0;
      score += (weight * frequency * (K1 + 1)) / (frequency + K1 * lengthNorm);
    }
    return score;
  });
}

function termCounts(document: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}
