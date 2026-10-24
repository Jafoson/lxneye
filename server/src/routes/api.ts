import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { AiKeyError, aiSettingsSchema, clearAi, DEFAULT_MODEL, listModels, loadAi, pingModel, saveAi } from '../ai.js';
import type { Ctx, ItemRow, SourceRow, UpdateRow } from '../ctx.js';
import { encrypt, randomToken, sha256Hex } from '../crypto.js';
import { audit, now, setSetting } from '../db.js';
import { InputError, parseGithubUrl } from '../git/github.js';
import { prMatches, renovateBlock, type RenovateConfig, type RenovatePr } from '../git/renovate.js';
import type { Cve } from '../scan/osv.js';
import { getSource, scanSource } from '../scan/run.js';
import { aiSummary, buildAutoSummary } from '../summary.js';
import { checkBatch, rollbackUpdate, runBatch, startUpdate, UpdateError, updateMode } from '../updates.js';

const nameSchema = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._/@:-]+$/u, 'Erlaubt sind Buchstaben, Zahlen und . _ - / @ :');

const createSource = z
  .object({
    kind: z.enum(['git', 'server', 'kubernetes']),
    name: nameSchema,
    url: z.string().trim().max(300).optional(),
    token: z.string().trim().max(500).optional(),
    scanMode: z.enum(['standard', 'offer', 'ai']).default('offer'),
    linkedSourceId: z.string().uuid().optional(),
  })
  .strict();

const patchSource = z
  .object({
    name: nameSchema.optional(),
    url: z.string().trim().max(300).optional(),
    scanMode: z.enum(['standard', 'offer', 'ai']).optional(),
    linkedSourceId: z.string().uuid().nullable().optional(),
    token: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

function counts(ctx: Ctx, sourceId: string): { total: number; outdated: number; cve: number } {
  const rows = ctx.db.prepare('SELECT bump, cves FROM items WHERE source_id = ?').all(sourceId) as { bump: string; cves: string }[];
  return {
    total: rows.length,
    outdated: rows.filter((r) => r.bump !== '').length,
    cve: rows.filter((r) => r.bump !== '' && r.cves !== '[]').length,
  };
}

function sourceDto(ctx: Ctx, s: SourceRow) {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    url: s.url,
    scanMode: s.scan_mode,
    status: s.status,
    scanError: s.scan_error,
    scannedByAi: !!s.scanned_by_ai,
    linkedSourceId: s.linked_source_id,
    hasToken: !!s.credential_enc,
    lastScanAt: s.last_scan_at,
    meta: JSON.parse(s.meta) as Record<string, unknown>,
    counts: counts(ctx, s.id),
  };
}

/** Ältere Scans kennen nur das höchste Ziel. Dann wird daraus ein einzelnes Update-Ziel. */
function candidatesOf(i: ItemRow): { level: string; version: string }[] {
  const c = JSON.parse(i.candidates || '[]') as { level: string; version: string }[];
  return c.length > 0 || !i.latest || i.bump === '' ? c : [{ level: i.bump, version: i.latest }];
}

/** Eine Zeile in der Oberfläche = dieselbe Version desselben Pakets/Images, auch wenn sie an mehreren Stellen steht. */
function groupDto(ctx: Ctx, members: ItemRow[], src: SourceRow, upd: UpdateRow | undefined, ruleSrc: SourceRow | undefined) {
  const rep = members[0] as ItemRow;
  const renovateMeta = ruleSrc ? ((JSON.parse(ruleSrc.meta) as { renovate?: RenovateConfig & { prs?: RenovatePr[] } }).renovate ?? null) : null;
  const renovate: RenovateConfig | null = renovateMeta;
  let updatable = false;
  let hint: string | null = null;
  if (rep.bump !== '') {
    if (src.kind === 'git') {
      updatable = members.some((m) => !!m.locator);
      if (!updatable) hint = 'Von der KI erkannt: keine feste Stelle in einer Datei bekannt, daher kein automatisches Update.';
    } else {
      updatable = !!src.linked_source_id;
      if (!updatable) hint = 'Verknüpfe diese Quelle mit einem Git-Repository, um Updates per PR oder Commit auszulösen.';
    }
  }
  const servers = [...new Set(members.flatMap((m) => (m.server ? m.server.split(',') : [])))].sort();
  const cves = new Map<string, Cve>();
  for (const m of members) for (const c of JSON.parse(m.cves) as Cve[]) cves.set(c.id, c);
  return {
    id: rep.id,
    sourceId: rep.source_id,
    sourceName: src.name,
    name: rep.name,
    type: rep.type,
    ecosystem: rep.ecosystem,
    current: rep.current,
    latest: rep.latest,
    bump: rep.bump,
    candidates: candidatesOf(rep).map((c) => {
      const blocked = renovateBlock(renovate, rep.name, c.level as 'Patch' | 'Minor' | 'Major');
      return blocked ? { ...c, blocked } : c;
    }),
    renovatePrs: (renovateMeta?.prs ?? []).filter((p) => prMatches(p, rep.name)).map((p) => ({ number: p.number, title: p.title, url: p.url })),
    cves: [...cves.values()],
    aiFound: members.some((m) => !!m.ai_found),
    servers,
    locations: members.map((m) => ({ id: m.id, file: m.file, servers: m.server ? m.server.split(',') : [] })),
    updatable,
    updateHint: hint,
    update: upd
      ? { id: upd.id, status: upd.status, mode: upd.mode, kind: upd.kind, prNumber: upd.pr_number, prUrl: upd.pr_url, toVersion: upd.to_version, createdAt: upd.created_at }
      : null,
  };
}

function handleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AiKeyError) return reply.code(400).send({ error: err.message });
  if (err instanceof InputError) return reply.code(400).send({ error: err.message });
  if (err instanceof UpdateError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (err instanceof Error) return reply.code(502).send({ error: err.message });
  return reply.code(500).send({ error: 'Interner Fehler' });
}

export async function apiRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const actor = (req: { user?: { email: string | null; sub: string } }): string | null => req.user?.email ?? req.user?.sub ?? null;

  app.get('/api/sources', async () => {
    const rows = db.prepare('SELECT * FROM sources ORDER BY created_at').all() as unknown as SourceRow[];
    return { sources: rows.map((s) => sourceDto(ctx, s)) };
  });

  app.post('/api/sources', async (req, reply) => {
    try {
      const b = createSource.parse(req.body);
      let url: string | null = null;
      if (b.kind === 'git') {
        if (!b.url) return reply.code(400).send({ error: 'Für ein Git-Repository wird die URL benötigt.' });
        const r = parseGithubUrl(b.url);
        url = `https://github.com/${r.owner}/${r.repo}`;
      } else if (b.url) {
        url = b.url.slice(0, 200);
      }
      if (b.linkedSourceId) {
        const l = getSource(ctx, b.linkedSourceId);
        if (!l || l.kind !== 'git') return reply.code(400).send({ error: 'Verknüpfen kann man nur mit einem Git-Repository.' });
      }
      const id = randomUUID();
      const agentToken = b.kind === 'git' ? null : `lxe_${randomToken(32)}`;
      try {
        db.prepare(
          `INSERT INTO sources (id, kind, name, url, scan_mode, credential_enc, agent_token_hash, linked_source_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, b.kind, b.name, url, b.scanMode, b.token ? encrypt(ctx.key, b.token) : null,
          agentToken ? sha256Hex(agentToken) : null, b.linkedSourceId ?? null, 'pending', now(),
        );
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message)) return reply.code(409).send({ error: 'Eine Quelle mit diesem Namen existiert bereits.' });
        throw err;
      }
      audit(db, actor(req), 'source.create', `${b.kind}: ${b.name}`);
      if (b.kind === 'git') void scanSource(ctx, id, { actor: actor(req) });
      return reply.code(201).send({ source: sourceDto(ctx, getSource(ctx, id) as SourceRow), agentToken });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.patch('/api/sources/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = patchSource.parse(req.body);
      const s = getSource(ctx, id);
      if (!s) return reply.code(404).send({ error: 'Quelle nicht gefunden' });
      if (b.name && b.name !== s.name) {
        try {
          db.prepare('UPDATE sources SET name = ? WHERE id = ?').run(b.name, id);
        } catch (err) {
          if (err instanceof Error && /UNIQUE/i.test(err.message)) return reply.code(409).send({ error: 'Eine Quelle mit diesem Namen existiert bereits.' });
          throw err;
        }
      }
      let rescan = false;
      if (b.url !== undefined && b.url !== s.url) {
        if (s.kind !== 'git') return reply.code(400).send({ error: 'Nur Git-Repositories haben eine URL.' });
        const r = parseGithubUrl(b.url);
        db.prepare("UPDATE sources SET url = ?, status = 'pending', scan_error = NULL WHERE id = ?").run(`https://github.com/${r.owner}/${r.repo}`, id);
        rescan = true;
      }
      if (b.scanMode) db.prepare('UPDATE sources SET scan_mode = ? WHERE id = ?').run(b.scanMode, id);
      if (b.linkedSourceId !== undefined) {
        if (b.linkedSourceId) {
          const l = getSource(ctx, b.linkedSourceId);
          if (!l || l.kind !== 'git' || l.id === id) return reply.code(400).send({ error: 'Verknüpfen kann man nur mit einem anderen Git-Repository.' });
        }
        db.prepare('UPDATE sources SET linked_source_id = ? WHERE id = ?').run(b.linkedSourceId, id);
      }
      if (b.token !== undefined) {
        db.prepare('UPDATE sources SET credential_enc = ? WHERE id = ?').run(b.token ? encrypt(ctx.key, b.token) : null, id);
        rescan = rescan || (!!b.token && s.kind === 'git');
      }
      audit(db, actor(req), 'source.update', s.name);
      if (rescan) void scanSource(ctx, id, { actor: actor(req) });
      return { source: sourceDto(ctx, getSource(ctx, id) as SourceRow) };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.delete('/api/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = getSource(ctx, id);
    if (!s) return reply.code(404).send({ error: 'Quelle nicht gefunden' });
    db.prepare('UPDATE sources SET linked_source_id = NULL WHERE linked_source_id = ?').run(id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    audit(db, actor(req), 'source.delete', s.name);
    return { ok: true };
  });

  app.post('/api/sources/:id/scan', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ ai: z.boolean().optional() }).strict().parse(req.body ?? {});
      const s = getSource(ctx, id);
      if (!s) return reply.code(404).send({ error: 'Quelle nicht gefunden' });
      if (s.kind !== 'git') return reply.code(400).send({ error: 'Server und Kubernetes melden sich selbst über den Agent.' });
      if (b.ai && !loadAi(ctx)) return reply.code(400).send({ error: 'Keine KI verbunden.' });
      void scanSource(ctx, id, { ai: b.ai, actor: actor(req) });
      return reply.code(202).send({ ok: true });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get('/api/items', async () => {
    const items = db.prepare('SELECT * FROM items ORDER BY name, file').all() as unknown as ItemRow[];
    const sources = new Map((db.prepare('SELECT * FROM sources').all() as unknown as SourceRow[]).map((s) => [s.id, s]));
    const updates = new Map<string, UpdateRow>();
    for (const u of db.prepare('SELECT * FROM updates ORDER BY created_at').all() as unknown as UpdateRow[]) updates.set(u.item_id, u);

    const groups = new Map<string, ItemRow[]>();
    for (const i of items) {
      const k = `${i.source_id}|${i.ecosystem}|${i.name}|${i.current}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    return {
      items: [...groups.values()].flatMap((members) => {
        members.sort((a, b) => a.id.localeCompare(b.id));
        const src = sources.get((members[0] as ItemRow).source_id);
        if (!src) return [];
        const upd = members
          .map((m) => updates.get(m.id))
          .filter((u): u is UpdateRow => !!u)
          .sort((a, b) => b.created_at - a.created_at)[0];
        // Regeln kommen aus dem Git-Repository: bei Server/Kubernetes aus dem verknüpften Repository (GitOps)
        const ruleSrc = src.kind === 'git' ? src : src.linked_source_id ? sources.get(src.linked_source_id) : undefined;
        return [groupDto(ctx, members, src, upd, ruleSrc)];
      }),
    };
  });

  /** Wählt Zielversion (muss eine der Kandidaten sein) und liefert eine Sicht auf den Eintrag für Zusammenfassungen. */
  const viewFor = (item: ItemRow, to: string | undefined): ItemRow => {
    const cands = candidatesOf(item) as { level: ItemRow['bump']; version: string }[];
    const pick = to ? cands.find((c) => c.version === to) : cands[cands.length - 1];
    if (to && !pick) throw new UpdateError('Diese Zielversion steht nicht zur Verfügung.');
    return pick ? { ...item, latest: pick.version, bump: pick.level } : item;
  };
  const toQuery = z.object({ to: z.string().max(100).optional() });

  app.get('/api/items/:id/summary', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { to } = toQuery.parse(req.query);
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
      if (!item) return reply.code(404).send({ error: 'Eintrag nicht gefunden' });
      const view = viewFor(item, to);
      const auto = await buildAutoSummary(ctx, view);
      const cached = view.latest
        ? (db.prepare('SELECT content, provider FROM summaries WHERE item_id = ? AND latest = ?').get(id, view.latest) as { content: string; provider: string } | undefined)
        : undefined;
      return {
        auto: { recommendation: auto.recommendation, sections: auto.sections, excerpt: auto.excerpt, sources: auto.sources },
        ai: cached ? { sections: JSON.parse(cached.content), provider: cached.provider } : null,
        aiConnected: !!loadAi(ctx),
      };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post('/api/items/:id/summary/ai', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { to } = toQuery.parse(req.query);
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
      if (!item) return reply.code(404).send({ error: 'Eintrag nicht gefunden' });
      return await aiSummary(ctx, viewFor(item, to));
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post('/api/items/:id/update', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ to: z.string().max(100).optional() }).strict().parse(req.body ?? {});
      const u = await startUpdate(ctx, id, b.to, actor(req));
      return { update: { id: u.id, status: u.status, mode: u.mode, prNumber: u.pr_number, prUrl: u.pr_url, toVersion: u.to_version } };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  const batchBody = z
    .object({
      items: z.array(z.object({ id: z.string().uuid(), to: z.string().max(100).optional() }).strict()).min(1).max(100),
      bundle: z.boolean().optional(),
    })
    .strict();

  /** Hinweise aus der Renovate-Konfiguration des Repositories (blockierte Stufe, schon offener Renovate-PR). */
  const renovateWarnings = (itemId: string, level: string | null): string[] => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
    if (!item) return [];
    const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(item.source_id) as SourceRow | undefined;
    const ruleId = src?.kind === 'git' ? src.id : src?.linked_source_id;
    const ruleSrc = ruleId ? (db.prepare('SELECT * FROM sources WHERE id = ?').get(ruleId) as SourceRow | undefined) : undefined;
    const meta = ruleSrc ? ((JSON.parse(ruleSrc.meta) as { renovate?: RenovateConfig & { prs?: RenovatePr[] } }).renovate ?? null) : null;
    if (!meta) return [];
    const out: string[] = [];
    const blocked = level ? renovateBlock(meta, item.name, level as 'Patch' | 'Minor' | 'Major') : null;
    if (blocked) out.push(blocked);
    const prs = (meta.prs ?? []).filter((p) => prMatches(p, item.name));
    if (prs.length > 0) out.push(`Renovate hat dafür schon einen offenen Pull Request (${prs.map((p) => `#${p.number}`).join(', ')}).`);
    return out;
  };

  /** Prüft eine Sammel-Auswahl, ohne etwas zu ändern. */
  app.post('/api/updates/check', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = batchBody.parse(req.body);
      const r = await checkBatch(ctx, b.items);
      return { ...r, results: r.results.map((x) => ({ ...x, warnings: x.status === 'ok' ? renovateWarnings(x.id, x.level) : [] })), mode: updateMode(ctx) };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /** Führt eine Sammel-Auswahl aus, gebündelt in einem Pull Request je Repository oder einzeln. */
  app.post('/api/updates/batch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = batchBody.parse(req.body);
      return { results: await runBatch(ctx, b.items, b.bundle ?? true, actor(req)), mode: updateMode(ctx) };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post('/api/updates/:id/rollback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const u = await rollbackUpdate(ctx, id, actor(req));
      return { ok: true, rollback: u ? { status: u.status, mode: u.mode, prUrl: u.pr_url } : null };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get('/api/settings', async () => {
    const ai = loadAi(ctx);
    return { updateMode: updateMode(ctx), ai: ai ? { connected: true, provider: ai.provider, model: ai.model } : { connected: false } };
  });

  app.put('/api/settings/update-mode', async (req, reply) => {
    try {
      const b = z.object({ mode: z.enum(['pr', 'commit']) }).strict().parse(req.body);
      setSetting(db, 'updateMode', b.mode);
      audit(db, actor(req), 'settings.update-mode', b.mode);
      return { updateMode: b.mode };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  const aiTest = z.object({ provider: z.enum(['openai', 'gemini']), apiKey: z.string().min(8).max(500).optional() }).strict();
  const aiSave = z
    .object({
      provider: z.enum(['openai', 'gemini']),
      apiKey: z.string().min(8).max(500).optional(),
      model: aiSettingsSchema.shape.model,
    })
    .strict();

  /** Nimmt den neu eingegebenen Key, sonst den gespeicherten (nur beim selben Anbieter). */
  const keyFor = (provider: 'openai' | 'gemini', given: string | undefined): string => {
    if (given) return given;
    const stored = loadAi(ctx);
    if (stored && stored.provider === provider) return stored.apiKey;
    throw new AiKeyError('Bitte einen API-Key eingeben.');
  };

  app.post('/api/settings/ai/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = aiTest.parse(req.body);
      const models = await listModels(b.provider, keyFor(b.provider, b.apiKey));
      return { ok: true, models, defaultModel: DEFAULT_MODEL[b.provider] };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post('/api/settings/ai/ping', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = aiSave.parse(req.body);
      const apiKey = keyFor(b.provider, b.apiKey);
      return { ok: true, ...(await pingModel({ provider: b.provider, apiKey, model: b.model })) };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.put('/api/settings/ai', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const b = aiSave.parse(req.body);
      const apiKey = keyFor(b.provider, b.apiKey);
      const models = await listModels(b.provider, apiKey); // nur speichern, was nachweislich funktioniert
      if (b.model && !models.includes(b.model)) throw new AiKeyError(`Das Modell "${b.model}" steht mit diesem Key nicht zur Verfügung.`);
      saveAi(ctx, { provider: b.provider, apiKey, model: b.model });
      audit(db, actor(req), 'settings.ai', `verbunden: ${b.provider}`);
      return { ai: { connected: true, provider: b.provider, model: b.model } };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.delete('/api/settings/ai', async (req) => {
    clearAi(ctx);
    audit(db, actor(req), 'settings.ai', 'getrennt');
    return { ai: { connected: false } };
  });
}
