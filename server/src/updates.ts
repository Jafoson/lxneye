import { randomUUID } from 'node:crypto';
import type { Ctx, ItemRow, SourceRow, UpdateRow } from './ctx.js';
import { audit, getSetting, now } from './db.js';
import { openRepo } from './git/open.js';
import type { GitApi, RepoRef } from './git/provider.js';
import { applyPatch, PatchError, type Locator } from './lib/patch.js';
import type { Cand } from './lib/versions.js';

/** Hält ein Ereignis zu einem Update fest (Zeitleiste auf der Aktivitätsseite). `seen`: schon gesehen, z. B. selbst ausgelöst. */
export function addEvent(ctx: Ctx, groupId: string, sourceId: string, type: string, detail: string, seen = false): void {
  ctx.db.prepare('INSERT INTO update_events (group_id, source_id, ts, type, detail, seen) VALUES (?, ?, ?, ?, ?, ?)').run(groupId, sourceId, now(), type, detail, seen ? 1 : 0);
}

export class UpdateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function updateMode(ctx: Ctx): 'pr' | 'commit' {
  return getSetting(ctx.db, 'updateMode') === 'commit' ? 'commit' : 'pr';
}

const getItem = (ctx: Ctx, id: string): ItemRow | undefined => ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
const getSrc = (ctx: Ctx, id: string): SourceRow | undefined => ctx.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;

export async function client(ctx: Ctx, src: SourceRow): Promise<{ gh: GitApi; repo: RepoRef }> {
  const o = await openRepo(ctx, src);
  return { gh: o.api, repo: o.repo };
}

/**
 * Bestimmt, welche Stellen in welchem Git-Repository geändert werden müssen.
 * Dieselbe Version desselben Images in mehreren Dateien (oder auf mehreren Servern) gehört zu einer Gruppe.
 * Bei Server-/Kubernetes-Einträgen wird über das verknüpfte Git-Repository gegangen (GitOps).
 */
export function resolveGroup(ctx: Ctx, item: ItemRow): { src: SourceRow; targets: ItemRow[] } {
  const own = getSrc(ctx, item.source_id);
  if (!own) throw new UpdateError('Quelle nicht gefunden', 404);
  let src = own;
  let targets: ItemRow[];
  if (own.kind === 'git') {
    targets = ctx.db
      .prepare('SELECT * FROM items WHERE source_id = ? AND ecosystem = ? AND name = ? AND current = ? AND locator IS NOT NULL')
      .all(own.id, item.ecosystem, item.name, item.current) as unknown as ItemRow[];
  } else {
    if (!own.linked_source_id) {
      throw new UpdateError(
        'Diese Quelle ist mit keinem Git-Repository verknüpft. Verknüpfe sie über "Bearbeiten" mit dem Repository, das ihre Konfiguration (Helm/Compose) enthält.',
      );
    }
    const git = getSrc(ctx, own.linked_source_id);
    if (!git) throw new UpdateError('Das verknüpfte Git-Repository existiert nicht mehr.');
    src = git;
    const all = ctx.db
      .prepare("SELECT * FROM items WHERE source_id = ? AND ecosystem = 'docker' AND name = ? AND locator IS NOT NULL")
      .all(git.id, item.name) as unknown as ItemRow[];
    const byVersion = new Map<string, ItemRow[]>();
    for (const t of all) byVersion.set(t.current, [...(byVersion.get(t.current) ?? []), t]);
    targets = byVersion.get(item.current) ?? [...byVersion.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    if (targets.length === 0) throw new UpdateError(`Im Repository "${git.name}" wurde kein Eintrag für ${item.name} gefunden.`);
  }
  if (targets.length === 0) throw new UpdateError('Dieser Eintrag lässt sich nicht automatisch ändern (keine feste Stelle in einer Datei bekannt).');
  return { src, targets };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function record(ctx: Ctx, u: Omit<UpdateRow, 'created_at' | 'head_sha' | 'checks_state' | 'checks_failed' | 'last_checked'>): UpdateRow {
  const row = { ...u, head_sha: null, checks_state: null, checks_failed: null, last_checked: null, created_at: now() };
  ctx.db
    .prepare(
      `INSERT INTO updates (id, item_id, target_source_id, kind, parent_id, group_id, name, mode, file, from_version, to_version, branch, pr_number, pr_url, commit_sha, status, error, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.item_id, row.target_source_id, row.kind, row.parent_id, row.group_id, row.name, row.mode, row.file, row.from_version, row.to_version,
      row.branch, row.pr_number, row.pr_url, row.commit_sha, row.status, row.error, row.actor, row.created_at);
  return row;
}

/** Eine Änderung: alle Stellen (`targets`) eines Pakets von `from` auf `to`. */
export interface Change {
  name: string;
  targets: ItemRow[];
  from: string;
  to: string;
}

interface Prepared {
  /** Dateien mit fertig geändertem Inhalt */
  files: Map<string, { sha: string; content: string }>;
  /** Fehler je Änderung (Index), nur im toleranten Modus */
  errors: Map<number, string>;
}

/**
 * Holt die betroffenen Dateien und wendet alle Änderungen darauf an, ohne etwas zu schreiben.
 * Jede Änderung wird ganz oder gar nicht übernommen. Mehrere Änderungen an derselben Datei bauen aufeinander auf.
 * Streng: der erste Fehler bricht ab. Tolerant: fehlerhafte Änderungen werden übersprungen und gemeldet.
 */
async function prepareChanges(gh: GitApi, repo: RepoRef, base: string, changes: Change[], tolerant: boolean): Promise<Prepared> {
  const files = new Map<string, { sha: string; content: string }>();
  const errors = new Map<number, string>();
  for (const [ci, ch] of changes.entries()) {
    try {
      const staged = new Map<string, string>();
      for (const t of ch.targets) {
        if (!t.file || !t.locator) throw new UpdateError('Dieser Eintrag lässt sich nicht automatisch ändern (keine feste Stelle in einer Datei bekannt).');
        if (!files.has(t.file)) {
          const f = await gh.file(repo, t.file, base);
          files.set(t.file, { sha: f.sha, content: f.content });
        }
        const current = staged.get(t.file) ?? (files.get(t.file) as { content: string }).content;
        try {
          staged.set(t.file, applyPatch(current, JSON.parse(t.locator) as Locator, ch.from, ch.to));
        } catch (err) {
          if (err instanceof PatchError) throw new UpdateError(`${t.file}: ${err.message}`, 409);
          throw err;
        }
      }
      for (const [file, content] of staged) (files.get(file) as { content: string }).content = content;
    } catch (err) {
      if (!tolerant) throw err;
      errors.set(ci, err instanceof Error ? err.message : String(err));
    }
  }
  return { files, errors };
}

const uniqueFiles = (targets: ItemRow[]): string[] => [...new Set(targets.map((t) => t.file as string))];

/** Schreibt alle Änderungen: ein Pull Request (oder eine Folge von Commits) für alle betroffenen Dateien. */
async function applyChanges(
  ctx: Ctx,
  o: { src: SourceRow; changes: Change[]; kind: 'update' | 'rollback'; parentId: string | null; actor: string | null },
): Promise<UpdateRow[]> {
  const { gh, repo } = await client(ctx, o.src);
  const mode = updateMode(ctx);
  const base = await gh.defaultBranch(repo);
  const prepared = await prepareChanges(gh, repo, base, o.changes, false); // erst alles vorbereiten: scheitert etwas, wird nichts geschrieben
  const touched = [...new Set(o.changes.flatMap((c) => uniqueFiles(c.targets)))];

  const names = o.changes.map((c) => c.name);
  const head = o.changes.length === 1 ? `${o.changes[0]?.name} ${o.changes[0]?.from} → ${o.changes[0]?.to}` : `${o.changes.length} Updates: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
  const title = `${o.kind === 'rollback' ? 'Rollback: ' : ''}${head}${o.changes.length === 1 && touched.length > 1 ? ` (${touched.length} Dateien)` : ''}`;
  const groupId = randomUUID();
  const common = { target_source_id: o.src.id, kind: o.kind, parent_id: o.parentId, group_id: groupId, mode, error: null, actor: o.actor } as const;
  const shaByFile = new Map<string, string>();
  let branch: string | null = null;
  let pr: { number: number; url: string } | null = null;

  if (mode === 'commit') {
    for (const file of touched) {
      const f = prepared.files.get(file) as { sha: string; content: string };
      shaByFile.set(file, await gh.putFile(repo, file, { message: title, content: f.content, sha: f.sha, branch: base }));
    }
  } else {
    branch = `lxneye/${o.changes.length === 1 ? `${slug(names[0] as string)}-${slug((o.changes[0] as Change).to)}` : `sammel-${o.changes.length}`}-${randomUUID().slice(0, 6)}`;
    await gh.createBranch(repo, branch, await gh.branchSha(repo, base));
    try {
      for (const file of touched) {
        const f = prepared.files.get(file) as { sha: string; content: string };
        shaByFile.set(file, await gh.putFile(repo, file, { message: title, content: f.content, sha: f.sha, branch }));
      }
      pr = await gh.createPr(repo, {
        title,
        head: branch,
        base,
        body: `Automatisch erstellt von lxnEye.\n\n${o.changes.map((c) => `- **${c.name}** ${c.from} → ${c.to} (${uniqueFiles(c.targets).map((f) => `\`${f}\``).join(', ')})`).join('\n')}`,
      });
    } catch (err) {
      await gh.deleteBranch(repo, branch).catch(() => undefined);
      throw err;
    }
  }

  const rows: UpdateRow[] = [];
  for (const c of o.changes) {
    for (const file of uniqueFiles(c.targets)) {
      const first = c.targets.find((t) => t.file === file) as ItemRow;
      rows.push(
        record(ctx, {
          ...common, id: randomUUID(), item_id: first.id, name: c.name, file, from_version: c.from, to_version: c.to,
          branch, pr_number: pr?.number ?? null, pr_url: pr?.url ?? null, commit_sha: shaByFile.get(file) ?? null,
          status: mode === 'commit' ? 'committed' : 'open',
        }),
      );
    }
  }
  addEvent(ctx, groupId, o.src.id, 'opened', mode === 'commit' ? 'Direkt auf den Hauptzweig committet.' : `Pull Request #${pr?.number} erstellt.`, true);
  return rows;
}

interface Plan {
  input: BatchInput;
  item?: ItemRow;
  to?: string;
  level?: string;
  src?: SourceRow;
  change?: Change;
  files: string[];
  error?: string;
}

export interface BatchInput {
  id: string;
  to?: string;
}

/** Prüft jede gewünschte Änderung, ohne zu schreiben: Ziel gültig, Stellen bekannt, kein offener PR, Dateien passen noch. */
async function planBatch(ctx: Ctx, inputs: BatchInput[]): Promise<Plan[]> {
  const plans: Plan[] = inputs.map((input) => ({ input, files: [] }));
  const seen = new Map<string, number>();
  for (const p of plans) {
    try {
      const item = getItem(ctx, p.input.id);
      if (!item) throw new UpdateError('Eintrag nicht gefunden', 404);
      p.item = item;
      let cands = JSON.parse(item.candidates || '[]') as Cand[];
      if (cands.length === 0 && item.latest && item.bump !== '') cands = [{ level: item.bump, version: item.latest }];
      if (cands.length === 0) throw new UpdateError('Für diesen Eintrag gibt es kein Update.');
      const to = p.input.to ?? (cands[cands.length - 1] as Cand).version;
      const cand = cands.find((c) => c.version === to);
      if (!cand) throw new UpdateError('Diese Zielversion steht nicht zur Verfügung.');
      p.to = to;
      p.level = cand.level;
      const { src, targets } = resolveGroup(ctx, item);
      const ph = targets.map(() => '?').join(',');
      if (ctx.db.prepare(`SELECT 1 FROM updates WHERE status = 'open' AND kind = 'update' AND target_source_id = ? AND item_id IN (${ph})`).get(src.id, ...targets.map((t) => t.id))) {
        throw new UpdateError('Für diesen Eintrag ist bereits ein Pull Request offen.', 409);
      }
      const key = targets.map((t) => t.id).sort().join(',');
      if (seen.has(key)) throw new UpdateError('Derselbe Eintrag ist mehrfach ausgewählt.');
      seen.set(key, 1);
      p.src = src;
      p.files = uniqueFiles(targets);
      p.change = { name: item.name, targets, from: (targets[0] as ItemRow).current, to };
    } catch (err) {
      p.error = err instanceof Error ? err.message : String(err);
    }
  }
  // Dateien gegen den aktuellen Stand im Repository prüfen, je Repository gemeinsam (Änderungen bauen aufeinander auf)
  const bySrc = new Map<string, Plan[]>();
  for (const p of plans) if (!p.error && p.src) bySrc.set(p.src.id, [...(bySrc.get(p.src.id) ?? []), p]);
  for (const group of bySrc.values()) {
    const { gh, repo } = await client(ctx, (group[0] as Plan).src as SourceRow);
    try {
      const base = await gh.defaultBranch(repo);
      const { errors } = await prepareChanges(gh, repo, base, group.map((p) => p.change as Change), true);
      for (const [i, msg] of errors) (group[i] as Plan).error = msg;
    } catch (err) {
      for (const p of group) p.error = err instanceof Error ? err.message : String(err);
    }
  }
  return plans;
}

export interface CheckResult {
  id: string;
  name: string;
  to: string | null;
  level: string | null;
  files: string[];
  status: 'ok' | 'error';
  error: string | null;
}

/** Prüft eine Sammel-Auswahl vorab. Es wird nichts verändert. */
export async function checkBatch(ctx: Ctx, inputs: BatchInput[]): Promise<{ results: CheckResult[]; shared: { file: string; names: string[] }[] }> {
  const plans = await planBatch(ctx, inputs);
  const byFile = new Map<string, string[]>();
  for (const p of plans) if (!p.error) for (const f of p.files) byFile.set(f, [...(byFile.get(f) ?? []), (p.item as ItemRow).name]);
  return {
    results: plans.map((p) => ({
      id: p.input.id, name: p.item?.name ?? '?', to: p.to ?? null, level: p.level ?? null, files: p.files,
      status: p.error ? 'error' : 'ok', error: p.error ?? null,
    })),
    shared: [...byFile].filter(([, names]) => new Set(names).size > 1).map(([file, names]) => ({ file, names: [...new Set(names)] })),
  };
}

export interface BatchResult {
  id: string;
  ok: boolean;
  error?: string;
  prNumber?: number | null;
  prUrl?: string | null;
  mode?: 'pr' | 'commit';
}

/**
 * Führt eine Sammel-Auswahl aus. Gebündelt: ein Pull Request je Repository mit allen Änderungen.
 * Einzeln: ein Pull Request je Eintrag. Einträge mit Fehlern werden übersprungen, die anderen laufen durch.
 */
export async function runBatch(ctx: Ctx, inputs: BatchInput[], bundle: boolean, actor: string | null): Promise<BatchResult[]> {
  const plans = await planBatch(ctx, inputs);
  const results = new Map<string, BatchResult>();
  for (const p of plans) if (p.error) results.set(p.input.id, { id: p.input.id, ok: false, error: p.error });
  const valid = plans.filter((p) => !p.error);

  const done = (ps: Plan[], rows: UpdateRow[]): void => {
    const first = rows[0] as UpdateRow;
    for (const p of ps) results.set(p.input.id, { id: p.input.id, ok: true, prNumber: first.pr_number, prUrl: first.pr_url, mode: first.mode });
  };
  const fail = (ps: Plan[], err: unknown): void => {
    for (const p of ps) results.set(p.input.id, { id: p.input.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  };

  const units: Plan[][] = [];
  if (bundle) {
    const bySrc = new Map<string, Plan[]>();
    for (const p of valid) bySrc.set((p.src as SourceRow).id, [...(bySrc.get((p.src as SourceRow).id) ?? []), p]);
    units.push(...bySrc.values());
  } else {
    units.push(...valid.map((p) => [p]));
  }
  for (const unit of units) {
    try {
      const rows = await applyChanges(ctx, { src: (unit[0] as Plan).src as SourceRow, changes: unit.map((p) => p.change as Change), kind: 'update', parentId: null, actor });
      done(unit, rows);
      audit(ctx.db, actor, 'update', `${unit.map((p) => `${p.change?.name} → ${p.change?.to}`).join(', ')} (${rows[0]?.mode}, ${bundle ? 'gebündelt' : 'einzeln'})`);
    } catch (err) {
      fail(unit, err);
    }
  }
  return inputs.map((i) => results.get(i.id) ?? { id: i.id, ok: false, error: 'Nicht ausgeführt.' });
}

export async function startUpdate(ctx: Ctx, itemId: string, to: string | undefined, actor: string | null): Promise<UpdateRow> {
  const item = getItem(ctx, itemId);
  if (!item) throw new UpdateError('Eintrag nicht gefunden', 404);
  let cands = JSON.parse(item.candidates || '[]') as Cand[];
  if (cands.length === 0 && item.latest && item.bump !== '') cands = [{ level: item.bump, version: item.latest }]; // Daten aus einem älteren Scan
  if (cands.length === 0) throw new UpdateError('Für diesen Eintrag gibt es kein Update.');
  const target = to ?? (cands[cands.length - 1] as Cand).version;
  if (!cands.some((c) => c.version === target)) throw new UpdateError('Diese Zielversion steht nicht zur Verfügung.');

  const { src, targets } = resolveGroup(ctx, item);
  const ph = targets.map(() => '?').join(',');
  const open = ctx.db
    .prepare(`SELECT 1 FROM updates WHERE status = 'open' AND kind = 'update' AND target_source_id = ? AND item_id IN (${ph})`)
    .get(src.id, ...targets.map((t) => t.id));
  if (open) throw new UpdateError('Für diesen Eintrag ist bereits ein Pull Request offen.', 409);

  const change: Change = { name: item.name, targets, from: (targets[0] as ItemRow).current, to: target };
  const rows = await applyChanges(ctx, { src, changes: [change], kind: 'update', parentId: null, actor });
  const first = rows[0] as UpdateRow;
  audit(ctx.db, actor, 'update', `${item.name} ${first.from_version} → ${first.to_version} (${first.mode}, ${rows.length} ${rows.length === 1 ? 'Datei' : 'Dateien'})`);
  return first;
}

export async function rollbackUpdate(ctx: Ctx, updateId: string, actor: string | null): Promise<UpdateRow | null> {
  const upd = ctx.db.prepare('SELECT * FROM updates WHERE id = ?').get(updateId) as UpdateRow | undefined;
  if (!upd || upd.kind !== 'update') throw new UpdateError('Update nicht gefunden', 404);
  const rows = (upd.group_id
    ? ctx.db.prepare("SELECT * FROM updates WHERE group_id = ? AND kind = 'update'").all(upd.group_id)
    : [upd]) as unknown as UpdateRow[];
  if (rows.every((r) => r.status === 'reverted' || r.status === 'closed')) throw new UpdateError('Dieses Update wurde bereits zurückgenommen.', 409);
  const src = getSrc(ctx, upd.target_source_id);
  if (!src) throw new UpdateError('Quelle nicht gefunden', 404);
  const { gh, repo } = await client(ctx, src);
  const mark = (status: UpdateRow['status']): void => {
    for (const r of rows) ctx.db.prepare('UPDATE updates SET status = ? WHERE id = ?').run(status, r.id);
  };

  if (upd.status === 'open' && upd.pr_number) {
    const pr = await gh.pr(repo, upd.pr_number);
    if (pr.state === 'open') {
      await gh.closePr(repo, upd.pr_number);
      if (upd.branch) await gh.deleteBranch(repo, upd.branch).catch(() => undefined);
      mark('closed');
      audit(ctx.db, actor, 'rollback', `PR #${upd.pr_number} geschlossen`);
      return null;
    }
    if (!pr.merged) {
      mark('closed');
      return null;
    }
    mark('merged');
  }

  // PR gemerged bzw. Commit: jede Änderung des Sammel-Updates per Gegen-Änderung zurücknehmen
  const all = ctx.db.prepare('SELECT * FROM items WHERE source_id = ? AND locator IS NOT NULL').all(src.id) as unknown as ItemRow[];
  const byChange = new Map<string, { name: string; files: Set<string>; from: string; to: string }>();
  for (const r of rows) {
    const name = getItem(ctx, r.item_id)?.name;
    if (!name) continue;
    const key = `${name}|${r.from_version}|${r.to_version}`;
    const e = byChange.get(key) ?? { name, files: new Set<string>(), from: r.from_version, to: r.to_version };
    e.files.add(r.file);
    byChange.set(key, e);
  }
  const changes: Change[] = [];
  for (const e of byChange.values()) {
    const targets = all.filter((t) => t.file && e.files.has(t.file) && t.name === e.name && (t.current === e.to || t.current === e.from));
    if (targets.length > 0) changes.push({ name: e.name, targets, from: e.to, to: e.from });
  }
  if (changes.length === 0) throw new UpdateError('Der betroffene Eintrag existiert nicht mehr.', 404);
  const out = await applyChanges(ctx, { src, changes, kind: 'rollback', parentId: upd.id, actor });
  mark('reverted');
  audit(ctx.db, actor, 'rollback', `${[...new Set(rows.map((r) => r.file))].join(', ')} (${(out[0] as UpdateRow).mode})`);
  return out[0] as UpdateRow;
}

/** Prüft offene Pull Requests und übernimmt ihren Status (gemerged/geschlossen). */
export async function refreshUpdates(ctx: Ctx, sourceId: string): Promise<void> {
  const src = getSrc(ctx, sourceId);
  if (!src || src.kind !== 'git') return;
  const open = ctx.db.prepare("SELECT DISTINCT pr_number FROM updates WHERE target_source_id = ? AND status = 'open' AND pr_number IS NOT NULL").all(sourceId) as { pr_number: number }[];
  if (open.length === 0) return;
  const { gh, repo } = await client(ctx, src);
  for (const { pr_number } of open) {
    try {
      const pr = await gh.pr(repo, pr_number);
      const status = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : null;
      if (status) ctx.db.prepare("UPDATE updates SET status = ? WHERE target_source_id = ? AND pr_number = ? AND status = 'open'").run(status, sourceId, pr_number);
    } catch {
      /* beim nächsten Scan erneut */
    }
  }
}
