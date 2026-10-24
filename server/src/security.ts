import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Interner Healthcheck (Docker) darf per Loopback auch ohne TLS antworten. */
function isLoopbackHealth(req: FastifyRequest): boolean {
  return req.url === '/healthz' && LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'];
}

export async function registerSecurity(app: FastifyInstance, cfg: Config): Promise<void> {
  // 1. In Produktion wird alles ohne HTTPS verweigert (keine Weiterleitung: die erste Anfrage soll nie im Klartext Daten verarbeiten).
  // 2. Der Host-Header muss zu PUBLIC_URL passen (Schutz vor Host-Header-Angriffen und DNS-Rebinding).
  app.addHook('onRequest', async (req, reply) => {
    if (!cfg.isProd) return;
    if (isLoopbackHealth(req)) return;
    if (req.protocol !== 'https') {
      return reply.code(426).header('upgrade', 'TLS/1.2, HTTP/1.1').type('text/plain; charset=utf-8').send('HTTPS erforderlich. Unverschlüsselte Verbindungen werden abgelehnt.');
    }
    if (req.host !== cfg.publicUrl.host) {
      return reply.code(421).type('text/plain; charset=utf-8').send('Falscher Host.');
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: cfg.isProd ? [] : null,
      },
    },
    hsts: cfg.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) reply.header('cache-control', 'no-store');
  });

  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
}
