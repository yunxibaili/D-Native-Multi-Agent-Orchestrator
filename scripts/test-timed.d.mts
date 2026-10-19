export type SuiteEntryCode =
  | 'empty-entry'
  | 'unresolvable-entry'
  | 'outside-workspace'
  | 'live-suite'
  | 'non-canonical';

export declare function normalizeSuiteEntry(
  raw: unknown,
  workspaceRoot?: string,
): { ok: true; file: string; resolved: string } | { ok: false; code: SuiteEntryCode; raw: string };
