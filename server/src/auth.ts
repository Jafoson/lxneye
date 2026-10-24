import * as oidc from 'openid-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './ctx.js';
import type { Config } from './config.js';
import { decrypt, encrypt, randomToken, safeEqual, sha256Hex } from './crypto.js';
import { audit, now } from './db.js';

export interface SessionUser {
  sub: string;
  email: string | null;
  name: string | null;
  csrf: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const COOKIE_SESSION = (cfg: Config): string => (cfg.isProd ? '__Host-lxneye_session' : 'lxneye_session');
const COOKIE_LOGIN = (cfg: Config): string => (cfg.isProd ? '__Host-lxneye_login' : 'lxneye_login');

const cookieOpts = (cfg: Config, maxAgeSec: number) => ({
  httpOnly: true,
  secure: cfg.isProd,
  sameSite: 'lax' as const, // Lax statt Strict: der Rücksprung vom Identity-Provider ist eine Top-Level-Navigation
  path: '/',
  maxAge: maxAgeSec,
});

/** Prüft die Zugriffsregeln gegen die Claims des Identity-Providers. */
export function isAllowed(cfg: Config, claims: Record<string, unknown>): boolean {
  const o = cfg.oidc;
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  const verified = claims.email_verified !== false;
  if (email && (!o.requireEmailVerified || verified)) {
    if (o.allowedEmails.includes(email)) return true;
    const domain = email.split('@')[1];
    if (domain && o.allowedDomains.includes(domain)) return true;
  }
  const groups = claims[o.groupsClaim];
  if (Array.isArray(groups) && groups.some((g) => typeof g === 'string' && o.allowedGroups.includes(g))) return true;
  return false;
}

export function createAuth(ctx: Ctx) {
  const { cfg, db } = ctx;
  let configPromise: Promise<oidc.Configuration> | null = null;

  const getConfig = (): Promise<oidc.Configuration> => {
    if (!configPromise) {
      configPromise = oidc
        .discovery(new URL(cfg.oidc.issuer), cfg.oidc.clientId, cfg.oidc.clientSecret, undefined, {
          execute: cfg.isProd || cfg.oidc.issuer.startsWith('https://') ? [] : [oidc.allowInsecureRequests],
        })
        .catch((err) => {
          configPromise = null;
          throw err;
        });
    }
    return configPromise;
  };

  const redirectUri = new URL('/auth/callback', cfg.publicUrl).toString();

  function loadSession(req: FastifyRequest): SessionUser | undefined {
    if (cfg.devAuth) return { sub: 'dev', email: 'dev@localhost', name: 'Entwicklung', csrf: 'dev-csrf' };
    const raw = req.cookies[COOKIE_SESSION(cfg)];
    if (!raw) return undefined;
    const id = sha256Hex(raw);
    const row = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(id) as
      | { sub: string; email: string | null; name: string | null; csrf: string; last_seen: number; expires_at: number }
      | undefined;
    if (!row) return undefined;
    const t = now();
    if (row.expires_at < t || t - row.last_seen > cfg.sessionIdleMs) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(id);
      return undefined;
    }
    if (t - row.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(t, id);
    return { sub: row.sub, email: row.email, name: row.name, csrf: row.csrf };
  }

  /** Pflicht-Hook für alle geschützten Routen: Sitzung prüfen, bei schreibenden Anfragen zusätzlich CSRF. */
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = loadSession(req);
    if (!user) return reply.code(401).send({ error: 'Nicht angemeldet' });
    req.user = user;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, user.csrf)) return reply.code(403).send({ error: 'CSRF-Prüfung fehlgeschlagen' });
      const origin = req.headers.origin;
      if (origin && origin !== cfg.publicUrl.origin) return reply.code(403).send({ error: 'Unerlaubte Herkunft' });
    }
  }

  async function routes(app: FastifyInstance): Promise<void> {
    const strict = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

    if (cfg.devAuth) {
      // Entwicklung ohne SSO: es gibt nichts anzumelden, alte Lesezeichen und Links führen einfach zur Startseite.
      app.get('/auth/login', async (_req, reply) => reply.redirect('/'));
      app.get('/auth/callback', async (_req, reply) => reply.redirect('/'));
      app.post('/auth/logout', { preHandler: requireUser }, async () => ({ ok: true }));
    } else {
      app.get('/auth/login', strict, async (req, reply) => {
        let config: oidc.Configuration;
        try {
          config = await getConfig();
        } catch (err) {
          req.log.error({ err }, 'OIDC-Discovery fehlgeschlagen');
          return reply.code(502).type('text/plain; charset=utf-8').send('Der SSO-Anbieter ist nicht erreichbar. Prüfe OIDC_ISSUER.');
        }
        const verifier = oidc.randomPKCECodeVerifier();
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const binding = randomToken(24);
        db.prepare('DELETE FROM login_states WHERE created_at < ?').run(now() - 10 * 60_000);
        db.prepare('INSERT INTO login_states (state, binding_hash, verifier_enc, nonce, created_at) VALUES (?, ?, ?, ?, ?)').run(
          state, sha256Hex(binding), encrypt(ctx.key, verifier), nonce, now(),
        );
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope: cfg.oidc.scopes,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: 'S256',
          state,
          nonce,
        });
        reply.setCookie(COOKIE_LOGIN(cfg), binding, cookieOpts(cfg, 600));
        return reply.redirect(url.toString());
      });

      app.get('/auth/callback', strict, async (req, reply) => {
        const fail = (code: number, message: string) => {
          audit(db, null, 'login.failed', message);
          return reply.code(code).type('text/plain; charset=utf-8').send(`Anmeldung fehlgeschlagen: ${message}`);
        };
        const q = req.query as Record<string, string | undefined>;
        const binding = req.cookies[COOKIE_LOGIN(cfg)];
        const row = q.state
          ? (db.prepare('SELECT * FROM login_states WHERE state = ?').get(q.state) as
              | { binding_hash: string; verifier_enc: string; nonce: string; created_at: number }
              | undefined)
          : undefined;
        if (q.state) db.prepare('DELETE FROM login_states WHERE state = ?').run(q.state); // jeder State nur einmal
        reply.clearCookie(COOKIE_LOGIN(cfg), { path: '/' });
        if (!row || !binding || !safeEqual(sha256Hex(binding), row.binding_hash) || now() - row.created_at > 10 * 60_000) {
          return fail(400, 'Ungültiger oder abgelaufener Anmeldevorgang. Bitte erneut versuchen.');
        }
        try {
          const config = await getConfig();
          const current = new URL(req.raw.url ?? '', cfg.publicUrl); // nie dem Host-Header vertrauen
          const tokens = await oidc.authorizationCodeGrant(config, current, {
            pkceCodeVerifier: decrypt(ctx.key, row.verifier_enc),
            expectedState: q.state as string,
            expectedNonce: row.nonce,
            idTokenExpected: true,
          });
          const claims = tokens.claims();
          if (!claims) return fail(400, 'Der Anbieter hat kein ID-Token geliefert.');
          if (!isAllowed(cfg, claims as unknown as Record<string, unknown>)) {
            return fail(403, 'Dieses Konto ist für lxnEye nicht freigegeben.');
          }
          const sid = randomToken(32);
          const csrf = randomToken(32);
          const t = now();
          db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
          db.prepare('INSERT INTO sessions (id_hash, sub, email, name, csrf, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            sha256Hex(sid), claims.sub, typeof claims.email === 'string' ? claims.email : null,
            typeof claims.name === 'string' ? claims.name : null, csrf, t, t, t + cfg.sessionTtlMs,
          );
          reply.setCookie(COOKIE_SESSION(cfg), sid, cookieOpts(cfg, Math.floor(cfg.sessionTtlMs / 1000)));
          audit(db, typeof claims.email === 'string' ? claims.email : claims.sub, 'login');
          return reply.redirect('/');
        } catch (err) {
          req.log.warn({ err }, 'OIDC-Callback fehlgeschlagen');
          return fail(400, 'Der Anbieter hat die Anmeldung nicht bestätigt.');
        }
      });

      app.post('/auth/logout', { preHandler: requireUser }, async (req, reply) => {
        const raw = req.cookies[COOKIE_SESSION(cfg)];
        if (raw) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(raw));
        reply.clearCookie(COOKIE_SESSION(cfg), { path: '/' });
        audit(db, req.user?.email ?? req.user?.sub ?? null, 'logout');
        return { ok: true };
      });
    }

    app.get('/api/session', async (req) => {
      const user = loadSession(req);
      return user ? { authenticated: true, user: { email: user.email, name: user.name }, csrf: user.csrf, devAuth: cfg.devAuth } : { authenticated: false };
    });
  }

  const warm = async (): Promise<void> => {
    await getConfig();
  };

  return { routes, requireUser, loadSession, warm };
}
