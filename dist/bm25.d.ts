/**
 * BM25 keyword scoring (Robertson and Zaragoza's Okapi BM25, k1 = 1.2, b = 0.75).
 *
 * Unlike a "does the term appear" test, BM25 counts how often a term appears, discounts long
 * documents, and weights rare terms more, so the keyword ranking has an order instead of a
 * long tie.
 */
/** The Porter stem of a lowercased word, so "visited", "visits" and "visiting" all meet "visit". */
export declare function stem(word: string): string;
/** Lowercased, stemmed word tokens. Letters and digits of any script count as word characters. */
export declare function tokenize(text: string): string[];
/**
 * BM25 score per document id for the documents that match at least one query term, scaled so
 * the best match scores 1. Terms capitalised in the query (names) count half again as much.
 */
export declare function bm25Scores(query: string, docs: Array<{
    id: string;
    text: string;
}>): Map<string, number>;
