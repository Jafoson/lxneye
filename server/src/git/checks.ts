/** Fasst die Prüfläufe (GitHub Actions u. a.) und Commit-Status eines Pull Requests zu einem Ergebnis zusammen. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
export interface CommitStatus {
  context: string;
  state: string;
}

export type ChecksState = 'success' | 'failure' | 'pending' | 'none';

const BAD = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

export function aggregateChecks(runs: CheckRun[], statuses: CommitStatus[]): { state: ChecksState; total: number; failed: string[]; running: number } {
  const failed: string[] = [];
  let running = 0;
  for (const r of runs) {
    if (r.status !== 'completed') running++;
    else if (r.conclusion && BAD.has(r.conclusion)) failed.push(r.name);
  }
  for (const s of statuses) {
    if (s.state === 'pending') running++;
    else if (s.state === 'failure' || s.state === 'error') failed.push(s.context);
  }
  const total = runs.length + statuses.length;
  const state: ChecksState = total === 0 ? 'none' : failed.length > 0 ? 'failure' : running > 0 ? 'pending' : 'success';
  return { state, total, failed, running };
}
