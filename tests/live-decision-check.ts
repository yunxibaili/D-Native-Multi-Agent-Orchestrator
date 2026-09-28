/**
 * Live end-to-end check: the TypeScript DecisionProvider against a REAL local
 * laya-serve on 127.0.0.1:8077. Not part of `npm test` (it needs the Python
 * side); run by hand after `laya-serve` is up.
 */

import { createLayaDecisionProvider } from '../src/decision/laya.ts';

const provider = createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:8077', timeoutMs: 60_000 });

const probe = await provider.probe();
process.stdout.write(`probe  ok=${probe.ok}  ${probe.detail}\n`);
for (const w of probe.warnings) process.stdout.write(`  warn ${w}\n`);

const CASES = [
  { label: 'en: refactor', task: 'Refactor the event hub in src/core/event-hub.ts to support multiple subscribers, and update the unit tests.' },
  { label: 'en: bug report', task: 'The orchestrator test suite fails on Windows with EINVAL when the smoke test runs.' },
  { label: 'zh: refactor', task: '请重构 src/core/event-hub.ts，让它支持多个订阅者，并同步更新单元测试。' },
  { label: 'zh: bug report', task: '编排器的测试在 Windows 上失败了，smoke test 运行时提示 EINVAL 错误。' },
  { label: 'en: code review', task: 'Review the diff for src/decision/laya.ts and report correctness problems with the validation logic.' },
];

process.stdout.write('\n');
for (const c of CASES) {
  try {
    const d = await provider.decide({ task: c.task });
    const top = Object.entries(d.work_kind_probabilities)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join('  ');
    process.stdout.write(
      `${c.label.padEnd(16)} ${String(d.work_kind).padEnd(15)} conf=${d.work_kind_confidence.toFixed(3)}  ` +
        `complexity=${d.complexity} (${d.complexity_score.toFixed(2)})  ` +
        `review=${d.review_required ? 'yes' : 'no'} (noul ${d.review_noul.toFixed(3)})\n` +
        `${''.padEnd(16)} checkpoint=${d.provenance.checkpoint} ${d.provenance.elapsedMs}ms\n` +
        `${''.padEnd(16)} ${top}\n` +
        `${''.padEnd(16)} reason: ${d.provenance.reason}\n`,
    );
  } catch (e) {
    process.stdout.write(`${c.label}  FAILED -> ${(e as Error).name}: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
