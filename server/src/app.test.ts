import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { isAllowed } from './auth.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { decrypt, deriveKey, encrypt } from './crypto.js';
import { openDb } from './db.js';
import { isHostAllowed } from './http.js';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from './crypto.js';

const PROD_ENV = {
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://lxneye.example.com',
  TRUST_PROXY: 'true',
  SECRET_KEY: 'x'.repeat(48),
  OIDC_ISSUER: 'https://sso.example.com',
  OIDC_CLIENT_ID: 'id',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_ALLOWED_EMAILS: 'Me@Example.com',
} as const;

describe('Konfiguration', () => {
  it('lehnt unsichere Produktionskonfiguration ab', () => {
    expect(() => loadConfig({ ...PROD_ENV, PUBLIC_URL: 'http://lxneye.example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD_ENV, SECRET_KEY: 'kurz' })).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({ ...PROD_ENV, TRUST_PROXY: undefined })).toThrow(/TLS|Proxy/);
    expect(() => loadConfig({ ...PROD_ENV, OIDC_ALLOWED_EMAILS: undefined })).toThrow(/Zugriffsregel/);
    expect(() => loadConfig({ ...PROD_ENV, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER/);
    expect(() => loadConfig({ ...PROD_ENV, OIDC_ISSUER: 'http://sso.example.com' })).toThrow(/https/);
  });
  it('erlaubt AUTH_DISABLED nur in der Entwicklung und nur lokal', () => {
    expect(() => loadConfig({ ...PROD_ENV, AUTH_DISABLED: 'true' })).toThrow(/AUTH_DISABLED/);
    expect(() => loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', HOST: '0.0.0.0' })).toThrow(/localhost/);
    const dev = loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' });
    expect(dev.devAuth).toBe(true);
    expect(dev.host).toBe('127.0.0.1');
  });
  it('akzeptiert eine vollständige Konfiguration', () => {
    const cfg = loadConfig({ ...PROD_ENV });
    expect(cfg.isProd).toBe(true);
    expect(cfg.oidc.allowedEmails).toEqual(['me@example.com']);
  });
});

describe('Zugriffsregeln', () => {
  const cfg = loadConfig({ ...PROD_ENV, OIDC_ALLOWED_DOMAINS: '@corp.de', OIDC_ALLOWED_GROUPS: 'admins' });
  it('prüft E-Mail, Domain und Gruppe', () => {
    expect(isAllowed(cfg, { email: 'me@example.com' })).toBe(true);
    expect(isAllowed(cfg, { email: 'x@corp.de' })).toBe(true);
    expect(isAllowed(cfg, { email: 'x@evil.de' })).toBe(false);
    expect(isAllowed(cfg, { email: 'x@evil.de', groups: ['admins'] })).toBe(true);
    expect(isAllowed(cfg, { email: 'x@corp.de', email_verified: false })).toBe(false);
  });
});

describe('Krypto und SSRF-Schutz', () => {
  it('verschlüsselt und erkennt Manipulation', () => {
    const key = deriveKey('geheim'.repeat(8));
    const enc = encrypt(key, 'token-123');
    expect(enc).not.toContain('token-123');
    expect(decrypt(key, enc)).toBe('token-123');
    expect(() => decrypt(key, enc.slice(0, -2) + 'AA')).toThrow();
    expect(() => decrypt(deriveKey('anderer-schluessel-anderer-schluessel'), enc)).toThrow();
  });
  it('erlaubt nur bekannte Hosts', () => {
    expect(isHostAllowed('api.github.com')).toBe(true);
    expect(isHostAllowed('europe-docker.pkg.dev')).toBe(true);
    expect(isHostAllowed('169.254.169.254')).toBe(false);
    expect(isHostAllowed('evil.example.com')).toBe(false);
    expect(isHostAllowed('api.github.com.evil.com')).toBe(false);
  });
});

describe('Server in Produktion', () => {
  let app: FastifyInstance;
  let cfg: Config;
  let cookie: string;
  let csrf: string;
  let dbRef: ReturnType<typeof openDb>;
  const H = { host: 'lxneye.example.com', 'x-forwarded-proto': 'https' };

  beforeAll(async () => {
    cfg = { ...loadConfig({ ...PROD_ENV }), env: 'test' as never, isProd: true };
    const db = openDb(':memory:');
    dbRef = db;
    ({ app } = await buildApp(cfg, { db }));
    const sid = 'sid-' + randomUUID();
    csrf = 'csrf-' + randomUUID();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sha256Hex(sid), 'sub1', 'me@example.com', 'Ich', csrf, Date.now(), Date.now(), Date.now() + 3600_000);
    cookie = `__Host-lxneye_session=${sid}`;
  });
  afterAll(async () => app.close());

  it('lehnt HTTP ab', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'lxneye.example.com' } });
    expect(r.statusCode).toBe(426);
  });

  it('lehnt falschen Host ab', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/session', headers: { ...H, host: 'evil.example.com' } });
    expect(r.statusCode).toBe(421);
  });

  it('setzt Sicherheits-Header über HTTPS', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/session', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.headers['strict-transport-security']).toContain('max-age=');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.json()).toEqual({ authenticated: false });
  });

  it('verlangt Anmeldung für die API', async () => {
    for (const url of ['/api/items', '/api/sources', '/api/settings']) {
      expect((await app.inject({ method: 'GET', url, headers: H })).statusCode).toBe(401);
    }
  });

  it('erlaubt Healthcheck nur über Loopback', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz', remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'GET', url: '/healthz', remoteAddress: '10.0.0.5', headers: { host: 'lxneye.example.com' } });
    expect(r2.statusCode).toBe(426);
  });

  it('prüft CSRF bei schreibenden Anfragen', async () => {
    const hdr = { ...H, cookie, 'content-type': 'application/json' };
    const noCsrf = await app.inject({ method: 'PUT', url: '/api/settings/update-mode', headers: hdr, payload: { mode: 'commit' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'PUT', url: '/api/settings/update-mode', headers: { ...hdr, 'x-csrf-token': csrf, origin: 'https://evil.example.com' }, payload: { mode: 'commit' } });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/update-mode', headers: { ...hdr, 'x-csrf-token': csrf, origin: 'https://lxneye.example.com' }, payload: { mode: 'commit' } });
    expect(ok.statusCode).toBe(200);
    const s = await app.inject({ method: 'GET', url: '/api/settings', headers: { ...H, cookie } });
    expect(s.json().updateMode).toBe('commit');
  });

  it('validiert Eingaben', async () => {
    const hdr = { ...H, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const bad = await app.inject({ method: 'POST', url: '/api/sources', headers: hdr, payload: { kind: 'git', name: 'x', url: 'http://github.com/a/b' } });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: 'POST', url: '/api/sources', headers: hdr, payload: { kind: 'server', name: 'a', evil: 1 } });
    expect(extra.statusCode).toBe(400);
  });

  it('fasst gleiche Images aus mehreren Dateien zu einer Zeile zusammen', async () => {
    const hdr = { ...H, cookie };
    const db = dbRef;
    const srcId = randomUUID();
    db.prepare("INSERT INTO sources (id, kind, name, url, status, created_at) VALUES (?, 'git', 'grp-repo', 'https://github.com/a/b', 'ok', ?)").run(srcId, Date.now());
    const add = (file: string, server: string, cur = '35.0.2-apache') =>
      db.prepare('INSERT INTO items (id, source_id, key, name, type, ecosystem, file, current, latest, bump, candidates, server, locator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), srcId, file, 'nextcloud', 'Image', 'docker', file, cur, '36.0.0-apache', 'Major', JSON.stringify([{ level: 'Patch', version: '35.0.3-apache' }, { level: 'Major', version: '36.0.0-apache' }]), server, '{}', Date.now());
    add('a.yaml', 'server1');
    add('b.yaml', 'server1');
    add('c.yaml', 'server2');
    add('d.yaml', 'server1', '34.0.0-apache'); // andere Version: eigene Zeile
    const r = await app.inject({ method: 'GET', url: '/api/items', headers: hdr });
    const rows = r.json().items.filter((i: { sourceName: string }) => i.sourceName === 'grp-repo');
    expect(rows).toHaveLength(2);
    const g = rows.find((x: { current: string }) => x.current === '35.0.2-apache');
    expect(g.locations).toHaveLength(3);
    expect(g.servers).toEqual(['server1', 'server2']);
    expect(g.candidates.map((c: { level: string }) => c.level)).toEqual(['Patch', 'Major']);
  });

  it('lehnt unbekannte Zielversionen ab', async () => {
    const hdr = { ...H, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const items = (await app.inject({ method: 'GET', url: '/api/items', headers: { ...H, cookie } })).json().items;
    const id = items.find((i: { sourceName: string }) => i.sourceName === 'grp-repo').id;
    const r = await app.inject({ method: 'POST', url: `/api/items/${id}/update`, headers: hdr, payload: { to: '99.0.0' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Zielversion/);
  });

  it('verwaltet Schnellnavigation-Links und lehnt gefährliche Adressen ab', async () => {
    const hdr = { ...H, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/links', headers: hdr, payload });
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://x.de', 'https://user:pw@x.de', 'kein link']) {
      expect((await post({ title: 'x', url })).statusCode).toBe(400);
    }
    expect((await post({ title: 'x', url: 'https://a.de', icon: 'i:gibtsnicht' })).statusCode).toBe(400);
    expect((await post({ title: 'x', url: 'https://a.de', icon: 'e:<b>' })).statusCode).toBe(400);
    expect((await post({ title: 'x', url: 'https://a.de', icon: 'e:📘' })).statusCode).toBe(400); // nur eingebaute Symbole
    expect((await post({ title: 'x', url: 'https://a.de', extra: 1 })).statusCode).toBe(400);

    const ok = await post({ title: 'Grafana', url: 'http://192.168.1.5:3000/', icon: 'i:chart' });
    expect(ok.statusCode).toBe(201);
    const id = ok.json().link.id;
    expect((await post({ title: 'Wiki', url: 'https://wiki.example.com', icon: 'i:book' })).statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/api/links', headers: { ...H, cookie } })).json().links;
    expect(list.map((l: { title: string }) => l.title)).toEqual(['Grafana', 'Wiki']);
    const upd = await app.inject({ method: 'PATCH', url: `/api/links/${id}`, headers: hdr, payload: { title: 'Grafana 2', url: 'https://g.example.com', icon: 'i:server' } });
    expect(upd.json().link).toMatchObject({ title: 'Grafana 2', icon: 'i:server' });
    expect((await app.inject({ method: 'DELETE', url: `/api/links/${id}`, headers: { ...H, cookie, 'x-csrf-token': csrf } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/links', headers: { ...H, cookie } })).json().links).toHaveLength(1);
    // ohne Anmeldung und ohne CSRF-Token geht nichts
    expect((await app.inject({ method: 'GET', url: '/api/links', headers: H })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/links', headers: { ...H, cookie, 'content-type': 'application/json' }, payload: { title: 'x', url: 'https://a.de' } })).statusCode).toBe(403);
  });

  it('legt Agent-Quellen an und nimmt nur Berichte mit gültigem Token an', async () => {
    const hdr = { ...H, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const created = await app.inject({ method: 'POST', url: '/api/sources', headers: hdr, payload: { kind: 'server', name: 'vps-1' } });
    expect(created.statusCode).toBe(201);
    const { agentToken, source } = created.json();
    expect(agentToken).toMatch(/^lxe_/);
    expect(JSON.stringify(source)).not.toContain(agentToken);

    const noTok = await app.inject({ method: 'POST', url: '/api/agent/report', headers: { ...H, 'content-type': 'application/json' }, payload: { runtime: 'docker', containers: [] } });
    expect(noTok.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/api/agent/report', headers: { ...H, 'content-type': 'application/json', authorization: 'Bearer lxe_falsch' }, payload: { runtime: 'docker', containers: [] } });
    expect(wrong.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/agent/report', headers: { ...H, 'content-type': 'application/json', authorization: `Bearer ${agentToken}` }, payload: { runtime: 'docker', hostname: 'vps-1', containers: [] } });
    expect(good.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/sources', headers: { ...H, cookie } });
    expect(list.json().sources[0].status).toBe('ok');
  });
});

describe('Entwicklung ohne SSO', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const cfg = loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' });
    ({ app } = await buildApp({ ...cfg, env: 'test' as never }, { db: openDb(':memory:') }));
  });
  afterAll(async () => app.close());

  it('braucht keine Anmeldung und leitet alte Login-Links zur Startseite', async () => {
    const s = await app.inject({ method: 'GET', url: '/api/session' });
    expect(s.json()).toMatchObject({ authenticated: true, devAuth: true });
    expect((await app.inject({ method: 'GET', url: '/api/items' })).statusCode).toBe(200);
    for (const url of ['/auth/login', '/auth/callback']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/');
    }
  });

  it('schützt schreibende Anfragen trotzdem per CSRF-Token', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/update-mode', payload: { mode: 'commit' } });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/update-mode', headers: { 'x-csrf-token': 'dev-csrf' }, payload: { mode: 'commit' } });
    expect(ok.statusCode).toBe(200);
  });
});
