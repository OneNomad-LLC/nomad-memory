/**
 * BM25 keyword scoring (Robertson and Zaragoza's Okapi BM25, k1 = 1.2, b = 0.75).
 *
 * Unlike a "does the term appear" test, BM25 counts how often a term appears, discounts long
 * documents, and weights rare terms more, so the keyword ranking has an order instead of a
 * long tie.
 */
import { stemmer as porter } from 'stemmer';
const K1 = 1.2;
// Length normalisation earns its place on chat data: on BEAM 100K recall_all@10 is 22.9% at
// 0.75 and 17.1% at 0. LongMemEval S is the same either way.
const B = 0.75;
const STOP = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'what', 'when', 'where', 'which',
    'who', 'whom', 'how', 'why', 'that', 'this', 'these', 'those',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his',
    'her', 'its', 'our', 'their', 'if', 'for', 'from', 'with', 'about',
    'into', 'and', 'but', 'or', 'not', 'no', 'so', 'too', 'very', 'just',
    'also', 'than', 'both', 'any', 'all', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'me',
]);
// A corpus has far fewer distinct words than words, so each word is stemmed once.
const stems = new Map();
const STEM_CACHE_MAX = 200_000;
/** The Porter stem of a lowercased word, so "visited", "visits" and "visiting" all meet "visit". */
export function stem(word) {
    let s = stems.get(word);
    if (s === undefined) {
        // Porter's rules are for English; other scripts pass through.
        s = /^[a-z']+$/.test(word) ? porter(word.endsWith("'s") ? word.slice(0, -2) : word) : word;
        if (stems.size >= STEM_CACHE_MAX)
            stems.clear();
        stems.set(word, s);
    }
    return s;
}
// ASCII letters and digits, plus everything from Latin-1 letters up except the punctuation
// blocks (dashes, curly quotes, CJK punctuation). Five times faster than /[\p{L}\p{N}]+/u,
// and search tokenizes the whole corpus for every query.
const WORD = /[a-zA-Z0-9\u00c0-\u1fff\u2c00-\u2fff\u3040-\uffff]+(?:'s)?/g;
/** Lowercased, stemmed word tokens. Letters and digits of any script count as word characters. */
export function tokenize(text) {
    return (text.toLowerCase().match(WORD) ?? []).map(stem);
}
/**
 * BM25 score per document id for the documents that match at least one query term, scaled so
 * the best match scores 1. Terms capitalised in the query (names) count half again as much.
 */
export function bm25Scores(query, docs) {
    const boost = new Map();
    for (const word of query.match(WORD) ?? []) {
        const lower = word.toLowerCase();
        if (lower.length < 2 || STOP.has(lower))
            continue;
        const proper = /^\p{Lu}/u.test(word) && word.length > 2;
        const term = stem(lower);
        boost.set(term, Math.max(boost.get(term) ?? 0, proper ? 1.5 : 1));
    }
    const scores = new Map();
    if (boost.size === 0 || docs.length === 0)
        return scores;
    const df = new Map();
    const matched = [];
    let totalLength = 0;
    for (const doc of docs) {
        const tokens = tokenize(doc.text);
        totalLength += tokens.length;
        const tf = new Map();
        for (const t of tokens)
            if (boost.has(t))
                tf.set(t, (tf.get(t) ?? 0) + 1);
        if (tf.size === 0)
            continue;
        for (const t of tf.keys())
            df.set(t, (df.get(t) ?? 0) + 1);
        matched.push({ id: doc.id, length: tokens.length, tf });
    }
    const avgLength = totalLength / docs.length || 1;
    let best = 0;
    for (const doc of matched) {
        let score = 0;
        for (const [term, tf] of doc.tf) {
            const n = df.get(term);
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
            score += boost.get(term) * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / avgLength));
        }
        scores.set(doc.id, score);
        if (score > best)
            best = score;
    }
    if (best > 0)
        for (const [id, s] of scores)
            scores.set(id, s / best);
    return scores;
}
//# sourceMappingURL=bm25.js.map