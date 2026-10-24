import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { aggregateChecks } from './git/checks.js';

const gh = vi.hoisted(() => ({
  heads: {} as Record<number, { state: 'open' | 'closed'; merged: boolean; sha: string }>,
  checks: {} as Record<string, { runs: object[]; statuses: object[]; restricted: boolean }>,
  calls: 0,
}));

vi.mock('./git/github.js', async (orig) => {
  const real = await orig<typeof import('./git/github.js')>();
  class FakeGitHub {
    async prHead(_r: unknown, n: number) {
      gh.calls++;
      return gh.heads[n] as { state: 'open' | 'closed'; merged: boolean; sha: string };
    }
    async checks(_r: unknown, sha: string) {
      return gh.checks[sha] ?? { runs: [], statuses: [], restricted: false };
    }
  }
  return { ...real, GitHub: FakeGitHub };
});

describe('Prüfläufe zusammenfassen', () => {
  it('erkennt Erfolg, Fehler, laufende und fehlende Prüfungen', () => {
    const ok = { name: 'test', status: 'completed', conclusion: 'success' };
    expect(aggregateChecks([ok], []).state).toBe('success');
    expect(aggregateChecks([ok, { name: 'lint', status: 'completed', conclusion: 'skipped' }, { name: 'x', status: 'completed', conclusion: 'neutral' }], []).state).toBe('success');
    expect(aggregateChecks([ok, { name: 'build', status: 'completed', conclusion: 'failure' }], [])).toMatchObject({ state: 'failure', failed: ['build'] });
    expect(aggregateChecks([ok, { name: 'slow', status: 'in_progress', conclusion: null }], []).state).toBe('pending');
    expect(aggregateChecks([], [{ context: 'ci/jenkins', state: 'pending' }]).state).toBe('pending');
    expect(aggregateChecks([], [{ context: 'ci/jenkins', state: 'error' }])).toMatchObject({ state: 'failure', failed: ['ci/jenkins'] });
    expect(aggregateChecks([], []).state).toBe('none');
    // Fehler gewinnen vor "läuft noch"
    expect(aggregateChecks([{ name: 'a', status: 'completed', conclusion: 'timed_out' }, { name: 'b', status: 'queued', conclusion: null }], []).state).toBe('failure');
  });
});

describe('GET /api/prs/status', () => {
  let app: FastifyInstance;
  let srcId: string;
  let db: ReturnType<typeof openDb>;
  const get = (keys: string) => app.inject({ method: 'GET', url: `/api/prs/status?keys=${encodeURIComponent(keys)}` });

  beforeAll(async () => {
    db = openDb(':memory:');
    ({ app } = await buildApp({ ...loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }), env: 'test' as never }, { db }));
    srcId = randomUUID();
    db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at, meta) VALUES (?, 'git', 'r', 'https://github.com/a/b', 'ok', ?, ?)").run(
      srcId, Date.now(), JSON.stringify({ renovate: { file: 'renovate.json', rules: [], ignoreDeps: [], prs: [{ number: 40, title: 't', url: 'u', branch: 'renovate/x' }] } }),
    );
    const item = randomUUID();
    db.prepare("INSERT INTO items (id, source_id, key, name, type, ecosystem, current, updated_at) VALUES (?, ?, 'k', 'x', 'Image', 'docker', '1', ?)").run(item, srcId, Date.now());
    for (const n of [7, 8]) {
      db.prepare("INSERT INTO updates (id, item_id, target_source_id, kind, mode, file, from_version, to_version, pr_number, status, created_at) VALUES (?, ?, ?, 'update', 'pr', 'f', '1', '2', ?, 'open', ?)").run(randomUUID(), item, srcId, n, Date.now());
    }
    gh.heads[7] = { state: 'open', merged: false, sha: 'aaaaaaa' };
    gh.heads[8] = { state: 'closed', merged: true, sha: 'bbbbbbb' };
    gh.heads[40] = { state: 'open', merged: false, sha: 'ccccccc' };
    gh.checks.aaaaaaa = { runs: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'build', status: 'completed', conclusion: 'failure' }], statuses: [], restricted: false };
    gh.checks.bbbbbbb = { runs: [{ name: 'test', status: 'completed', conclusion: 'success' }], statuses: [], restricted: false };
    gh.checks.ccccccc = { runs: [], statuses: [], restricted: true };
  });
  afterAll(async () => app.close());

  it('liefert Prüfergebnis und Zustand, und zieht gemergte PRs in der Datenbank nach', async () => {
    const r = (await get(`${srcId}:7,${srcId}:8,${srcId}:40`)).json().statuses;
    expect(r[`${srcId}:7`]).toMatchObject({ state: 'open', checks: 'failure', failed: ['build'] });
    expect(r[`${srcId}:8`]).toMatchObject({ state: 'merged', checks: 'success' });
    expect(r[`${srcId}:40`]).toMatchObject({ state: 'open', checks: 'unknown' }); // Token darf Prüfläufe nicht lesen
    expect((db.prepare('SELECT status FROM updates WHERE pr_number = 8').get() as { status: string }).status).toBe('merged');
    expect((db.prepare('SELECT status FROM updates WHERE pr_number = 7').get() as { status: string }).status).toBe('open');
  });

  it('fragt GitHub nicht bei jedem Aufruf neu (Zwischenspeicher)', async () => {
    const before = gh.calls;
    await get(`${srcId}:7`);
    expect(gh.calls).toBe(before);
  });

  it('beantwortet nur Pull Requests, die lxnEye selbst kennt, und ignoriert Unsinn', async () => {
    const r = (await get(`${srcId}:999,nichts:1,${randomUUID()}:7,${srcId}:12abc`)).json().statuses;
    expect(r).toEqual({});
  });
});
