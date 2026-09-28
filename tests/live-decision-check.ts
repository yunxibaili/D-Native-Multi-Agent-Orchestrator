/**
 * Live end-to-end check against a REAL local laya-serve on 127.0.0.1:8077.
 *
 * Not part of `npm test`: this one needs the Python side running. Start it with
 *   $env:HF_ENDPOINT = "https://hf-mirror.com"   # if huggingface.co is blocked
 *   laya-serve
 * then run:
 *   node tests/live-decision-check.ts
 *
 * It only CLASSIFIES. No agent is selected and nothing is executed.
 */

import { DecisionError } from '../src/decision/errors.ts';
import { createLayaDecisionProvider, layaMetadata } from '../src/decision/laya.ts';
import { classifyTask, WORK_KINDS } from '../src/decision/routing.ts';
import { toProbability, type DecisionRequest } from '../src/decision/types.ts';

const baseUrl = process.env.DECISION_BASE_URL ?? 'http://127.0.0.1:8077';
const provider = createLayaDecisionProvider({ baseUrl, timeoutMs: 120_000 });

// 1. Is the provider up at all?
const probe = await provider.probe();
process.stdout.write(`probe  ok=${probe.ok}  ${probe.detail}\n`);
for (const w of probe.warnings) process.stdout.write(`  warn ${w}\n`);
if (!probe.ok) {
  process.stdout.write('\nStart laya-serve first. Nothing else to do.\n');
  process.exitCode = 1;
}

// 2. A question set that is NOT the routing preset, through the generic layer.
const custom: DecisionRequest = {
  questions: {
    language_of_task: {
      type: 'choice',
      instructions: 'Which language is this task written in?',
      criteria: { english: 'Latin script', chinese: 'Han script' },
    },
    urgency: { type: 'score', instructions: 'How urgent is it?', criteria: ['low', 'medium', 'high'] },
  },
  task: 'the CI build is red on Windows',
};
try {
  const r = await provider.decide(custom);
  const lang = r.answers.language_of_task;
  const urg = r.answers.urgency;
  const meta = layaMetadata(r);
  process.stdout.write(
    `\ngeneric layer\n` +
      `  language_of_task  ${lang?.type === 'choice' ? `${lang.choice} (conf ${lang.confidence.toFixed(3)})` : 'n/a'}\n` +
      `  urgency           ${urg?.type === 'score' ? `${urg.level} (score ${urg.score.toFixed(2)})` : 'n/a'}\n` +
      `  answered by       ${meta.checkpoint} / ${r.provider.model} in ${r.provider.elapsedMs} ms\n` +
      `  reason            ${meta.reason}\n`,
  );
} catch (e) {
  process.stdout.write(`\ngeneric layer FAILED -> ${(e as Error).name}: ${(e as Error).message}\n`);
  process.exitCode = 1;
}

// 3. A degenerate question set must be refused locally, with no request sent.
try {
  await provider.decide({ questions: { c: { type: 'choice', instructions: '?', criteria: { only: 'one' } } }, task: 'x' });
  process.stdout.write('\nONE-OPTION CHOICE WAS NOT REFUSED -- this is a bug\n');
  process.exitCode = 1;
} catch (e) {
  process.stdout.write(`\nrequest validation  ${(e as Error).name} (expected)\n  ${(e as Error).message.split('.')[0]}\n`);
}

// 4. The routing preset.
const CASES = [
  { label: 'en: refactor', task: 'Refactor the event hub in src/core/event-hub.ts to support multiple subscribers, and update the unit tests.' },
  { label: 'en: bug report', task: 'The orchestrator test suite fails on Windows with EINVAL when the smoke test runs.' },
  { label: 'en: code review', task: 'Review the diff for src/decision/laya.ts and report correctness problems with the validation logic.' },
  { label: 'zh: refactor', task: '请重构 src/core/event-hub.ts，让它支持多个订阅者，并同步更新单元测试。' },
  { label: 'zh: bug report', task: '编排器的测试在 Windows 上失败了，smoke test 运行时提示 EINVAL 错误。' },
];

process.stdout.write('\nrouting preset\n');
for (const c of CASES) {
  try {
    const d = await classifyTask(provider, { task: c.task });
    const meta = layaMetadata(d);
    // Probabilities are narrowed defensively, mirroring what a caller must do.
    const dist = WORK_KINDS.map((k) => {
      const p = toProbability(d.work_kind_probabilities[k]);
      return `${k} ${(p ?? 0).toFixed(3)}`;
    }).join('  ');
    process.stdout.write(
      `  ${c.label.padEnd(16)} ${d.work_kind.padEnd(15)} conf=${d.work_kind_confidence.toFixed(3)}  ` +
        `complexity=${d.complexity} (${d.complexity_score.toFixed(2)})  ` +
        `review=${d.review_required ? 'yes' : 'no'} (noul ${d.review_noul.toFixed(3)})\n` +
        `${''.padEnd(18)} ${meta.checkpoint} ${d.provider.elapsedMs}ms  ${dist}\n`,
    );
  } catch (e) {
    const name = e instanceof DecisionError ? `${e.name} [${e.code}]` : (e as Error).name;
    process.stdout.write(`  ${c.label}  FAILED -> ${name}: ${(e as Error).message.split('.')[0]}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write('\nNo agent was selected and nothing was executed.\n');
