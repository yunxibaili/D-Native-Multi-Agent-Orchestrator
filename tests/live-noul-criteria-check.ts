/**
 * Live check for the restored noul+criteria capability. Needs laya-serve.
 * Confirms the real service accepts a `{true, false}` criteria dict, and that
 * the Decision Layer's answer validation passes on the response.
 *
 * Not part of `npm test`; run with a live service.
 */

import { DecisionError } from '../src/decision/errors.ts';
import { createLayaDecisionProvider, layaMetadata } from '../src/decision/laya.ts';
import type { DecisionQuestion } from '../src/decision/types.ts';

const baseUrl = process.env.DECISION_BASE_URL ?? 'http://127.0.0.1:8077';
const provider = createLayaDecisionProvider({ baseUrl, timeoutMs: 120_000 });

const CASES: Array<[string, Record<string, string> | undefined]> = [
  ['criteria omitted', undefined],
  ['true/false dict', { true: 'the change is safe to ship', false: 'the change is not safe' }],
  ['true only', { true: 'the change is safe to ship' }],
  ['both, upper case', { True: 'yes', False: 'no' }],
];

process.stdout.write('noul + criteria, against the live service\n');
for (const [label, criteria] of CASES) {
  const question: DecisionQuestion =
    criteria === undefined
      ? { type: 'noul', instructions: 'Is this change safe to ship?' }
      : { type: 'noul', instructions: 'Is this change safe to ship?', criteria };
  try {
    const r = await provider.decide({ questions: { safe: question }, task: 'I refactored the event hub and added tests.' });
    const a = r.answers.safe;
    const meta = layaMetadata(r);
    process.stdout.write(
      `  ok   ${label.padEnd(20)} noul=${a?.type === 'noul' ? a.noul.toFixed(4) : 'n/a'} ` +
        `confidence=${a?.type === 'noul' ? a.confidence.toFixed(4) : 'n/a'} ` +
        `implied max=${a?.type === 'noul' ? Math.max(a.noul, 1 - a.noul).toFixed(4) : 'n/a'} ` +
        `[${meta.checkpoint}, ${r.provider.elapsedMs}ms]\n`,
    );
  } catch (e) {
    const name = e instanceof DecisionError ? `${e.name} [${e.code}]` : (e as Error).name;
    process.stdout.write(`  FAIL ${label.padEnd(20)} ${name}: ${(e as Error).message.split('.')[0]}\n`);
    process.exitCode = 1;
  }
}

// The answer space is still empty: a noul reports a likelihood, never a choice.
process.stdout.write('\na noul reports a likelihood, not a selection\n');
