import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { AccountRow, Ctx, SourceRow } from '../ctx.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, now } from '../db.js';
import { accountToken, apiFor, parseRepoUrl, type Provider } from '../git/open.js';
import type { RemoteRepo } from '../git/provider.js';
import { HttpError, safeFetch } from '../http.js';
import { scanMany } from '../scan/run.js';

/** Zugang über die Anmeldung bei GitHub/GitLab (Device-Flow) oder über einen eingefügten Token. */

const SCOPES = {
  github: { private: 'repo', public: 'public_repo' },
  gitlab: { private: 'api', public: 'api' },
} as const;

const providerSchema = z.enum(['github', 'gitlab']);

function endpoints(ctx: Ctx, p: Provider) {
  if (p === 'github') {
    return { code: 'https://github.com/login/device/code', token: 'https://github.com/login/oauth/access_token', host: 'github.com', clientId: ctx.cfg.githubClientId };
  }
  const o = ctx.cfg.gitlabUrl.origin;
  return { code: `${o}/oauth/authorize_device`, token: `${o}/oauth/token`, host: ctx.cfg.gitlabUrl.host, clientId: ctx.cfg.gitlabClientId };
}

async function postJson<T>(url: string, body: object): Promise<{ status: number; data: T }> {
  // OAuth-Endpunkte erwarten Formulardaten (application/x-www-form-urlencoded)
  const res = await safeFetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString(), timeoutMs: 20_000 });
  let data = {} as T;
  try {
    data = JSON.parse(res.text) as T;
  } catch {
    /* kein JSON */
  }
  return { status: res.status, data };
}

const accountDto = (ctx: Ctx, a: AccountRow) => ({
  id: a.id,
  provider: a.provider,
  host: a.host,
  login: a.login,
  name: a.display_name,
  via: a.via,
  scope: a.scope,
  createdAt: a.created_at,
  expiresAt: a.expires_at,
  watched: (ctx.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE account_id = ?').get(a.id) as { n: number }).n,
});

const repoCache = new Map<string, { at: number; repos: RemoteRepo[] }>();

export async function accountRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg } = ctx;
  const actor = (req: { user?: { email: string | null; sub: string } }): string | null => req.user?.email ?? req.user?.sub ?? null;
  const bad = (err: unknown) => ({
    code: err instanceof ZodError ? 400 : err instanceof HttpError && err.status === 0 ? 502 : 400,
    error: err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : 'Fehler',
  });

  const getAccount = (id: string): AccountRow | undefined => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;

  async function saveAccount(provider: Provider, token: string, extra: { refresh?: string; expiresIn?: number; scope?: string; via: 'device' | 'token' }): Promise<AccountRow> {
    const me = await apiFor(cfg, provider, token).me();
    const host = endpoints(ctx, provider).host;
    const existing = db.prepare('SELECT * FROM accounts WHERE provider = ? AND host = ? AND login = ?').get(provider, host, me.login) as AccountRow | undefined;
    const id = existing?.id ?? randomUUID();
    db.prepare(
      `INSERT INTO accounts (id, provider, host, login, display_name, token_enc, refresh_enc, expires_at, scope, via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, token_enc = excluded.token_enc, refresh_enc = excluded.refresh_enc,
         expires_at = excluded.expires_at, scope = excluded.scope, via = excluded.via`,
    ).run(id, provider, host, me.login, me.name, encrypt(ctx.key, token), extra.refresh ? encrypt(ctx.key, extra.refresh) : null,
      extra.expiresIn ? now() + extra.expiresIn * 1000 : null, extra.scope ?? null, extra.via, now());
    repoCache.delete(id);
    return getAccount(id) as AccountRow;
  }

  app.get('/api/accounts', async () => ({
    accounts: (db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[]).map((a) => accountDto(ctx, a)),
    providers: [
      { id: 'github', label: 'GitHub', host: 'github.com', deviceFlow: !!cfg.githubClientId },
      { id: 'gitlab', label: 'GitLab', host: cfg.gitlabUrl.host, deviceFlow: !!cfg.gitlabClientId },
    ],
  }));

  // --- Anmeldung per Gerätecode: kein Passwort und kein Redirect, der Nutzer bestätigt auf der Plattform ---
  app.post('/api/accounts/device/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = z.object({ provider: providerSchema, access: z.enum(['private', 'public']).default('private') }).strict().parse(req.body);
      const ep = endpoints(ctx, b.provider);
      if (!ep.clientId) return reply.code(400).send({ error: `Die Anmeldung über ${b.provider === 'github' ? 'GitHub' : 'GitLab'} ist nicht eingerichtet (${b.provider === 'github' ? 'GITHUB_CLIENT_ID' : 'GITLAB_CLIENT_ID'}). Du kannst stattdessen einen Token einfügen.` });
      db.prepare('DELETE FROM device_flows WHERE expires_at < ?').run(now());
      if ((db.prepare('SELECT COUNT(*) AS n FROM device_flows').get() as { n: number }).n >= 5) return reply.code(429).send({ error: 'Es laufen schon mehrere Anmeldungen. Bitte kurz warten.' });
      const scope = SCOPES[b.provider][b.access];
      const r = await postJson<{ device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>(ep.code, { client_id: ep.clientId, scope });
      if (!r.data.device_code || !r.data.user_code) {
        return reply.code(400).send({ error: `Der Anbieter hat die Anmeldung abgelehnt${r.data.error_description ? `: ${r.data.error_description}` : ''}. Prüfe die Client-ID und ob der Geräte-Login für die App aktiviert ist.` });
      }
      const id = randomUUID();
      const interval = Math.max(5, r.data.interval ?? 5);
      db.prepare('INSERT INTO device_flows (id, provider, device_code_enc, scope, interval_s, last_poll, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(
        id, b.provider, encrypt(ctx.key, r.data.device_code), scope, interval, now() + (r.data.expires_in ?? 900) * 1000, now(),
      );
      return { flowId: id, userCode: r.data.user_code, verificationUri: r.data.verification_uri ?? r.data.verification_uri_complete ?? '', interval, expiresIn: r.data.expires_in ?? 900 };
    } catch (err) {
      const e = bad(err);
      return reply.code(e.code).send({ error: e.error });
    }
  });

  app.post('/api/accounts/device/poll', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = z.object({ flowId: z.string().uuid() }).strict().parse(req.body);
      const flow = db.prepare('SELECT * FROM device_flows WHERE id = ?').get(b.flowId) as
        | { id: string; provider: Provider; device_code_enc: string; scope: string; interval_s: number; last_poll: number; expires_at: number }
        | undefined;
      if (!flow) return reply.code(404).send({ error: 'Anmeldung nicht gefunden oder abgelaufen.' });
      if (flow.expires_at < now()) {
        db.prepare('DELETE FROM device_flows WHERE id = ?').run(flow.id);
        return { status: 'error', message: 'Der Code ist abgelaufen. Starte die Anmeldung neu.' };
      }
      // Den vom Anbieter vorgegebenen Mindestabstand einhalten
      if (now() - flow.last_poll < flow.interval_s * 1000 - 500) return { status: 'pending' };
      db.prepare('UPDATE device_flows SET last_poll = ? WHERE id = ?').run(now(), flow.id);
      const ep = endpoints(ctx, flow.provider);
      const r = await postJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>(ep.token, {
        client_id: ep.clientId, device_code: decrypt(ctx.key, flow.device_code_enc), grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (r.data.access_token) {
        const acc = await saveAccount(flow.provider, r.data.access_token, { refresh: r.data.refresh_token, expiresIn: r.data.expires_in, scope: r.data.scope ?? flow.scope, via: 'device' });
        db.prepare('DELETE FROM device_flows WHERE id = ?').run(flow.id);
        audit(db, actor(req), 'account.connect', `${flow.provider}: ${acc.login}`);
        return { status: 'ok', account: accountDto(ctx, acc) };
      }
      const err = r.data.error;
      if (err === 'authorization_pending') return { status: 'pending' };
      if (err === 'slow_down') {
        db.prepare('UPDATE device_flows SET interval_s = interval_s + 5 WHERE id = ?').run(flow.id);
        return { status: 'pending' };
      }
      db.prepare('DELETE FROM device_flows WHERE id = ?').run(flow.id);
      return { status: 'error', message: err === 'access_denied' ? 'Du hast die Anmeldung auf der Plattform abgelehnt.' : err === 'expired_token' ? 'Der Code ist abgelaufen. Starte die Anmeldung neu.' : 'Die Anmeldung ist fehlgeschlagen.' };
    } catch (err) {
      const e = bad(err);
      return reply.code(e.code).send({ error: e.error });
    }
  });

  // --- Alternative: eigenen Token einfügen (geht überall, auch ohne OAuth-App) ---
  app.post('/api/accounts/token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = z.object({ provider: providerSchema, token: z.string().trim().min(10).max(500) }).strict().parse(req.body);
      const acc = await saveAccount(b.provider, b.token, { via: 'token' });
      audit(db, actor(req), 'account.connect', `${b.provider}: ${acc.login} (Token)`);
      return reply.code(201).send({ account: accountDto(ctx, acc) });
    } catch (err) {
      const e = bad(err);
      return reply.code(e.code).send({ error: e.error });
    }
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const acc = getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'Konto nicht gefunden' });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM sources WHERE account_id = ?').get(id) as { n: number }).n;
    // Die beobachteten Quellen bleiben bestehen, verlieren aber ihren Zugang
    db.prepare('UPDATE sources SET account_id = NULL WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    repoCache.delete(id);
    audit(db, actor(req), 'account.disconnect', `${acc.provider}: ${acc.login} (${n} Quellen ohne Zugang)`);
    return { ok: true, sourcesWithoutAccess: n };
  });

  async function reposOf(acc: AccountRow, fresh = false): Promise<RemoteRepo[]> {
    const hit = repoCache.get(acc.id);
    if (!fresh && hit && now() - hit.at < 60_000) return hit.repos;
    const repos = await apiFor(cfg, acc.provider, await accountToken(ctx, acc)).listRepos();
    repoCache.set(acc.id, { at: now(), repos });
    return repos;
  }

  const sourceForUrl = (url: string): SourceRow | undefined => db.prepare('SELECT * FROM sources WHERE url = ?').get(url) as SourceRow | undefined;

  app.get('/api/accounts/:id/repos', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.query);
      const acc = getAccount(id);
      if (!acc) return reply.code(404).send({ error: 'Konto nicht gefunden' });
      const repos = await reposOf(acc, refresh === '1');
      return {
        repos: repos.map((r) => {
          const src = sourceForUrl(r.url);
          return { ...r, watchedSourceId: src?.id ?? null, viaAccount: src?.account_id === acc.id };
        }),
      };
    } catch (err) {
      const e = bad(err);
      return reply.code(e.code).send({ error: e.error });
    }
  });

  /** Wählt aus, welche Repositories beobachtet werden: `add` legt Quellen an, `remove` entfernt sie wieder. */
  app.post('/api/accounts/:id/watch', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ add: z.array(z.string().max(300)).max(200).default([]), remove: z.array(z.string().uuid()).max(200).default([]) }).strict().parse(req.body);
      const acc = getAccount(id);
      if (!acc) return reply.code(404).send({ error: 'Konto nicht gefunden' });

      // Nur Repositories, die dieses Konto wirklich sehen darf, dürfen hinzugefügt werden
      const known = new Map((await reposOf(acc)).map((r) => [r.fullName, r]));
      const toScan: string[] = [];
      const added: string[] = [];
      const skipped: string[] = [];
      for (const full of b.add) {
        const r = known.get(full);
        if (!r) {
          skipped.push(full);
          continue;
        }
        const norm = parseRepoUrl(cfg, r.url);
        const existing = sourceForUrl(norm.url);
        if (existing) {
          // schon als Quelle vorhanden: nur mit dem Konto verknüpfen
          db.prepare('UPDATE sources SET account_id = ?, provider = ? WHERE id = ?').run(id, norm.provider, existing.id);
          toScan.push(existing.id);
          continue;
        }
        const sid = randomUUID();
        let name = full;
        if (db.prepare('SELECT 1 FROM sources WHERE name = ?').get(name)) name = `${full} (${acc.provider})`;
        db.prepare("INSERT INTO sources (id, kind, name, url, provider, account_id, scan_mode, status, created_at) VALUES (?, 'git', ?, ?, ?, ?, 'offer', 'pending', ?)").run(
          sid, name, norm.url, norm.provider, id, now(),
        );
        added.push(name);
        toScan.push(sid);
      }
      let removed = 0;
      for (const sid of b.remove) {
        const s = db.prepare('SELECT * FROM sources WHERE id = ? AND account_id = ?').get(sid, id) as SourceRow | undefined;
        if (!s) continue; // nur Quellen, die zu diesem Konto gehören
        db.prepare('UPDATE sources SET linked_source_id = NULL WHERE linked_source_id = ?').run(sid);
        db.prepare('DELETE FROM sources WHERE id = ?').run(sid);
        removed++;
      }
      audit(db, actor(req), 'account.watch', `${acc.login}: +${added.length} -${removed}`);
      void scanMany(ctx, toScan, actor(req));
      return { added: added.length, linked: toScan.length - added.length, removed, skipped };
    } catch (err) {
      const e = bad(err);
      return reply.code(e.code).send({ error: e.error });
    }
  });
}
