import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Ctx, SourceRow } from '../ctx.js';
import { sha256Hex } from '../crypto.js';
import { agentReportSchema, ingestAgentReport } from '../scan/run.js';

/** Eingang für den lxnEye-Agent. Jede Quelle hat ihr eigenes Token, gespeichert wird nur der Hash. */
export async function agentRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.post(
    '/api/agent/report',
    { bodyLimit: 2 * 1024 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token.startsWith('lxe_')) return reply.code(401).send({ error: 'Token fehlt' });
      const src = ctx.db.prepare('SELECT * FROM sources WHERE agent_token_hash = ?').get(sha256Hex(token)) as SourceRow | undefined;
      if (!src) return reply.code(401).send({ error: 'Token ungültig' });
      try {
        await ingestAgentReport(ctx, src, agentReportSchema.parse(req.body));
        return { ok: true };
      } catch (err) {
        if (err instanceof ZodError) return reply.code(400).send({ error: 'Ungültiger Bericht' });
        req.log.error({ err }, 'Agent-Bericht fehlgeschlagen');
        return reply.code(500).send({ error: 'Interner Fehler' });
      }
    },
  );
}
