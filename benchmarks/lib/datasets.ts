/**
 * Loaders for the benchmark datasets, each turned into a corpus plus queries for the
 * retrieval engine (retrieval.ts) and the QA harness (qa.ts).
 *
 *   LongMemEval  MIT, `longmemeval_s_cleaned.json` / `longmemeval_m_cleaned.json` (Sep 2025)
 *   BEAM         code MIT, data CC BY-SA 4.0 (github.com/mohammadtavakoli78/BEAM)
 *   MemoryAgentBench  MIT (huggingface.co/datasets/ai-hyz/MemoryAgentBench)
 *
 * `bash benchmarks/download-datasets.sh` fetches all of them into benchmarks/data/.
 */

import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusItem, RetrievalQuery } from './retrieval.js';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function requireData(path: string, hint: string): void {
  if (!existsSync(path)) {
    console.error(`Dataset not found at ${path}\nDownload it first: bash benchmarks/download-datasets.sh ${hint}`);
    process.exit(1);
  }
}

// ── LongMemEval ──────────────────────────────────────────────────────

export interface LmeEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

export type LmeVariant = 's' | 'm';
export type Granularity = 'session' | 'turn';

export const lmePath = (variant: LmeVariant): string => join(DATA_DIR, `longmemeval_${variant}_cleaned.json`);

/**
 * Stream the entries of a top-level JSON array one at a time. The M file is 2.7 GB, past what
 * one JSON.parse (or one JS string) can hold; each entry on its own is a few MB.
 */
export async function* streamJsonArray<T>(path: string): AsyncGenerator<T> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parts: string[] = [];
  let start = -1;
  for await (const chunk of createReadStream(path, { encoding: 'utf-8', highWaterMark: 1 << 22 }) as AsyncIterable<string>) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') {
        depth++;
        if (depth === 2) { start = i; parts = []; }
      } else if (c === '}' || c === ']') {
        if (depth === 2) {
          parts.push(chunk.slice(start, i + 1));
          yield JSON.parse(parts.join('')) as T;
          parts = [];
          start = -1;
        }
        depth--;
      }
    }
    if (depth >= 2 && start >= 0) { parts.push(chunk.slice(start)); start = 0; }
  }
}

/**
 * LongMemEval questions, abstention questions left out (the official retrieval evaluation
 * excludes them: their "evidence" sessions don't hold an answer). `perType` keeps the first N
 * of each question type, a fixed sample used where the full set would take hours.
 */
export async function* loadLongMemEval(variant: LmeVariant, opts: { perType?: number; limit?: number } = {}): AsyncGenerator<LmeEntry> {
  const path = lmePath(variant);
  requireData(path, variant === 's' ? 'lme' : 'lme-m');
  const seen = new Map<string, number>();
  let taken = 0;
  // Streamed for S too: parsing its 277 MB in one piece holds over a gigabyte for the whole run.
  for await (const e of streamJsonArray<LmeEntry>(path)) {
    if (e.question_id.endsWith('_abs')) continue;
    if (opts.perType) {
      const n = seen.get(e.question_type) ?? 0;
      if (n >= opts.perType) continue;
      seen.set(e.question_type, n + 1);
    }
    yield e;
    if (opts.limit && ++taken >= opts.limit) return;
  }
}

/** The latest haystack date: "now" for relative dates in the question. */
export function lmeReferenceDate(e: LmeEntry): number | undefined {
  const times = e.haystack_dates.map(d => Date.parse(d)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * One question's haystack as a corpus. Session level: one item per session, the official
 * evidence being `answer_session_ids`. Turn level: one item per turn, the evidence being the
 * turns marked `has_answer`. Null when the question has no evidence at that level.
 */
export function lmeCorpus(e: LmeEntry, granularity: Granularity): { items: CorpusItem[]; query: RetrievalQuery } | null {
  const items: CorpusItem[] = [];
  const relevant: string[] = [];
  e.haystack_sessions.forEach((session, si) => {
    const sid = e.haystack_session_ids[si];
    const createdAt = e.haystack_dates[si] ?? '';
    if (granularity === 'session') {
      items.push({ source: sid, text: session.map(m => `${m.role}: ${m.content}`).join('\n'), createdAt });
    } else {
      session.forEach((m, ti) => {
        const source = `${sid}#${ti}`;
        items.push({ source, text: `${m.role}: ${m.content}`, createdAt });
        if (m.has_answer) relevant.push(source);
      });
    }
  });
  if (granularity === 'session') relevant.push(...(e.answer_session_ids ?? []));
  if (relevant.length === 0) return null;
  return {
    items,
    query: { id: e.question_id, type: e.question_type, text: e.question, relevant, referenceDate: lmeReferenceDate(e) },
  };
}

// ── BEAM ─────────────────────────────────────────────────────────────

export const BEAM_SIZES = ['100K', '500K', '1M'] as const;
export type BeamSize = typeof BEAM_SIZES[number];

interface BeamMessage { role: string; id: number; content: string; time_anchor?: string }
interface BeamQuestion {
  question: string;
  answer?: string; ideal_answer?: string; ideal_response?: string; ideal_summary?: string;
  rubric?: string[];
  source_chat_ids?: number[];
  conversation_references?: string[] | string;
}

export interface BeamChat {
  id: string;
  size: BeamSize;
  items: CorpusItem[];
  /** Every probing question; `relevant` is set only where the dataset names its evidence messages. */
  queries: Array<RetrievalQuery & { gold: string; rubric: string[] }>;
}

/** "March-15-2024" → ISO. */
function beamDate(anchor: string | undefined): string | undefined {
  if (!anchor) return undefined;
  const t = Date.parse(anchor.replace(/-/g, ' '));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function listBeamChats(size: BeamSize): string[] {
  const dir = join(DATA_DIR, 'beam', size);
  requireData(dir, 'beam');
  return readdirSync(dir).filter(d => existsSync(join(dir, d, 'chat.json'))).sort((a, b) => Number(a) - Number(b));
}

/**
 * One BEAM chat: every message is an item (its source the message id), and evidence comes from
 * `source_chat_ids`, or "chat_id: N" in `conversation_references`. Questions naming neither
 * (abstention, summarisation, most preference and instruction questions) carry no `relevant`
 * and so count only in QA, never in retrieval scores.
 */
export function loadBeamChat(size: BeamSize, id: string): BeamChat {
  const dir = join(DATA_DIR, 'beam', size, id);
  const batches = JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf-8')) as Array<{ turns: BeamMessage[][] }>;
  const items: CorpusItem[] = [];
  let anchor: string | undefined;
  let latest = 0;
  for (const batch of batches) {
    for (const turn of batch.turns) {
      for (const m of turn) {
        anchor = beamDate(m.time_anchor) ?? anchor;
        if (anchor) latest = Math.max(latest, Date.parse(anchor));
        items.push({ source: String(m.id), text: `${m.role}: ${m.content}`, createdAt: anchor });
      }
    }
  }
  const probing = JSON.parse(readFileSync(join(dir, 'probing_questions', 'probing_questions.json'), 'utf-8')) as Record<string, BeamQuestion[]>;
  const queries: BeamChat['queries'] = [];
  for (const [type, list] of Object.entries(probing)) {
    list.forEach((q, i) => {
      const refs = Array.isArray(q.conversation_references) ? q.conversation_references.join(' ') : (q.conversation_references ?? '');
      const ids = q.source_chat_ids?.length
        ? q.source_chat_ids
        : [...refs.matchAll(/chat_id:\s*(\d+)/g)].map(m => Number(m[1]));
      const gold = q.answer ?? q.ideal_answer ?? q.ideal_response ?? q.ideal_summary ?? '';
      queries.push({
        id: `${size}/${id}/${type}/${i}`, type, text: q.question,
        relevant: ids.length > 0 ? [...new Set(ids.map(String))] : undefined,
        referenceDate: latest || undefined, gold, rubric: q.rubric ?? [],
      });
    });
  }
  return { id, size, items, queries };
}

// ── MemoryAgentBench ─────────────────────────────────────────────────

export interface MabRow {
  context: string;
  questions: string[];
  answers: string[][];
  metadata: { source: string; qa_pair_ids?: string[] };
}

export type MabSplit = 'Conflict_Resolution' | 'Accurate_Retrieval';

export async function loadMab(split: MabSplit): Promise<MabRow[]> {
  const path = join(DATA_DIR, 'mab', `${split}.parquet`);
  requireData(path, 'mab');
  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const buf = readFileSync(path);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return (await parquetReadObjects({ file, compressors })) as unknown as MabRow[];
}

/**
 * A MemoryAgentBench context as a corpus. FactConsolidation contexts are numbered fact lists
 * where a later fact overrides an earlier one, so each fact is an item stamped one minute after
 * the one before. Other contexts are split on blank lines into passages of up to 1,500
 * characters. The dataset labels no evidence passages, so queries carry gold answers only and
 * are scored by whether a retrieved item contains one; questions whose answer never appears
 * verbatim in the context can't be scored that way and are dropped (the count is reported).
 */
export function mabCorpus(row: MabRow): { items: CorpusItem[]; queries: RetrievalQuery[]; unscorable: number } {
  const base = Date.parse('2024-01-01T00:00:00Z');
  const items: CorpusItem[] = [];
  if (row.metadata.source.startsWith('factconsolidation')) {
    for (const line of row.context.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.*)$/);
      if (m) items.push({ source: m[1], text: m[2], createdAt: new Date(base + Number(m[1]) * 60_000).toISOString() });
    }
  } else {
    let buf = '';
    const push = () => { if (buf.trim()) items.push({ source: String(items.length), text: buf.trim(), createdAt: new Date(base + items.length * 60_000).toISOString() }); buf = ''; };
    for (const para of row.context.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length > 1500) push();
      buf += (buf ? '\n\n' : '') + para;
      while (buf.length > 1500) { const head = buf.slice(0, 1500); buf = buf.slice(1500); items.push({ source: String(items.length), text: head, createdAt: new Date(base + items.length * 60_000).toISOString() }); }
    }
    push();
  }
  const lowerContext = row.context.toLowerCase();
  const queries: RetrievalQuery[] = [];
  let unscorable = 0;
  row.questions.forEach((text, i) => {
    const answers = (row.answers[i] ?? []).filter(a => a && lowerContext.includes(a.toLowerCase()));
    if (answers.length === 0) { unscorable++; return; }
    queries.push({ id: `${row.metadata.source}/${i}`, type: row.metadata.source, text, answers });
  });
  return { items, queries, unscorable };
}
