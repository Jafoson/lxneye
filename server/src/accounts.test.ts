import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { AccountRow, Ctx } from './ctx.js';
import { decrypt, encrypt } from './crypto.js';
import { openDb } from './db.js';
import { GitLab, parseGitlabUrl } from './git/gitlab.js';
import { accountToken, parseRepoUrl } from './git/open.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Plattform erkennen', () => {
  const cfg = loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', GITLAB_URL: 'https://git.example.com' });
  it('unterscheidet GitHub und GitLab und normalisiert die Adresse', () => {
    expect(parseRepoUrl(cfg, 'https://github.com/o/r.git')).toMatchObject({ provider: 'github', url: 'https://github.com/o/r' });
    expect(parseRepoUrl(cfg, 'https://git.example.com/gruppe/unter/projekt')).toMatchObject({ provider: 'gitlab', ref: { owner: 'gruppe/unter', repo: 'projekt' } });
    expect(() => parseRepoUrl(cfg, 'https://bitbucket.org/a/b')).toThrow(/GitHub.*GitLab/);
    expect(() => parseRepoUrl(cfg, 'https://git.example.com/nur-eins')).toThrow();
    expect(() => parseGitlabUrl('https://git.example.com/a/-/issues', cfg.gitlabUrl)).toThrow();
  });
  it('verlangt für GITLAB_URL in Produktion https', () => {
    const prod = { NODE_ENV: 'production', PUBLIC_URL: 'https://x.example.com', TRUST_PROXY: 'true', SECRET_KEY: 'x'.repeat(40), OIDC_ISSUER: 'https://s.example.com', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', OIDC_ALLOWED_EMAILS: 'a@b.de' } as const;
    expect(() => loadConfig({ ...prod, GITLAB_URL: 'http://git.example.com' })).toThrow(/GITLAB_URL/);
    expect(loadConfig({ ...prod, GITLAB_URL: 'https://git.example.com' }).gitlabUrl.host).toBe('git.example.com');
  });
});

describe('GitLab-Client', () => {
  afterEach(() => vi.restoreAllMocks());
  const base = new URL('https://gitlab.com');
  const ref = { owner: 'gruppe/unter', repo: 'projekt' };
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const route = (table: Record<string, (c: { url: URL; body?: string }) => Response>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body as string | undefined, auth: headers.authorization });
      const key = Object.keys(table).find((k) => decodeURIComponent(url.pathname + url.search).startsWith(k));
      return key ? (table[key] as (c: { url: URL; body?: string }) => Response)({ url, body: init?.body as string | undefined }) : json({ message: 'nicht gefunden' }, 404);
    });

  it('liest Dateien, den Baum (mit Seiten) und schreibt Änderungen mit URL-codiertem Projektpfad', async () => {
    calls.length = 0;
    const page1 = Array.from({ length: 100 }, (_, i) => ({ path: `d/f${i}.txt`, type: 'blob' }));
    route({
      '/api/v4/projects/gruppe/unter/projekt/repository/tree': ({ url }) => json(url.searchParams.get('page') === '1' ? page1 : [{ path: 'Dockerfile', type: 'blob' }, { path: 'src', type: 'tree' }]),
      '/api/v4/projects/gruppe/unter/projekt/repository/files/Dockerfile': () => json({ content: Buffer.from('FROM node:20\n').toString('base64'), encoding: 'base64', last_commit_id: 'abc1234' }),
      '/api/v4/projects/gruppe/unter/projekt/repository/branches/neu': () => json({ commit: { id: 'dead123' } }),
      '/api/v4/projects/gruppe/unter/projekt': () => json({ default_branch: 'main' }),
    });
    const gl = new GitLab(base, 'tok');
    expect(await gl.defaultBranch(ref)).toBe('main');
    const tree = await gl.tree(ref, 'main');
    expect(tree).toHaveLength(101);
    expect(tree.at(-1)?.path).toBe('Dockerfile');
    expect(await gl.file(ref, 'Dockerfile', 'main')).toEqual({ content: 'FROM node:20\n', sha: 'abc1234' });
    expect(calls[0]?.auth).toBe('Bearer tok');
    expect(calls[0]?.url).toContain('/projects/gruppe%2Funter%2Fprojekt');
    // Schreiben: Datei als base64, danach den neuen Commit zurückgeben
    route({
      '/api/v4/projects/gruppe/unter/projekt/repository/files/Dockerfile': () => json({ file_path: 'Dockerfile', branch: 'neu' }),
      '/api/v4/projects/gruppe/unter/projekt/repository/branches/neu': () => json({ commit: { id: 'dead123' } }),
    });
    calls.length = 0;
    expect(await gl.putFile(ref, 'Dockerfile', { message: 'm', content: 'FROM node:22\n', sha: 'abc1234', branch: 'neu' })).toBe('dead123');
    const put = JSON.parse(calls[0]?.body ?? '{}');
    expect(calls[0]?.method).toBe('PUT');
    expect(Buffer.from(put.content, 'base64').toString()).toBe('FROM node:22\n');
    expect(put).toMatchObject({ branch: 'neu', commit_message: 'm', encoding: 'base64' });
  });

  it('übersetzt Merge Requests und Pipelines in die gemeinsamen Zustände', async () => {
    route({
      '/api/v4/projects/gruppe/unter/projekt/merge_requests/7': () => json({ state: 'merged', sha: 'abc1234' }),
      '/api/v4/projects/gruppe/unter/projekt/merge_requests/8': () => json({ state: 'opened', sha: 'def5678' }),
      '/api/v4/projects/gruppe/unter/projekt/merge_requests?state=opened': () => json([
        { iid: 3, title: 'Update x', web_url: 'u', source_branch: 'renovate/x-2.x', author: { username: 'bot' } },
        { iid: 4, title: 'Eigenes', web_url: 'u2', source_branch: 'feature', author: { username: 'mensch' } },
      ]),
      '/api/v4/projects/gruppe/unter/projekt/merge_requests': () => json({ iid: 9, web_url: 'https://gitlab.com/mr/9' }),
      '/api/v4/projects/gruppe/unter/projekt/pipelines?sha=abc1234': () => json([{ id: 55, status: 'failed' }]),
      '/api/v4/projects/gruppe/unter/projekt/pipelines?sha=def5678': () => json([{ id: 56, status: 'running' }]),
      '/api/v4/projects/gruppe/unter/projekt/pipelines?sha=0000000': () => json([]),
    });
    const gl = new GitLab(base, 'tok');
    expect(await gl.prHead(ref, 7)).toEqual({ state: 'closed', merged: true, sha: 'abc1234' });
    expect(await gl.pr(ref, 8)).toEqual({ state: 'open', merged: false });
    expect(await gl.createPr(ref, { title: 't', body: 'b', head: 'h', base: 'main' })).toEqual({ number: 9, url: 'https://gitlab.com/mr/9' });
    expect(await gl.renovatePrs(ref)).toEqual([{ number: 3, title: 'Update x', url: 'u', branch: 'renovate/x-2.x' }]);
    expect((await gl.checks(ref, 'abc1234')).runs[0]).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect((await gl.checks(ref, 'def5678')).runs[0]).toMatchObject({ status: 'in_progress', conclusion: null });
    expect((await gl.checks(ref, '0000000')).runs).toEqual([]);
  });

  it('listet Projekte mit Sichtbarkeit, Archiv und Fork', async () => {
    route({
      '/api/v4/projects?membership=true': () => json([
        { path_with_namespace: 'g/a', web_url: 'https://gitlab.com/g/a', visibility: 'private', archived: false, default_branch: 'main', last_activity_at: '2026-01-01' },
        { path_with_namespace: 'g/b', web_url: 'https://gitlab.com/g/b', visibility: 'public', archived: true, forked_from_project: { id: 1 } },
      ]),
    });
    expect(await new GitLab(base, 't').listRepos()).toMatchObject([{ fullName: 'g/a', private: true, archived: false }, { fullName: 'g/b', private: false, archived: true, fork: true }]);
  });
});

describe('Token erneuern', () => {
  afterEach(() => vi.restoreAllMocks());
  it('erneuert ein abgelaufenes GitLab-Token mit dem Refresh-Token und speichert das neue verschlüsselt', async () => {
    const db = openDb(':memory:');
    const cfg = loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', GITLAB_CLIENT_ID: 'cid' });
    const ctx: Ctx = { cfg, db, key: Buffer.alloc(32, 7) };
    const id = randomUUID();
    db.prepare("INSERT INTO accounts (id, provider, host, login, token_enc, refresh_enc, expires_at, via, created_at) VALUES (?, 'gitlab', 'gitlab.com', 'me', ?, ?, ?, 'device', ?)").run(
      id, encrypt(ctx.key, 'alt'), encrypt(ctx.key, 'refresh-alt'), Date.now() - 1000, Date.now(),
    );
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ access_token: 'neu', refresh_token: 'refresh-neu', expires_in: 7200 }));
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow;
    expect(await accountToken(ctx, acc)).toBe('neu');
    expect(Object.fromEntries(new URLSearchParams((spy.mock.calls[0]?.[1] as RequestInit).body as string))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-alt', client_id: 'cid' });
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow;
    expect(row.token_enc).not.toContain('neu');
    expect(decrypt(ctx.key, row.token_enc)).toBe('neu');
    expect(decrypt(ctx.key, row.refresh_enc as string)).toBe('refresh-neu');
    expect(row.expires_at).toBeGreaterThan(Date.now() + 7000_000);
    // ein gültiges Token wird nicht erneuert
    spy.mockClear();
    expect(await accountToken(ctx, row)).toBe('neu');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Konten und Repository-Auswahl (API)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  const H = { 'x-csrf-token': 'dev-csrf', 'content-type': 'application/json' };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: H, payload });
  const github = vi.hoisted(() => ({ polls: 0, calls: [] as string[] }));

  const REPOS = [
    { full_name: 'octo/homelab', html_url: 'https://github.com/octo/homelab', private: true, archived: false, fork: false, default_branch: 'main', description: 'Mein Lab', pushed_at: '2026-10-01T00:00:00Z' },
    { full_name: 'octo/app', html_url: 'https://github.com/octo/app', private: false, archived: false, fork: false, default_branch: 'main', description: null, pushed_at: null },
    { full_name: 'org/alt', html_url: 'https://github.com/org/alt', private: true, archived: true, fork: false, default_branch: 'master', description: null, pushed_at: null },
  ];

  beforeAll(async () => {
    db = openDb(':memory:');
    ({ app } = await buildApp({ ...loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', GITHUB_CLIENT_ID: 'gh-client' }), env: 'test' as never }, { db }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      github.calls.push(url);
      if (url === 'https://github.com/login/device/code') return json({ device_code: 'dc-geheim', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      if (url === 'https://github.com/login/oauth/access_token') {
        github.polls++;
        return github.polls === 1 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_geheimes_token', token_type: 'bearer', scope: 'repo' });
      }
      if (url === 'https://api.github.com/user') {
        const auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
        return auth === 'Bearer gho_geheimes_token' || auth === 'Bearer ghp_eingefuegt_123' ? json({ login: 'octo', name: 'Octo Cat' }) : json({}, 401);
      }
      if (url.startsWith('https://api.github.com/user/repos')) return json(REPOS);
      return json({ message: 'nicht gefunden' }, 404);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('meldet über den Gerätecode an und hält den Mindestabstand zwischen den Abfragen ein', async () => {
    const start = (await post('/api/accounts/device/start', { provider: 'github' })).json();
    expect(start).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 });
    expect(JSON.stringify(start)).not.toContain('dc-geheim'); // der Gerätecode bleibt auf dem Server
    const stored = db.prepare('SELECT device_code_enc FROM device_flows').get() as { device_code_enc: string };
    expect(stored.device_code_enc).not.toContain('dc-geheim');

    expect((await post('/api/accounts/device/poll', { flowId: start.flowId })).json()).toEqual({ status: 'pending' });
    const before = github.polls;
    expect((await post('/api/accounts/device/poll', { flowId: start.flowId })).json()).toEqual({ status: 'pending' }); // zu früh
    expect(github.polls).toBe(before); // der Anbieter wurde nicht befragt
    db.prepare('UPDATE device_flows SET last_poll = 0').run();
    const ok = (await post('/api/accounts/device/poll', { flowId: start.flowId })).json();
    expect(ok.status).toBe('ok');
    expect(ok.account).toMatchObject({ provider: 'github', login: 'octo', via: 'device' });
    expect(JSON.stringify(ok)).not.toContain('gho_geheimes_token');
    const row = db.prepare('SELECT token_enc FROM accounts').get() as { token_enc: string };
    expect(row.token_enc).not.toContain('gho_');
    expect(db.prepare('SELECT COUNT(*) AS n FROM device_flows').get()).toEqual({ n: 0 });
  });

  it('lehnt den Geräte-Login ohne eingerichtete Client-ID ab und nimmt dann den Token-Weg', async () => {
    const r = await post('/api/accounts/device/start', { provider: 'gitlab' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/GITLAB_CLIENT_ID/);
    expect((await post('/api/accounts/token', { provider: 'github', token: 'ghp_falsch_123456' })).statusCode).toBe(400);
    const ok = await post('/api/accounts/token', { provider: 'github', token: 'ghp_eingefuegt_123' });
    expect(ok.statusCode).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 }); // gleiches Konto wird aktualisiert, nicht doppelt angelegt
  });

  it('listet alle Repositories und legt beim Auswählen Quellen an, ohne unbekannte zuzulassen', async () => {
    const acc = (await app.inject({ method: 'GET', url: '/api/accounts' })).json();
    expect(acc.providers.map((p: { id: string; deviceFlow: boolean }) => [p.id, p.deviceFlow])).toEqual([['github', true], ['gitlab', false]]);
    const id = acc.accounts[0].id;
    const repos = (await app.inject({ method: 'GET', url: `/api/accounts/${id}/repos` })).json().repos;
    expect(repos.map((r: { fullName: string }) => r.fullName)).toEqual(['octo/homelab', 'octo/app', 'org/alt']);
    expect(repos[0].watchedSourceId).toBeNull();

    // eine Quelle gibt es schon, von Hand angelegt: sie wird verknüpft statt doppelt angelegt
    const manual = randomUUID();
    db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at) VALUES (?, 'git', 'HomeLab', 'https://github.com/octo/homelab', 'ok', ?)").run(manual, Date.now());

    const w = (await post(`/api/accounts/${id}/watch`, { add: ['octo/homelab', 'octo/app', 'fremd/geheim'] })).json();
    expect(w).toMatchObject({ added: 1, linked: 1, removed: 0, skipped: ['fremd/geheim'] });
    const rows = db.prepare('SELECT name, url, provider, account_id FROM sources ORDER BY name').all() as { name: string; url: string; provider: string; account_id: string }[];
    expect(rows).toEqual([
      { name: 'HomeLab', url: 'https://github.com/octo/homelab', provider: 'github', account_id: id },
      { name: 'octo/app', url: 'https://github.com/octo/app', provider: 'github', account_id: id },
    ]);
    // jetzt als beobachtet markiert
    const again = (await app.inject({ method: 'GET', url: `/api/accounts/${id}/repos` })).json().repos;
    expect(again.filter((r: { watchedSourceId: string | null }) => r.watchedSourceId).map((r: { fullName: string }) => r.fullName)).toEqual(['octo/homelab', 'octo/app']);

    // abwählen entfernt nur Quellen dieses Kontos
    const other = randomUUID();
    db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at) VALUES (?, 'git', 'Fremd', 'https://github.com/x/y', 'ok', ?)").run(other, Date.now());
    const appId = (db.prepare("SELECT id FROM sources WHERE name = 'octo/app'").get() as { id: string }).id;
    const rm = (await post(`/api/accounts/${id}/watch`, { remove: [appId, other] })).json();
    expect(rm.removed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sources WHERE name IN ('Fremd', 'HomeLab')").get()).toEqual({ n: 2 });
  });

  it('trennt ein Konto, ohne die Quellen zu löschen', async () => {
    const id = (await app.inject({ method: 'GET', url: '/api/accounts' })).json().accounts[0].id;
    const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}`, headers: { 'x-csrf-token': 'dev-csrf' } });
    expect(del.json()).toMatchObject({ ok: true, sourcesWithoutAccess: 1 });
    expect(db.prepare("SELECT account_id FROM sources WHERE name = 'HomeLab'").get()).toEqual({ account_id: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
  });
});
