/**
 * tests/helpers/offline-context.mjs — trusted OFFLINE bootstrap for the test runner.
 *
 * Loaded with `node --import <this file> <suite>`, so it runs BEFORE the suite module
 * (and before any test code) is evaluated. It FREEZES the offline deny policy, which
 * is a one-way fact: after this point no test in the process may discover,
 * authenticate or launch a REAL coding agent, regardless of what it does with env
 * vars, config or a recreated runtime.
 *
 * It is intentionally an `.mjs` module so it can be passed to `--import` and does not
 * depend on any test helper being imported in the right order.
 */

import { installOfflinePolicy, isOfflineFrozen } from '../../src/runtime/offline-policy.ts';

installOfflinePolicy();

if (!isOfflineFrozen()) {
  throw new Error('offline-context: the offline policy failed to freeze');
}
