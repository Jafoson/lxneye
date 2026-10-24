import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { Ctx } from '../ctx.js';
import { audit, now } from '../db.js';

/** Symbole, die die Oberfläche selbst mitbringt. Eigene Bilder werden bewusst nicht von fremden Seiten geladen. */
export const LINK_ICONS = [
  'link', 'globe', 'server', 'database', 'shield', 'git', 'container', 'chart', 'mail', 'cloud', 'file', 'lock',
  'terminal', 'home', 'camera', 'music', 'video', 'book', 'settings', 'network', 'cpu', 'bell', 'star', 'code',
] as const;

/** Nur normale Web-Adressen, keine javascript:-, data:- oder file:-Links und keine Zugangsdaten in der URL. */
export function parseLinkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Das ist keine gültige Adresse. Beispiel: https://grafana.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nur http:// und https:// sind erlaubt.');
  if (u.username || u.password) throw new Error('Zugangsdaten gehören nicht in die Adresse.');
  if (!u.hostname) throw new Error('Die Adresse braucht einen Servernamen.');
  return u.toString();
}

const iconSchema = z
  .string()
  .max(20)
  .refine((v) => (v.startsWith('i:') ? (LINK_ICONS as readonly string[]).includes(v.slice(2)) : /^e:[^\p{C}<>&"']{1,8}$/u.test(v)), 'Ungültiges Symbol')
  .default('i:link');

const body = z
  .object({
    title: z.string().trim().min(1).max(40),
    url: z.string().trim().min(1).max(500),
    icon: iconSchema,
  })
  .strict();

interface LinkRow {
  id: string;
  title: string;
  url: string;
  icon: string;
  sort: number;
}

const dto = (r: LinkRow) => ({ id: r.id, title: r.title, url: r.url, icon: r.icon });

export async function linkRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const actor = (req: { user?: { email: string | null; sub: string } }): string | null => req.user?.email ?? req.user?.sub ?? null;
  const fail = (err: unknown) => {
    if (err instanceof ZodError) return { code: 400, error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { code: 400, error: err instanceof Error ? err.message : 'Ungültige Eingabe' };
  };

  app.get('/api/links', async () => ({
    links: (db.prepare('SELECT * FROM links ORDER BY sort, created_at').all() as unknown as LinkRow[]).map(dto),
  }));

  app.post('/api/links', async (req, reply) => {
    try {
      const b = body.parse(req.body);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n;
      if (count >= 50) return reply.code(400).send({ error: 'Es sind höchstens 50 Links möglich.' });
      const id = randomUUID();
      const url = parseLinkUrl(b.url);
      const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM links').get() as { n: number }).n;
      db.prepare('INSERT INTO links (id, title, url, icon, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, b.title, url, b.icon, sort, now());
      audit(db, actor(req), 'link.create', b.title);
      return reply.code(201).send({ link: dto(db.prepare('SELECT * FROM links WHERE id = ?').get(id) as unknown as LinkRow) });
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.patch('/api/links/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = body.parse(req.body);
      if (!db.prepare('SELECT 1 FROM links WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Link nicht gefunden' });
      db.prepare('UPDATE links SET title = ?, url = ?, icon = ? WHERE id = ?').run(b.title, parseLinkUrl(b.url), b.icon, id);
      audit(db, actor(req), 'link.update', b.title);
      return { link: dto(db.prepare('SELECT * FROM links WHERE id = ?').get(id) as unknown as LinkRow) };
    } catch (err) {
      const f = fail(err);
      return reply.code(f.code).send({ error: f.error });
    }
  });

  app.delete('/api/links/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT title FROM links WHERE id = ?').get(id) as { title: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Link nicht gefunden' });
    db.prepare('DELETE FROM links WHERE id = ?').run(id);
    audit(db, actor(req), 'link.delete', row.title);
    return { ok: true };
  });
}
