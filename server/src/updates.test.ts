import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import type { Ctx, UpdateRow } from './ctx.js';
import { deriveKey } from './crypto.js';
import { openDb, setSetting } from './db.js';
import { extractRefs } from './scan/extract.js';
import { checkBatch, rollbackUpdate, runBatch, startUpdate } from './updates.js';

// Ein winziges GitHub im Speicher: Branches sind Maps von Dateipfad zu Inhalt.
const gh = vi.hoisted(() => ({
  branches: {} as Record<string, Record<string, string>>,
  prs: {} as Record<number, { state: 'open' | 'closed'; merged: boolean; head: string }>,
  nextPr: 7,
  commits: 0,
}));

vi.mock('./git/github.js', async (orig) => {
  const real = await orig<typeof import('./git/github.js')>();
  class FakeGitHub {
    async defaultBranch() {
      return 'main';
    }
    async file(_r: unknown, path: string, ref: string) {
      const content = gh.branches[ref]?.[path] ?? gh.branches.main?.[path];
      if (content === undefined) throw new Error(`404 ${path}`);
      return { content, sha: `sha-${path}` };
    }
    async branchSha() {
      return 'base';
    }
    async createBranch(_r: unknown, name: string) {
      gh.branches[name] = {};
    }
    async deleteBranch(_r: unknown, name: string) {
      delete gh.branches[name];
    }
    async putFile(_r: unknown, path: string, o: { content: string; branch: string }) {
      (gh.branches[o.branch] ??= {})[path] = o.content;
      return `commit-${++gh.commits}`;
    }
    async createPr(_r: unknown, o: { head: string }) {
      const number = gh.nextPr++;
      gh.prs[number] = { state: 'open', merged: false, head: o.head };
      return { number, url: `https://github.com/a/b/pull/${number}` };
    }
    async pr(_r: unknown, n: number) {
      return gh.prs[n] as { state: 'open' | 'closed'; merged: boolean };
    }
    async closePr(_r: unknown, n: number) {
      (gh.prs[n] as { state: string }).state = 'closed';
    }
  }
  return { ...real, GitHub: FakeGitHub };
});

const FILES = {
  'workloads/nextcloud/nextcloud.yaml': 'kind: Deployment\nspec:\n  containers:\n    - image: nextcloud:35.0.2-apache  # app\n',
  'workloads/nextcloud/cron.yaml': 'kind: CronJob\nspec:\n  containers:\n    - image: nextcloud:35.0.2-apache\n',
  'workloads/nextcloud/notify-push.yaml': 'kind: Deployment\n---\nkind: Deployment\nspec:\n  containers:\n    - image: nextcloud:35.0.2-apache\n    - image: redis:7.4.11-alpine\n',
  'workloads/backup/cronjob.yaml': 'kind: CronJob\nspec:\n  initContainers:\n    - image: busybox:1.37.0\n  containers:\n    - image: rclone/rclone:1.71.0\n',
};

const NEXTCLOUD_FILES = ['workloads/nextcloud/nextcloud.yaml', 'workloads/nextcloud/cron.yaml', 'workloads/nextcloud/notify-push.yaml'];

const CANDS: Record<string, { level: string; version: string }[]> = {
  nextcloud: [{ level: 'Patch', version: '35.0.3-apache' }, { level: 'Major', version: '36.0.0-apache' }],
  busybox: [{ level: 'Minor', version: '1.38.0' }],
  'rclone/rclone': [{ level: 'Minor', version: '1.75.2' }],
  redis: [{ level: 'Major', version: '8.10.2-alpine' }],
};

function setup() {
  const db = openDb(':memory:');
  const cfg = loadConfig({ NODE_ENV: 'test' });
  const ctx: Ctx = { cfg, db, key: deriveKey('test'.repeat(10)) };
  const srcId = randomUUID();
  db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at) VALUES (?, 'git', 'homelab', 'https://github.com/a/b', 'ok', ?)").run(srcId, Date.now());
  const refs = extractRefs(Object.entries(FILES).map(([path, content]) => ({ path, content })));
  const ids: Record<string, string> = {};
  for (const r of refs) {
    const id = randomUUID();
    ids[`${r.name}@${r.file}`] = id;
    const cands = CANDS[r.name] ?? [];
    db.prepare('INSERT INTO items (id, source_id, key, name, type, ecosystem, file, current, latest, bump, candidates, locator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, srcId, r.key, r.name, r.type, r.ecosystem, r.file, r.current, cands.length ? (cands[cands.length - 1] as { version: string }).version : r.current, cands.length ? (cands[cands.length - 1] as { level: string }).level : '', JSON.stringify(cands), JSON.stringify(r.locator), Date.now(),
    );
  }
  return { ctx, ids, srcId };
}

describe('Update über mehrere Dateien', () => {
  beforeEach(() => {
    gh.branches = { main: { ...FILES } };
    gh.prs = {};
    gh.nextPr = 7;
    gh.commits = 0;
  });

  it('ändert alle drei Dateien in einem Pull Request, nur die gewählte Version, nichts anderes', async () => {
    const { ctx, ids } = setup();
    const row = await startUpdate(ctx, ids['nextcloud@workloads/nextcloud/cron.yaml'] as string, '35.0.3-apache', 'ich');
    expect(row.to_version).toBe('35.0.3-apache');
    expect(Object.keys(gh.prs)).toEqual(['7']); // genau ein PR
    const branch = (gh.prs[7] as { head: string }).head;
    expect(Object.keys(gh.branches[branch] ?? {}).sort()).toEqual(NEXTCLOUD_FILES.sort());
    expect(gh.branches[branch]?.['workloads/nextcloud/nextcloud.yaml']).toBe(FILES['workloads/nextcloud/nextcloud.yaml'].replace('35.0.2', '35.0.3'));
    // Redis in derselben Datei bleibt unberührt
    expect(gh.branches[branch]?.['workloads/nextcloud/notify-push.yaml']).toContain('redis:7.4.11-alpine');
    expect(gh.branches.main).toEqual(FILES); // der Hauptzweig ist unverändert
    const rows = ctx.db.prepare('SELECT * FROM updates').all() as unknown as UpdateRow[];
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    expect(rows.every((r) => r.status === 'open' && r.pr_number === 7)).toBe(true);
  });

  it('verweigert Zielversionen, die nicht zur Auswahl stehen', async () => {
    const { ctx, ids } = setup();
    await expect(startUpdate(ctx, ids['nextcloud@workloads/nextcloud/cron.yaml'] as string, '99.0.0', null)).rejects.toThrow(/Zielversion/);
    expect(Object.keys(gh.prs)).toHaveLength(0);
  });

  it('erlaubt kein zweites Update, solange der Pull Request offen ist', async () => {
    const { ctx, ids } = setup();
    await startUpdate(ctx, ids['nextcloud@workloads/nextcloud/cron.yaml'] as string, undefined, null);
    await expect(startUpdate(ctx, ids['nextcloud@workloads/nextcloud/nextcloud.yaml'] as string, '35.0.3-apache', null)).rejects.toThrow(/bereits ein Pull Request offen/);
  });

  it('schreibt nichts, wenn eine der Dateien sich zwischenzeitlich geändert hat', async () => {
    const { ctx, ids } = setup();
    gh.branches.main = { ...FILES, 'workloads/nextcloud/cron.yaml': FILES['workloads/nextcloud/cron.yaml'].replace('35.0.2', '35.0.9') };
    await expect(startUpdate(ctx, ids['nextcloud@workloads/nextcloud/nextcloud.yaml'] as string, undefined, null)).rejects.toThrow(/cron\.yaml/);
    expect(Object.keys(gh.prs)).toHaveLength(0);
    expect(Object.keys(gh.branches)).toEqual(['main']);
  });

  it('schließt beim Rollback eines offenen PRs den Pull Request für alle Dateien', async () => {
    const { ctx, ids } = setup();
    const row = await startUpdate(ctx, ids['nextcloud@workloads/nextcloud/cron.yaml'] as string, undefined, null);
    expect(await rollbackUpdate(ctx, row.id, null)).toBeNull();
    expect(gh.prs[7]?.state).toBe('closed');
    const rows = ctx.db.prepare('SELECT status FROM updates').all() as { status: string }[];
    expect(rows.every((r) => r.status === 'closed')).toBe(true);
    await expect(rollbackUpdate(ctx, row.id, null)).rejects.toThrow(/bereits zurückgenommen/);
  });

  it('nimmt einen gemergten Pull Request mit einem Gegen-PR in allen Dateien zurück', async () => {
    const { ctx, ids } = setup();
    const row = await startUpdate(ctx, ids['nextcloud@workloads/nextcloud/cron.yaml'] as string, '36.0.0-apache', null);
    const head = (gh.prs[7] as { head: string; merged: boolean; state: string });
    head.merged = true;
    head.state = 'closed';
    gh.branches.main = { ...gh.branches[head.head] }; // Merge
    const back = await rollbackUpdate(ctx, row.id, null);
    expect(back?.kind).toBe('rollback');
    const revertBranch = (gh.prs[8] as { head: string }).head;
    for (const file of NEXTCLOUD_FILES) expect(gh.branches[revertBranch]?.[file]).toBe(FILES[file as keyof typeof FILES]);
    const parents = ctx.db.prepare("SELECT status FROM updates WHERE kind = 'update'").all() as { status: string }[];
    expect(parents.every((r) => r.status === 'reverted')).toBe(true);
  });

  it('arbeitet im Commit-Modus direkt auf main und stellt per Rollback alles wieder her', async () => {
    const { ctx, ids } = setup();
    setSetting(ctx.db, 'updateMode', 'commit');
    const row = await startUpdate(ctx, ids['nextcloud@workloads/nextcloud/nextcloud.yaml'] as string, '35.0.3-apache', null);
    expect(row.status).toBe('committed');
    expect(gh.branches.main?.['workloads/nextcloud/cron.yaml']).toContain('35.0.3-apache');
    expect(Object.keys(gh.prs)).toHaveLength(0);
    await rollbackUpdate(ctx, row.id, null);
    expect(gh.branches.main).toEqual(FILES);
  });
});

describe('Sammel-Update', () => {
  beforeEach(() => {
    gh.branches = { main: { ...FILES } };
    gh.prs = {};
    gh.nextPr = 7;
    gh.commits = 0;
  });
  const pick = (ids: Record<string, string>, ...keys: string[]) => keys.map((k) => ({ id: ids[k] as string }));
  const KEYS = ['nextcloud@workloads/nextcloud/cron.yaml', 'busybox@workloads/backup/cronjob.yaml', 'rclone/rclone@workloads/backup/cronjob.yaml', 'redis@workloads/nextcloud/notify-push.yaml'];

  it('prüft alle Einträge vorab und meldet gemeinsam genutzte Dateien, ohne etwas zu schreiben', async () => {
    const { ctx, ids } = setup();
    const r = await checkBatch(ctx, pick(ids, ...KEYS));
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.shared).toEqual([
      { file: 'workloads/nextcloud/notify-push.yaml', names: ['nextcloud', 'redis'] },
      { file: 'workloads/backup/cronjob.yaml', names: ['busybox', 'rclone/rclone'] },
    ]);
    expect(r.results[0]?.files).toHaveLength(3);
    expect(Object.keys(gh.prs)).toHaveLength(0);
    expect(gh.branches.main).toEqual(FILES);
  });

  it('meldet nur den Eintrag mit Problem und lässt die anderen zu', async () => {
    const { ctx, ids } = setup();
    gh.branches.main = { ...FILES, 'workloads/backup/cronjob.yaml': FILES['workloads/backup/cronjob.yaml'].replace('busybox:1.37.0', 'busybox:1.37.5') };
    const r = await checkBatch(ctx, pick(ids, ...KEYS));
    const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
    expect(by.busybox?.status).toBe('error');
    expect(by.busybox?.error).toMatch(/cronjob\.yaml/);
    expect(by.nextcloud?.status).toBe('ok');
    expect(by['rclone/rclone']?.status).toBe('ok');
    expect(by.redis?.status).toBe('ok');
  });

  it('weist unbekannte Zielversionen und doppelt gewählte Einträge ab', async () => {
    const { ctx, ids } = setup();
    const dup = [{ id: ids[KEYS[0] as string] as string }, { id: ids['nextcloud@workloads/nextcloud/nextcloud.yaml'] as string }];
    const r = await checkBatch(ctx, [...dup, { id: ids[KEYS[1] as string] as string, to: '9.9.9' }]);
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'error', 'error']);
    expect(r.results[1]?.error).toMatch(/mehrfach/);
    expect(r.results[2]?.error).toMatch(/Zielversion/);
  });

  it('bündelt alles in einem Pull Request, auch mehrere Änderungen in derselben Datei', async () => {
    const { ctx, ids } = setup();
    const out = await runBatch(ctx, pick(ids, ...KEYS), true, 'ich');
    expect(out.every((o) => o.ok && o.prNumber === 7)).toBe(true);
    expect(Object.keys(gh.prs)).toEqual(['7']);
    const b = gh.branches[(gh.prs[7] as { head: string }).head] as Record<string, string>;
    expect(b['workloads/backup/cronjob.yaml']).toBe(FILES['workloads/backup/cronjob.yaml'].replace('busybox:1.37.0', 'busybox:1.38.0').replace('rclone:1.71.0', 'rclone:1.75.2'));
    expect(b['workloads/nextcloud/notify-push.yaml']).toContain('nextcloud:36.0.0-apache');
    expect(b['workloads/nextcloud/notify-push.yaml']).toContain('redis:8.10.2-alpine');
    expect(gh.branches.main).toEqual(FILES);
    const rows = ctx.db.prepare('SELECT DISTINCT group_id, pr_number FROM updates').all();
    expect(rows).toHaveLength(1);
  });

  it('nimmt ein gebündeltes, gemergtes Sammel-Update vollständig zurück', async () => {
    const { ctx, ids } = setup();
    await runBatch(ctx, pick(ids, ...KEYS), true, null);
    const pr = gh.prs[7] as { head: string; merged: boolean; state: string };
    pr.merged = true;
    pr.state = 'closed';
    gh.branches.main = { ...gh.branches[pr.head] };
    const first = ctx.db.prepare('SELECT id FROM updates LIMIT 1').get() as { id: string };
    await rollbackUpdate(ctx, first.id, null);
    const back = gh.branches[(gh.prs[8] as { head: string }).head] as Record<string, string>;
    for (const [file, original] of Object.entries(FILES)) expect(back[file]).toBe(original);
  });

  it('schließt beim Rollback eines offenen Sammel-PRs den ganzen Pull Request', async () => {
    const { ctx, ids } = setup();
    await runBatch(ctx, pick(ids, ...KEYS), true, null);
    const first = ctx.db.prepare('SELECT id FROM updates LIMIT 1').get() as { id: string };
    expect(await rollbackUpdate(ctx, first.id, null)).toBeNull();
    expect(gh.prs[7]?.state).toBe('closed');
    expect((ctx.db.prepare('SELECT status FROM updates').all() as { status: string }[]).every((r) => r.status === 'closed')).toBe(true);
  });

  it('erstellt ohne Bündeln je Eintrag einen eigenen Pull Request', async () => {
    const { ctx, ids } = setup();
    const out = await runBatch(ctx, pick(ids, KEYS[0] as string, KEYS[3] as string), false, null);
    expect(out.map((o) => o.prNumber)).toEqual([7, 8]);
  });

  it('führt die gültigen Einträge aus, auch wenn einer scheitert', async () => {
    const { ctx, ids } = setup();
    const out = await runBatch(ctx, [{ id: ids[KEYS[0] as string] as string, to: '99.0.0' }, { id: ids[KEYS[3] as string] as string }], true, null);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.error).toMatch(/Zielversion/);
    expect(out[1]?.ok).toBe(true);
    const b = gh.branches[(gh.prs[7] as { head: string }).head] as Record<string, string>;
    expect(Object.keys(b)).toEqual(['workloads/nextcloud/notify-push.yaml']);
    expect(b['workloads/nextcloud/notify-push.yaml']).toContain('nextcloud:35.0.2-apache'); // Nextcloud blieb unberührt
  });
});
