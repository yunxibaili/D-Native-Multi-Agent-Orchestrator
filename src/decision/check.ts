/**
 * decision/check.ts -- the smallest useful way to exercise a DecisionProvider.
 *
 *   node src/decision/check.ts "your task text"            # one routing decision
 *   node src/decision/check.ts --probe                      # is the provider up?
 *   node src/decision/check.ts --provider http://host:8077 "text"
 *
 * This is a developer entry point only. It is NOT wired into the orchestrator
 * and it does NOT select an agent: it prints a classification and stops. The
 * Python side is somebody else's job -- start laya-serve yourself; this script
 * never launches it.
 */

import { createLayaDecisionProvider, layaMetadata } from './laya.ts';
import { classifyTask } from './routing.ts';
import { DecisionError } from './errors.ts';

function usage(): never {
  process.stdout.write(
    [
      'usage:',
      '  node src/decision/check.ts "task text"',
      '  node src/decision/check.ts --probe',
      '  node src/decision/check.ts --provider <baseUrl> "task text"',
      '  node src/decision/check.ts --provider <remoteUrl> --allow-remote "task text"',
      '',
      'Requires a local laya-serve (default http://127.0.0.1:8077).',
      'The endpoint must be loopback: a decision request carries the task text,',
      'so a remote baseUrl is refused unless --allow-remote is passed.',
      'On a machine where huggingface.co is unreachable, also set:',
      '  $env:HF_ENDPOINT = "https://hf-mirror.com"',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let baseUrl = 'http://127.0.0.1:8077';
let allowRemote = false;
let probeOnly = false;

while (args.length > 0 && args[0].startsWith('--')) {
  const flag = args.shift();
  if (flag === '--provider') {
    if (args.length === 0) usage();
    baseUrl = args.shift() as string;
  } else if (flag === '--allow-remote') {
    allowRemote = true;
  } else if (flag === '--probe') {
    probeOnly = true;
  } else if (flag === '--help' || flag === '-h') {
    usage();
  } else {
    usage();
  }
}

const task = args.join(' ').trim();
if (!probeOnly && task.length === 0) usage();

try {
  // Constructed inside the try so a configuration error -- a non-loopback or
  // malformed baseUrl -- is reported like every other DecisionError rather than
  // escaping as an unhandled rejection.
  const provider = createLayaDecisionProvider({ baseUrl, allowRemote, timeoutMs: 60_000 });

  const probe = await provider.probe();
  process.stdout.write(`provider  ${provider.name} @ ${probe.endpoint}\n`);
  process.stdout.write(`probe     ok=${probe.ok}  ${probe.detail}\n`);
  for (const w of probe.warnings) {
    process.stdout.write(`  warn    ${w}\n`);
  }
  if (!probe.ok) {
    process.stdout.write('\nprovider is not ready; start laya-serve first (see the usage text above).\n');
    process.exitCode = 1;
  } else if (!probeOnly) {
    const c = await classifyTask(provider, { task });
    const meta = layaMetadata(c);
    const top = Object.entries(c.work_kind_probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join('  ');
    process.stdout.write('\n');
    process.stdout.write(`task        ${task}\n`);
    process.stdout.write(`work_kind   ${c.work_kind}  (confidence ${c.work_kind_confidence.toFixed(3)})\n`);
    process.stdout.write(`            ${top}\n`);
    process.stdout.write(`complexity  ${c.complexity}  (score ${c.complexity_score.toFixed(2)})\n`);
    process.stdout.write(`review      ${c.review_required ? 'suggested' : 'not suggested'}  (noul ${c.review_noul.toFixed(3)})\n`);
    process.stdout.write(`answered by ${meta.checkpoint} / ${c.provider.model} in ${c.provider.elapsedMs} ms\n`);
    process.stdout.write(`reason      ${meta.reason}\n`);
    process.stdout.write('\nThis is a task description only. No agent was selected and nothing was run.\n');
  }
} catch (err) {
  if (err instanceof DecisionError) {
    process.stderr.write(`\n${err.name} [${err.code}]\n${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
