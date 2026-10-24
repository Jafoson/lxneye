import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

/** Minimaler OIDC-Anbieter für den Test: Discovery, JWKS, Authorize (auto-Login), Token mit PKCE-Prüfung. */
function startMockIdp(email: { value: string; verified: boolean }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  let issuer = '';
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (o: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
        redirect: url.searchParams.get('redirect_uri') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.statusCode = 302;
      res.setHeader('location', back.toString());
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const entry = codes.get(p.get('code') ?? '');
        codes.delete(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const ok = entry && createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
        if (!ok || !entry) {
          res.statusCode = 400;
          return json({ error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
        const payload = b64({
          iss: issuer, sub: 'user-1', aud: 'lxneye-client', iat: now, exp: now + 300, nonce: entry.nonce,
          email: email.value, email_verified: email.verified, name: 'Test Nutzer',
        });
        const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
        return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: `${header}.${payload}.${sig}` });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise<{ server: Server; issuer: () => string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ server, issuer: () => issuer });
    });
  });
}

describe('SSO-Anmeldung (OIDC, PKCE, State, Nonce)', () => {
  const identity = { value: 'me@example.com', verified: true };
  let idp: Awaited<ReturnType<typeof startMockIdp>>;
  let app: FastifyInstance;

  beforeAll(async () => {
    idp = await startMockIdp(identity);
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL: 'http://localhost:5173',
      OIDC_ISSUER: idp.issuer(),
      OIDC_CLIENT_ID: 'lxneye-client',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOWED_EMAILS: 'me@example.com',
    });
    ({ app } = await buildApp(cfg, { db: openDb(':memory:') }));
  });
  afterAll(async () => {
    await app.close();
    idp.server.close();
  });

  async function startLogin() {
    const login = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.statusCode).toBe(302);
    const location = new URL(login.headers.location as string);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    const bindingCookie = login.cookies.find((c) => c.name === 'lxneye_login');
    expect(bindingCookie?.httpOnly).toBe(true);
    const authz = await fetch(location, { redirect: 'manual' });
    const back = new URL(authz.headers.get('location') as string);
    return { back, binding: `lxneye_login=${bindingCookie?.value}` };
  }

  it('meldet einen freigegebenen Nutzer an und setzt ein sicheres Cookie', async () => {
    identity.value = 'me@example.com';
    const { back, binding } = await startLogin();
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: binding } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    const session = cb.cookies.find((c) => c.name === 'lxneye_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    const me = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `lxneye_session=${session?.value}` } });
    expect(me.json()).toMatchObject({ authenticated: true, user: { email: 'me@example.com' } });
    // Code/State sind nur einmal verwendbar
    const replay = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: binding } });
    expect(replay.statusCode).toBe(400);
  });

  it('weist Konten ab, die nicht freigegeben sind', async () => {
    identity.value = 'fremd@example.org';
    const { back, binding } = await startLogin();
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: binding } });
    expect(cb.statusCode).toBe(403);
    expect(cb.cookies.find((c) => c.name === 'lxneye_session')).toBeUndefined();
  });

  it('weist unbestätigte E-Mail-Adressen ab', async () => {
    identity.value = 'me@example.com';
    identity.verified = false;
    const { back, binding } = await startLogin();
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: binding } });
    expect(cb.statusCode).toBe(403);
    identity.verified = true;
  });

  it('verlangt das zum Anmeldevorgang gehörende Cookie (Login-CSRF)', async () => {
    identity.value = 'me@example.com';
    const { back } = await startLogin();
    const noCookie = await app.inject({ method: 'GET', url: back.pathname + back.search });
    expect(noCookie.statusCode).toBe(400);
    const { back: back2 } = await startLogin();
    const wrong = await app.inject({ method: 'GET', url: back2.pathname + back2.search, headers: { cookie: 'lxneye_login=falsch' } });
    expect(wrong.statusCode).toBe(400);
  });

  it('weist einen erfundenen State ab', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=erfunden', headers: { cookie: 'lxneye_login=x' } });
    expect(r.statusCode).toBe(400);
  });

  it('beendet die Sitzung beim Abmelden', async () => {
    identity.value = 'me@example.com';
    const { back, binding } = await startLogin();
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: binding } });
    const sid = cb.cookies.find((c) => c.name === 'lxneye_session')?.value as string;
    const cookie = `lxneye_session=${sid}`;
    const info = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const csrf = info.json().csrf as string;
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});
