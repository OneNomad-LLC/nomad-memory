#!/usr/bin/env node

/**
 * QA accuracy: an answer model reads either what nomad-memory retrieved (memory mode) or the
 * whole history (full-context mode, the no-memory baseline), and a grader model judges each
 * answer against the gold answer. Both are Claude models through the Anthropic API, both
 * configurable; the key comes from ANTHROPIC_API_KEY. Scores from this grader are not directly
 * comparable with numbers graded by the official gpt-4o graders.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode memory --runs 3
 *   ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode full-context --runs 3
 *   ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark beam --size 100K --mode memory
 *   ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark mab-cr --mode full-context
 *   npm run bench:qa -- --benchmark lme-s --dry-run      # build prompts, call nothing
 *
 * Options: --answer-model, --grader-model (default claude-opus-5-5), --answer-effort (medium),
 * --grader-effort (low), --limit N, --concurrency (4), --runs (1), --size (BEAM: 100K).
 * Memory mode retrieves once (top 10, the same search() the retrieval benchmarks run), then
 * answers and grades `runs` times. Every API call costs money: check --limit first.
 */

process.env.STORAGE_BACKEND = 'file';

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { embed, getEmbeddingModelName } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { claudeCliComplete } from '../src/claude-cli.js';
import { estimateTokens } from '../src/utils.js';
import { listBeamChats, loadBeamChat, loadMab, mabCorpus, type BeamSize } from './lib/datasets.js';
import { arg, evaluateCorpus, hardware, type CorpusItem } from './lib/retrieval.js';
import { percentiles, writeBenchmarkResult } from './lib/results.js';

const benchmark = arg('benchmark') ?? 'lme-s';
const mode = (arg('mode') ?? 'memory') as 'memory' | 'full-context';
const answerModel = arg('answer-model') ?? 'claude-opus-5-5';
const graderModel = arg('grader-model') ?? 'claude-opus-5-5';
const answerEffort = (arg('answer-effort') ?? 'medium') as 'low' | 'medium' | 'high';
const graderEffort = (arg('grader-effort') ?? 'low') as 'low' | 'medium' | 'high';
const limit = arg('limit') ? Number(arg('limit')) : undefined;
const perType = arg('per-type') ? Number(arg('per-type')) : undefined;
const runs = Number(arg('runs') ?? 1);
const concurrency = Number(arg('concurrency') ?? 4);
const dryRun = process.argv.includes('--dry-run');
/** `api`: the Anthropic API (ANTHROPIC_API_KEY). `claude-cli`: the Claude Code CLI signed in here, on its subscription. */
type Provider = 'api' | 'claude-cli' | 'openrouter';
const provider = (arg('provider') ?? 'api') as 'api' | 'claude-cli';
/**
 * Who grades. `openrouter` calls any model on OpenRouter (OPENROUTER_API_KEY), for the official
 * LongMemEval judge: --grader-provider openrouter --grader-model openai/gpt-4o-2024-08-06.
 */
const graderProvider = (arg('grader-provider') ?? provider) as Provider;
/** A second judge for the same answers, as provider:model, to see how far two graders agree. */
const extraGrader = arg('extra-grader')?.match(/^(api|claude-cli|openrouter):(.+)$/);
/** Leave room for the prompt and the answer inside a 1M-token window. */
const FULL_CONTEXT_MAX_TOKENS = 900_000;

// ── Prompts (disclosed in every result file) ─────────────────────────

const ANSWER_SYSTEM =
  'You answer a question about your past conversations with a user, using only the history provided. ' +
  'If the history does not contain the answer, say that you don\'t know. Answer briefly.';

/** Adapted from the official LongMemEval grading prompts (MIT), one per question type. */
const GRADER = {
  default: (q: string, gold: string, r: string) =>
    `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${q}\n\nCorrect Answer: ${gold}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`,
  temporal: (q: string, gold: string, r: string) =>
    `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: ${q}\n\nCorrect Answer: ${gold}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`,
  update: (q: string, gold: string, r: string) =>
    `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${q}\n\nCorrect Answer: ${gold}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`,
  preference: (q: string, rubric: string, r: string) =>
    `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q}\n\nRubric: ${rubric}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`,
  abstention: (q: string, why: string, r: string) =>
    `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q}\n\nExplanation: ${why}\n\nModel Response: ${r}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`,
  /** BEAM: binary pass on the dataset's rubric (the official BEAM scoring is graded per rubric item). */
  rubric: (q: string, gold: string, rubric: string, r: string) =>
    `I will give you a question, a reference answer, a rubric, and a response from a model. Please answer yes if the response satisfies every rubric item. Otherwise, answer no.\n\nQuestion: ${q}\n\nReference Answer: ${gold}\n\nRubric:\n${rubric}\n\nModel Response: ${r}\n\nDoes the response satisfy every rubric item? Answer yes or no only.`,
};

// ── Tasks ────────────────────────────────────────────────────────────

interface Task {
  id: string;
  type: string;
  question: string;
  /** "Now" for the answer model, when the dataset gives one. */
  date?: string;
  history: CorpusItem[];
  /** Filled in memory mode: the retrieved items, best first. */
  context?: string;
  grade: (response: string) => string;
}

const asHistory = (items: CorpusItem[]): string =>
  items.map(i => (i.createdAt ? `[${i.createdAt}] ${i.text}` : i.text)).join('\n\n');

async function buildTasks(): Promise<Task[]> {
  const tasks: Task[] = [];
  if (benchmark === 'lme-s') {
    // Abstention questions are included here: answering "I don't know" is the right answer.
    // Streamed: parsing the 277 MB file in one piece holds over a gigabyte for the whole run.
    // The file is ordered by question type, so a sample takes --per-type N of each (abstention
    // counted as its own type) rather than the first N questions.
    const { lmePath, streamJsonArray } = await import('./lib/datasets.js');
    const seen = new Map<string, number>();
    for await (const e of streamJsonArray<import('./lib/datasets.js').LmeEntry>(lmePath('s'))) {
      if (perType) {
        const group = e.question_id.endsWith('_abs') ? 'abstention' : e.question_type;
        const n = seen.get(group) ?? 0;
        if (n >= perType) continue;
        seen.set(group, n + 1);
      }
      const items = e.haystack_sessions.map((s, i) => ({
        source: e.haystack_session_ids[i], text: s.map(m => `${m.role}: ${m.content}`).join('\n'), createdAt: e.haystack_dates[i],
      }));
      const gold = String(e.answer);
      const t = e.question_type;
      tasks.push({
        id: e.question_id, type: e.question_id.endsWith('_abs') ? 'abstention' : t, question: e.question, date: e.question_date, history: items,
        grade: r => e.question_id.endsWith('_abs') ? GRADER.abstention(e.question, gold, r)
          : t === 'temporal-reasoning' ? GRADER.temporal(e.question, gold, r)
          : t === 'knowledge-update' ? GRADER.update(e.question, gold, r)
          : t === 'single-session-preference' ? GRADER.preference(e.question, gold, r)
          : GRADER.default(e.question, gold, r),
      });
    }
  } else if (benchmark === 'beam') {
    const size = (arg('size') ?? '100K') as BeamSize;
    for (const id of listBeamChats(size)) {
      const chat = loadBeamChat(size, id);
      for (const q of chat.queries) {
        tasks.push({
          id: q.id, type: q.type, question: q.text, history: chat.items,
          grade: r => GRADER.rubric(q.text, q.gold, q.rubric.map(x => `- ${x}`).join('\n') || '- matches the reference answer', r),
        });
      }
    }
  } else if (benchmark === 'mab-cr') {
    for (const row of await loadMab('Conflict_Resolution')) {
      const { items } = mabCorpus(row);
      row.questions.forEach((question, i) => {
        tasks.push({
          id: `${row.metadata.source}/${i}`, type: row.metadata.source, question, history: items,
          grade: r => GRADER.default(question, (row.answers[i] ?? []).join(' / '), r),
        });
      });
    }
  } else {
    throw new Error(`unknown --benchmark ${benchmark} (lme-s, beam, mab-cr)`);
  }
  return limit ? tasks.slice(0, limit) : tasks;
}

/** Memory mode: retrieve the top 10 for every task, sharing one store per history. */
async function retrieve(tasks: Task[]): Promise<void> {
  await embed(loadConfig(), 'warmup');
  const byHistory = new Map<CorpusItem[], Task[]>();
  for (const t of tasks) byHistory.set(t.history, [...(byHistory.get(t.history) ?? []), t]);
  for (const [history, group] of byHistory) {
    const { outcomes } = await evaluateCorpus(history, group.map(t => ({ id: t.id, type: t.type, text: t.question })), { keepTexts: true });
    const texts = new Map(outcomes.map(o => [o.id, o.texts ?? []]));
    const dateOf = new Map(history.map(i => [i.text, i.createdAt]));
    for (const t of group) {
      t.context = (texts.get(t.id) ?? []).map(x => (dateOf.get(x) ? `[${dateOf.get(x)}] ${x}` : x)).join('\n\n');
    }
  }
}

// ── API calls ────────────────────────────────────────────────────────

const usesApi = provider === 'api' || graderProvider === 'api' || extraGrader?.[1] === 'api';
const usesOpenRouter = graderProvider === 'openrouter' || extraGrader?.[1] === 'openrouter';
const client = dryRun || !usesApi ? null : new Anthropic();

function text(msg: Anthropic.Message): string {
  return msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('').trim();
}

async function answer(t: Task): Promise<{ response: string; inputTokens: number; ms: number; refused: boolean }> {
  const context = mode === 'memory' ? t.context ?? '' : asHistory(t.history);
  const started = performance.now();
  const ask = `${t.date ? `Current date: ${t.date}\n` : ''}Question: ${t.question}`;
  if (provider === 'claude-cli') {
    // The CLI reports no refusal flag and takes no effort setting; input tokens are estimated.
    const response = await claudeCliComplete(ANSWER_SYSTEM, `History:\n\n${context}\n\n${ask}`, answerModel);
    return { response: response.trim(), inputTokens: estimateTokens(context), ms: performance.now() - started, refused: false };
  }
  const msg = await client!.messages.create({
    model: answerModel,
    max_tokens: 16000,
    output_config: { effort: answerEffort },
    system: ANSWER_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        // Cached: in full-context mode every BEAM and MemoryAgentBench question shares its history.
        { type: 'text', text: `History:\n\n${context}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ask },
      ],
    }],
  });
  const u = msg.usage;
  return {
    response: text(msg),
    inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    ms: performance.now() - started,
    refused: msg.stop_reason === 'refusal',
  };
}

/**
 * The official LongMemEval judge settings: temperature 0, ten tokens for a yes or a no.
 * Through the openai client, as src/llm.ts does: the global fetch leaves this process's event
 * loop empty mid-request, and node exits with the await unsettled.
 */
let openRouter: OpenAI | null = null;
async function openRouterComplete(model: string, prompt: string): Promise<string> {
  openRouter ??= new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
  const res = await openRouter.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 10 });
  return res.choices[0]?.message?.content ?? '';
}

async function judge(by: Provider, model: string, prompt: string): Promise<boolean> {
  let reply: string;
  if (by === 'claude-cli') {
    reply = await claudeCliComplete('You grade answers. Reply yes or no only.', prompt, model);
  } else if (by === 'openrouter') {
    reply = await openRouterComplete(model, prompt);
  } else {
    reply = text(await client!.messages.create({
      model, max_tokens: 16000, output_config: { effort: graderEffort }, messages: [{ role: 'user', content: prompt }],
    }));
  }
  return /^\W*yes\b/i.test(reply);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ── Main ─────────────────────────────────────────────────────────────

const started = performance.now();
let tasks = await buildTasks();
if (mode === 'full-context') {
  const tooLong = tasks.filter(t => estimateTokens(asHistory(t.history)) > FULL_CONTEXT_MAX_TOKENS);
  if (tooLong.length > 0) console.error(`skipping ${tooLong.length} questions whose history exceeds ${FULL_CONTEXT_MAX_TOKENS} tokens`);
  tasks = tasks.filter(t => !tooLong.includes(t));
}
console.error(`${tasks.length} questions · ${benchmark} · ${mode} · answer ${answerModel} · grader ${graderModel}`);
if (mode === 'memory') await retrieve(tasks);

if (dryRun) {
  const t = tasks[0];
  const context = mode === 'memory' ? t.context ?? '' : asHistory(t.history);
  console.log(`dry run: ${tasks.length} questions; first one's context is ~${estimateTokens(context)} tokens`);
  console.log(`\nGrader prompt for the first question, with a placeholder response:\n\n${t.grade('<model response>')}`);
  process.exit(0);
}
if (usesOpenRouter && !process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set; the openrouter grader needs it.');
  process.exit(1);
}
if (usesApi && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Set the key, pass --provider claude-cli to use the signed-in Claude Code CLI, or use --dry-run.');
  process.exit(1);
}

interface Graded { id: string; type: string; correct: boolean; extraCorrect?: boolean; refused: boolean; inputTokens: number; ms: number }
const runResults: Graded[][] = [];
for (let r = 1; r <= runs; r++) {
  const graded: Graded[] = [];
  await pool(tasks, concurrency, async t => {
    try {
      const a = await answer(t);
      const prompt = t.grade(a.response);
      const correct = !a.refused && await judge(graderProvider, graderModel, prompt);
      const extraCorrect = extraGrader ? !a.refused && await judge(extraGrader[1] as Provider, extraGrader[2], prompt) : undefined;
      graded.push({ id: t.id, type: t.type, correct, extraCorrect, refused: a.refused, inputTokens: a.inputTokens, ms: a.ms });
      // One line per question, so a run that is cut short still leaves its outcomes in the log.
      console.error(`  ${correct ? 'correct' : 'wrong  '}${extraGrader ? (extraCorrect ? ' (2nd: correct)' : ' (2nd: wrong)  ') : ''} ${t.type} ${t.id}`);
    } catch (err) {
      console.error(`  [failed] ${t.id}: ${err instanceof Error ? err.message : err}`);
    }
    if (graded.length % 25 === 0) console.error(`  run ${r}: ${graded.length}/${tasks.length}`);
  });
  runResults.push(graded);
}

const acc = (gs: Graded[]) => gs.filter(g => g.correct).length / Math.max(1, gs.length);
const accs = runResults.map(acc);
const m = accs.reduce((a, b) => a + b, 0) / accs.length;
const sd = accs.length > 1 ? Math.sqrt(accs.reduce((s, x) => s + (x - m) ** 2, 0) / (accs.length - 1)) : 0;
const perCategory: Record<string, Record<string, unknown>> = {};
for (const g of runResults[0]) {
  const c = (perCategory[g.type] ??= { n: 0, correct: 0 }) as { n: number; correct: number };
  c.n++; if (g.correct) c.correct++;
}
for (const c of Object.values(perCategory)) c.accuracy = (c.correct as number) / (c.n as number);
const all = runResults.flat();

console.log(`\n${benchmark} · ${mode}: accuracy ${(m * 100).toFixed(1)}% ±${(sd * 100).toFixed(1)} over ${runs} run(s), ${runResults[0].length} questions (graded by ${graderModel})`);
if (extraGrader) {
  const agree = all.filter(g => g.extraCorrect === g.correct).length;
  console.log(`second grader ${extraGrader[2]}: accuracy ${(100 * all.filter(g => g.extraCorrect).length / Math.max(1, all.length)).toFixed(1)}%, agrees with the first on ${agree} of ${all.length}`);
}
const path = writeBenchmarkResult({
  benchmark: `qa-${benchmark}${benchmark === 'beam' ? `-${arg('size') ?? '100K'}` : ''}-${mode}`,
  durationMs: Math.round(performance.now() - started),
  config: {
    mode, provider, answerModel, graderProvider, graderModel, extraGrader: extraGrader ? extraGrader[0] : null, answerEffort, graderEffort, runs, questionLimit: limit ?? null, perType: perType ?? null,
    retrieval: mode === 'memory' ? { topK: 10, embeddingModel: getEmbeddingModelName() } : null,
    prompts: { answerSystem: ANSWER_SYSTEM, grader: Object.fromEntries(Object.entries(GRADER).map(([k, f]) => [k, f.toString()])) },
    hardware: hardware(),
  },
  results: {
    accuracy: { mean: m, std: sd }, runs: accs,
    refusals: all.filter(g => g.refused).length,
    ...(extraGrader ? {
      extraGraderAccuracy: all.filter(g => g.extraCorrect).length / Math.max(1, all.length),
      gradersAgree: all.filter(g => g.extraCorrect === g.correct).length / Math.max(1, all.length),
    } : {}),
    answerInputTokensPerQuestion: Math.round(all.reduce((s, g) => s + g.inputTokens, 0) / Math.max(1, all.length)),
    answerLatencyMs: percentiles(all.map(g => g.ms)),
  },
  perCategory,
  notes: `Graded by ${graderModel}${/gpt-4o/.test(graderModel) ? ', the judge the official LongMemEval script uses' : ', not the official gpt-4o graders, so not directly comparable with published numbers'}. ` +
    'Refusals count as incorrect. No server-side model fallback, so every answer and grade comes from the named models.',
});
console.log(`Results JSON: ${path}`);
