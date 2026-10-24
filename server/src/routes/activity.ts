import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { Ctx, UpdateRow } from '../ctx.js';
import { audit } from '../db.js';
import { getSchedule, runScanAll, runWatch, SCAN_INTERVALS, saveSchedule, scheduleStatus, WATCH_INTERVALS } from '../scheduler.js';

interface EventRow {
  id: number;
  group_id: string;
  source_id: string;
  ts: number;
  type: string;
  detail: string | null;
  seen: number;
}

/** Fasst die Zeilen eines Updates (pro Datei und Änderung eine) zu einem Pull Request bzw. Commit zusammen. */
function groups(ctx: Ctx, limit = 100) {
  const { db } = ctx;
  const rows = db.prepare('SELECT * FROM updates ORDER BY created_at DESC LIMIT 600').all() as unknown as UpdateRow[];
  const byGroup = new Map<string, UpdateRow[]>();
  for (const r of rows) {
    const k = r.group_id ?? r.id;
    byGroup.set(k, [...(byGroup.get(k) ?? []), r]);
  }
  const ids = [...byGroup.keys()].slice(0, limit);
  const sources = new Map((db.prepare('SELECT id, name FROM sources').all() as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const events = new Map<string, EventRow[]>();
  if (ids.length > 0) {
    const ev = db.prepare(`SELECT * FROM update_events WHERE group_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC, id DESC`).all(...ids) as unknown as EventRow[];
    for (const e of ev) events.set(e.group_id, [...(events.get(e.group_id) ?? []), e]);
  }
  const itemName = (id: string): string | null => (db.prepare('SELECT name FROM items WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null;

  return ids.map((gid) => {
    const g = byGroup.get(gid) as UpdateRow[];
    const first = g[0] as UpdateRow;
    const changes = new Map<string, { name: string; from: string; to: string; files: string[] }>();
    for (const r of g) {
      const name = r.name ?? itemName(r.item_id) ?? 'Eintrag';
      const k = `${name}|${r.from_version}|${r.to_version}`;
      const c = changes.get(k) ?? { name, from: r.from_version, to: r.to_version, files: [] };
      if (!c.files.includes(r.file)) c.files.push(r.file);
      changes.set(k, c);
    }
    const status = g.every((r) => r.status === 'reverted') ? 'reverted' : first.status;
    const evs = events.get(gid) ?? [];
    return {
      groupId: gid,
      updateId: first.id,
      kind: first.kind,
      mode: first.mode,
      status,
      prNumber: first.pr_number,
      prUrl: first.pr_url,
      sourceId: first.target_source_id,
      sourceName: sources.get(first.target_source_id) ?? 'unbekannt',
      createdAt: first.created_at,
      actor: first.actor,
      checks: first.checks_state ?? null,
      checksFailed: first.checks_failed ? (JSON.parse(first.checks_failed) as string[]) : [],
      lastChecked: first.last_checked,
      canRollback: first.kind === 'update' && ['open', 'merged', 'committed'].includes(status),
      changes: [...changes.values()],
      events: evs.map((e) => ({ id: e.id, ts: e.ts, type: e.type, detail: e.detail, seen: !!e.seen })),
      unseen: evs.filter((e) => !e.seen).length,
    };
  });
}

export async function activityRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const actor = (req: { user?: { email: string | null; sub: string } }): string | null => req.user?.email ?? req.user?.sub ?? null;

  app.get('/api/activity', async () => {
    const g = groups(ctx);
    return { groups: g, check: { lastAt: scheduleStatus(ctx).lastWatchAt, nextAt: scheduleStatus(ctx).nextWatchAt, intervalMin: getSchedule(ctx).watchIntervalMin } };
  });

  /** Kurzfassung für das Abzeichen in der Seitenleiste und für Hinweise auf neue Ereignisse. */
  app.get('/api/activity/summary', async () => {
    const open = (db.prepare("SELECT COUNT(DISTINCT COALESCE(group_id, id)) AS n FROM updates WHERE status = 'open'").get() as { n: number }).n;
    const unseenRows = db.prepare('SELECT * FROM update_events WHERE seen = 0 ORDER BY ts DESC, id DESC LIMIT 20').all() as unknown as EventRow[];
    const unseen = (db.prepare('SELECT COUNT(*) AS n FROM update_events WHERE seen = 0').get() as { n: number }).n;
    const info = (gid: string) => {
      const r = db.prepare('SELECT name, pr_number, kind FROM updates WHERE group_id = ? OR id = ? LIMIT 1').get(gid, gid) as { name: string | null; pr_number: number | null; kind: string } | undefined;
      return { name: r?.name ?? null, prNumber: r?.pr_number ?? null };
    };
    return { open, unseen, recent: unseenRows.map((e) => ({ id: e.id, ts: e.ts, type: e.type, detail: e.detail, ...info(e.group_id) })) };
  });

  app.post('/api/activity/seen', async (req, reply) => {
    try {
      const b = z.object({ groupId: z.string().max(60).optional() }).strict().parse(req.body ?? {});
      if (b.groupId) db.prepare('UPDATE update_events SET seen = 1 WHERE group_id = ?').run(b.groupId);
      else db.prepare('UPDATE update_events SET seen = 1').run();
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof ZodError ? 'Ungültige Eingabe' : 'Fehler' });
    }
  });

  /** Offene Pull Requests sofort prüfen, ohne auf den nächsten Durchlauf zu warten. */
  app.post('/api/activity/check', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async () => {
    const r = await runWatch(ctx);
    return { ...r, lastAt: scheduleStatus(ctx).lastWatchAt };
  });

  // --- Zeitplan für automatische Scans ---
  app.get('/api/settings/schedule', async () => ({ ...scheduleStatus(ctx), options: { scan: SCAN_INTERVALS, watch: WATCH_INTERVALS } }));

  app.put('/api/settings/schedule', async (req, reply) => {
    try {
      const b = z
        .object({
          enabled: z.boolean(),
          scanIntervalMin: z.number().int().refine((n) => SCAN_INTERVALS.includes(n), 'Ungültiges Intervall'),
          watchIntervalMin: z.number().int().refine((n) => WATCH_INTERVALS.includes(n), 'Ungültiges Intervall'),
        })
        .strict()
        .parse(req.body);
      saveSchedule(ctx, b);
      audit(db, actor(req), 'settings.schedule', `${b.enabled ? `alle ${b.scanIntervalMin} Min.` : 'aus'}, Pull Requests alle ${b.watchIntervalMin} Min.`);
      return { ...scheduleStatus(ctx), options: { scan: SCAN_INTERVALS, watch: WATCH_INTERVALS } };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'Fehler' });
    }
  });

  app.post('/api/scan-all', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (scheduleStatus(ctx).running) return reply.code(409).send({ error: 'Es läuft schon ein Scan.' });
    void runScanAll(ctx, 'manuell', actor(req)).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });
}
