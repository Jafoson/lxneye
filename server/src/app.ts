import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from './auth.js';
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import { deriveKey } from './crypto.js';
import { openDb, type Db } from './db.js';
import { agentRoutes } from './routes/agent.js';
import { apiRoutes } from './routes/api.js';
import { setGithubToken } from './scan/registry.js';
import { registerSecurity } from './security.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Ctx;
  warmAuth: () => Promise<void>;
}

export async function buildApp(cfg: Config, opts: { db?: Db } = {}): Promise<BuiltApp> {
  const db = opts.db ?? openDb(cfg.dataDir);
  setGithubToken(cfg.githubToken);
  const ctx: Ctx = { cfg, db, key: deriveKey(cfg.secretKey) };

  const app = Fastify({
    trustProxy: cfg.trustProxy,
    bodyLimit: 1024 * 1024,
    https: cfg.tls ? { cert: readFileSync(cfg.tls.certFile), key: readFileSync(cfg.tls.keyFile), minVersion: 'TLSv1.2' } : null,
    logger:
      cfg.env === 'test'
        ? false
        : { level: cfg.isProd ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'Unbehandelter Fehler');
      return reply.code(500).send({ error: 'Interner Fehler' });
    }
    return reply.code(status).send({ error: err.message });
  });

  await registerSecurity(app, cfg);
  await app.register(cookie);

  const auth = createAuth(ctx);

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

  // Der Agent ist öffentlicher Code ohne Geheimnisse; er wird hier bereitgestellt, damit man ihn per curl holen kann.
  const agentFile = process.env.AGENT_FILE ?? resolve(process.cwd(), '../agent/lxneye-agent.mjs');
  if (existsSync(agentFile)) {
    const agentSource = readFileSync(agentFile, 'utf8');
    app.get('/agent.mjs', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(agentSource));
  }
  await auth.routes(app);
  await agentRoutes(app, ctx);
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => auth.requireUser(req, reply));
    await apiRoutes(scope, ctx);
  });

  const webDir = cfg.webDir ? resolve(cfg.webDir) : undefined;
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/auth/')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Nicht gefunden' });
    });
  }

  return { app, ctx, warmAuth: auth.warm };
}
