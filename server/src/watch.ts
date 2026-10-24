import type { Ctx, SourceRow, UpdateRow } from './ctx.js';
import { now } from './db.js';
import { aggregateChecks } from './git/checks.js';
import { addEvent, client } from './updates.js';

/**
 * Prüft alle offenen Pull Requests von lxnEye und bemerkt Änderungen von selbst:
 * neue Commits im Branch, Ergebnis der Prüfungen (CI/CD), gemergt oder geschlossen.
 * Jede Änderung wird einmal als Ereignis festgehalten.
 */
export async function checkOpenUpdates(ctx: Ctx, hooks: { onMerged?: (sourceId: string) => void } = {}): Promise<{ checked: number; events: number }> {
  const rows = ctx.db.prepare("SELECT * FROM updates WHERE status = 'open' AND pr_number IS NOT NULL").all() as unknown as UpdateRow[];
  const prs = new Map<string, UpdateRow[]>();
  for (const r of rows) prs.set(`${r.target_source_id}:${r.pr_number}`, [...(prs.get(`${r.target_source_id}:${r.pr_number}`) ?? []), r]);

  let checked = 0;
  let events = 0;
  for (const group of prs.values()) {
    const first = group[0] as UpdateRow;
    const src = ctx.db.prepare('SELECT * FROM sources WHERE id = ?').get(first.target_source_id) as SourceRow | undefined;
    if (!src) continue;
    const gid = first.group_id ?? first.id;
    let head: Awaited<ReturnType<Awaited<ReturnType<typeof client>>['gh']['prHead']>>;
    let checks: string;
    let failed: string[] = [];
    try {
      const { gh, repo } = await client(ctx, src);
      head = await gh.prHead(repo, first.pr_number as number);
      const c = await gh.checks(repo, head.sha);
      const agg = aggregateChecks(c.runs, c.statuses);
      checks = c.restricted && agg.total === 0 ? 'unknown' : agg.state;
      failed = agg.failed;
    } catch {
      continue; // nicht erreichbar: beim nächsten Durchlauf erneut
    }
    checked++;

    const state = head.merged ? 'merged' : head.state === 'closed' ? 'closed' : 'open';
    const out: [string, string][] = [];
    if (first.head_sha && first.head_sha !== head.sha && state === 'open') out.push(['commit_pushed', 'Der Branch wurde geändert (neuer Commit).']);
    if (checks !== first.checks_state) {
      if (checks === 'success') out.push(['checks_passed', 'Alle Prüfungen (CI/CD) sind bestanden.']);
      else if (checks === 'failure') out.push(['checks_failed', `Prüfungen fehlgeschlagen: ${failed.join(', ') || 'siehe Pull Request'}.`]);
    }
    if (state === 'merged') out.push(['merged', 'Der Pull Request wurde gemergt.']);
    if (state === 'closed') out.push(['closed', 'Der Pull Request wurde geschlossen, ohne zu mergen.']);

    for (const r of group) {
      ctx.db
        .prepare('UPDATE updates SET head_sha = ?, checks_state = ?, checks_failed = ?, last_checked = ?, status = ? WHERE id = ?')
        .run(head.sha, checks, JSON.stringify(failed), now(), state, r.id);
    }
    for (const [type, detail] of out) {
      addEvent(ctx, gid, src.id, type, detail);
      events++;
    }
    if (state === 'merged') hooks.onMerged?.(src.id); // die Quelle neu scannen, damit die neue Version sofort erscheint
  }
  return { checked, events };
}
