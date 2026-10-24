import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { Ctx } from './ctx.js';
import { deriveKey } from './crypto.js';
import { openDb } from './db.js';
import { getSchedule, isDue } from './scheduler.js';
import { startUpdate } from './updates.js';
import { checkOpenUpdates } from './watch.js';

const gh = vi.hoisted(() => ({
  main: 'kind: Deployment\nspec:\n  containers:\n    - image: nextcloud:35.0.2-apache\n' as string,
  pr: { state: 'open' as 'open' | 'closed', merged: false, sha: 'sha1' },
  runs: [] as { name: string; status: string; conclusion: string | null }[],
  restricted: false,
}));

vi.mock('./git/github.js', async (orig) => {
  const real = await orig<typeof import('./git/github.js')>();
  class FakeGitHub {
    async defaultBranch() { return 'main'; }
    async file() { return { content: gh.main, sha: 'f1' }; }
    async branchSha() { return 'base'; }
    async createBranch() {}
    async deleteBranch() {}
    async putFile() { return 'c1'; }
    async createPr() { return { number: 7, url: 'https://github.com/a/b/pull/7' }; }
    async prHead() { return { ...gh.pr }; }
    async checks() { return { runs: gh.runs, statuses: [], restricted: gh.restricted }; }
  }
  return { ...real, GitHub: FakeGitHub };
});

const pass = [{ name: 'test', status: 'completed', conclusion: 'success' }];

function setup() {
  const db = openDb(':memory:');
  const ctx: Ctx = { cfg: loadConfig({ NODE_ENV: 'test' }), db, key: deriveKey('t'.repeat(30)) };
  const src = randomUUID();
  const item = randomUUID();
  db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at) VALUES (?, 'git', 'homelab', 'https://github.com/a/b', 'ok', ?)").run(src, Date.now());
  db.prepare("INSERT INTO items (id, source_id, key, name, type, ecosystem, file, current, latest, bump, candidates, locator, updated_at) VALUES (?, ?, 'k', 'nextcloud', 'Image', 'docker', 'a.yaml', '35.0.2-apache', '35.0.3-apache', 'Patch', ?, ?, ?)").run(
    item, src, JSON.stringify([{ level: 'Patch', version: '35.0.3-apache' }]), JSON.stringify({ type: 'yaml', path: ['spec', 'containers', 0, 'image'], mode: 'ref', image: 'nextcloud' }), Date.now(),
  );
  return { ctx, db, src, item };
}

const types = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT type FROM update_events ORDER BY id').all() as { type: string }[]).map((e) => e.type);

describe('Pull Requests überwachen', () => {
  beforeEach(() => {
    gh.main = 'kind: Deployment\nspec:\n  containers:\n    - image: nextcloud:35.0.2-apache\n';
    gh.pr = { state: 'open', merged: false, sha: 'sha1' };
    gh.runs = [{ name: 'test', status: 'in_progress', conclusion: null }];
    gh.restricted = false;
  });

  it('bemerkt jede Änderung genau einmal: Prüfungen, neuer Commit, Merge', async () => {
    const { ctx, db, src, item } = setup();
    await startUpdate(ctx, item, undefined, 'ich');
    expect(types(db)).toEqual(['opened']);

    // läuft noch: nichts Neues, aber der Stand wird gemerkt
    await checkOpenUpdates(ctx);
    expect(types(db)).toEqual(['opened']);
    expect((db.prepare('SELECT head_sha, checks_state FROM updates').get() as { head_sha: string; checks_state: string })).toEqual({ head_sha: 'sha1', checks_state: 'pending' });

    gh.runs = pass;
    await checkOpenUpdates(ctx);
    await checkOpenUpdates(ctx); // unverändert: kein zweites Ereignis
    expect(types(db)).toEqual(['opened', 'checks_passed']);

    // jemand pusht in den Branch, danach schlägt eine Prüfung fehl
    gh.pr.sha = 'sha2';
    gh.runs = [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'build', status: 'completed', conclusion: 'failure' }];
    await checkOpenUpdates(ctx);
    expect(types(db)).toEqual(['opened', 'checks_passed', 'commit_pushed', 'checks_failed']);
    expect((db.prepare("SELECT detail FROM update_events WHERE type = 'checks_failed'").get() as { detail: string }).detail).toContain('build');

    // gemergt: Ereignis, Status, und die Quelle wird neu gescannt
    gh.pr = { state: 'closed', merged: true, sha: 'sha2' };
    const merged: string[] = [];
    await checkOpenUpdates(ctx, { onMerged: (id) => merged.push(id) });
    expect(types(db).at(-1)).toBe('merged');
    expect(merged).toEqual([src]);
    expect((db.prepare('SELECT status FROM updates').get() as { status: string }).status).toBe('merged');
    // erledigte Pull Requests werden nicht mehr abgefragt
    const before = types(db).length;
    await checkOpenUpdates(ctx, { onMerged: (id) => merged.push(id) });
    expect(types(db)).toHaveLength(before);
    expect(merged).toHaveLength(1);
  });

  it('meldet einen ohne Merge geschlossenen Pull Request und scannt dann nicht neu', async () => {
    const { ctx, db, item } = setup();
    await startUpdate(ctx, item, undefined, null);
    gh.pr = { state: 'closed', merged: false, sha: 'sha1' };
    const merged: string[] = [];
    await checkOpenUpdates(ctx, { onMerged: (id) => merged.push(id) });
    expect(types(db).at(-1)).toBe('closed');
    expect(merged).toEqual([]);
  });

  it('meldet ein ohne Berechtigung nicht lesbares CI-Ergebnis nicht als Fehler', async () => {
    const { ctx, db, item } = setup();
    await startUpdate(ctx, item, undefined, null);
    gh.runs = [];
    gh.restricted = true;
    await checkOpenUpdates(ctx);
    expect(types(db)).toEqual(['opened']);
    expect((db.prepare('SELECT checks_state FROM updates').get() as { checks_state: string }).checks_state).toBe('unknown');
  });
});

describe('Aktivitäts-API und Zeitplan', () => {
  const H = { 'x-csrf-token': 'dev-csrf', 'content-type': 'application/json' };

  it('liefert Pull Requests mit Änderungen und Zeitleiste und merkt sich "gesehen"', async () => {
    const { ctx, db, item } = setup();
    const { app } = await buildApp({ ...loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }), env: 'test' as never }, { db });
    await startUpdate(ctx, item, undefined, 'ich');
    gh.runs = pass;
    await checkOpenUpdates(ctx);

    const a = (await app.inject({ method: 'GET', url: '/api/activity' })).json();
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]).toMatchObject({ status: 'open', prNumber: 7, sourceName: 'homelab', checks: 'success', canRollback: true, unseen: 1 });
    expect(a.groups[0].changes).toEqual([{ name: 'nextcloud', from: '35.0.2-apache', to: '35.0.3-apache', files: ['a.yaml'] }]);
    expect(a.groups[0].events.map((e: { type: string }) => e.type)).toEqual(['checks_passed', 'opened']);

    const s = (await app.inject({ method: 'GET', url: '/api/activity/summary' })).json();
    expect(s).toMatchObject({ open: 1, unseen: 1 });
    expect(s.recent[0]).toMatchObject({ type: 'checks_passed', name: 'nextcloud', prNumber: 7 });
    await app.inject({ method: 'POST', url: '/api/activity/seen', headers: H, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/activity/summary' })).json().unseen).toBe(0);
    await app.close();
  });

  it('prüft den Zeitplan und bestimmt, wann etwas fällig ist', async () => {
    const { ctx, db } = setup();
    expect(isDue(null, 60, 1000)).toBe(true);
    expect(isDue(0, 60, 59 * 60_000)).toBe(false);
    expect(isDue(0, 60, 60 * 60_000)).toBe(true);
    expect(getSchedule(ctx)).toMatchObject({ scanIntervalMin: 360, watchIntervalMin: 5 });

    const { app } = await buildApp({ ...loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }), env: 'test' as never }, { db });
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/settings/schedule', headers: H, payload });
    expect((await put({ enabled: true, scanIntervalMin: 7, watchIntervalMin: 5 })).statusCode).toBe(400); // kein erlaubtes Intervall
    expect((await put({ enabled: true, scanIntervalMin: 60, watchIntervalMin: 5, extra: 1 })).statusCode).toBe(400);
    const ok = await put({ enabled: false, scanIntervalMin: 720, watchIntervalMin: 10 });
    expect(ok.json()).toMatchObject({ enabled: false, scanIntervalMin: 720, watchIntervalMin: 10, nextScanAt: null });
    const got = (await app.inject({ method: 'GET', url: '/api/settings/schedule' })).json();
    expect(got.options.scan).toContain(1440);
    await app.close();
  });
});
