import type { Ctx } from './ctx.js';
import { audit, getSetting, now, setSetting } from './db.js';
import { scanAll, scanSource } from './scan/run.js';
import { checkOpenUpdates } from './watch.js';

export interface Schedule {
  /** Automatische Scans aller Git-Quellen */
  enabled: boolean;
  scanIntervalMin: number;
  /** Wie oft offene Pull Requests auf Änderungen geprüft werden */
  watchIntervalMin: number;
}

export const SCAN_INTERVALS = [15, 30, 60, 180, 360, 720, 1440, 10080];
export const WATCH_INTERVALS = [1, 2, 5, 10, 15, 30, 60];

export function getSchedule(ctx: Ctx): Schedule {
  const def: Schedule = { enabled: ctx.cfg.scanIntervalMs > 0, scanIntervalMin: ctx.cfg.scanIntervalMs > 0 ? Math.round(ctx.cfg.scanIntervalMs / 60_000) : 360, watchIntervalMin: 5 };
  try {
    const raw = getSetting(ctx.db, 'schedule');
    return raw ? { ...def, ...(JSON.parse(raw) as Partial<Schedule>) } : def;
  } catch {
    return def;
  }
}

export function saveSchedule(ctx: Ctx, s: Schedule): void {
  setSetting(ctx.db, 'schedule', JSON.stringify(s));
}

interface LastScan {
  at: number;
  durationMs: number;
  sources: number;
  failed: number;
  trigger: 'zeitplan' | 'manuell';
}

const readJson = <T>(ctx: Ctx, key: string): T | null => {
  try {
    const raw = getSetting(ctx.db, key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

/** Ist seit `last` mehr als `intervalMin` vergangen? Ohne letzten Lauf: ja. */
export const isDue = (last: number | null, intervalMin: number, at: number): boolean => last === null || at - last >= intervalMin * 60_000;

export function scheduleStatus(ctx: Ctx) {
  const s = getSchedule(ctx);
  const last = readJson<LastScan>(ctx, 'scan.last');
  const watch = readJson<{ at: number }>(ctx, 'watch.last');
  return {
    ...s,
    running: scanning,
    lastScan: last,
    nextScanAt: s.enabled ? (last ? last.at + s.scanIntervalMin * 60_000 : now()) : null,
    lastWatchAt: watch?.at ?? null,
    nextWatchAt: watch ? watch.at + s.watchIntervalMin * 60_000 : now(),
  };
}

let scanning = false;

/** Scannt alle Git-Quellen nacheinander und merkt sich das Ergebnis. */
export async function runScanAll(ctx: Ctx, trigger: LastScan['trigger'], actor: string | null = null): Promise<void> {
  if (scanning) return;
  scanning = true;
  const started = now();
  try {
    await scanAll(ctx);
    const rows = ctx.db.prepare("SELECT status FROM sources WHERE kind = 'git'").all() as { status: string }[];
    const result: LastScan = { at: now(), durationMs: now() - started, sources: rows.length, failed: rows.filter((r) => r.status === 'failed').length, trigger };
    setSetting(ctx.db, 'scan.last', JSON.stringify(result));
    audit(ctx.db, actor, 'scan.all', `${trigger}: ${result.sources} Quellen, ${result.failed} mit Fehler`);
  } finally {
    scanning = false;
  }
}

let watching = false;

export async function runWatch(ctx: Ctx): Promise<{ checked: number; events: number }> {
  if (watching) return { checked: 0, events: 0 };
  watching = true;
  try {
    const r = await checkOpenUpdates(ctx, { onMerged: (id) => void scanSource(ctx, id).catch(() => undefined) });
    setSetting(ctx.db, 'watch.last', JSON.stringify({ at: now() }));
    return r;
  } finally {
    watching = false;
  }
}

/** Startet den Zeitplan: alle 30 Sekunden wird geprüft, ob ein Scan oder eine Pull-Request-Prüfung fällig ist. */
export function startScheduler(ctx: Ctx, log: { error: (o: object, m: string) => void }): { stop: () => void } {
  const tick = async (): Promise<void> => {
    const s = getSchedule(ctx);
    const t = now();
    const watch = readJson<{ at: number }>(ctx, 'watch.last');
    if (isDue(watch?.at ?? null, s.watchIntervalMin, t)) {
      await runWatch(ctx).catch((err) => log.error({ err }, 'Prüfung der Pull Requests fehlgeschlagen'));
    }
    const last = readJson<LastScan>(ctx, 'scan.last');
    if (s.enabled && isDue(last?.at ?? null, s.scanIntervalMin, t)) {
      await runScanAll(ctx, 'zeitplan').catch((err) => log.error({ err }, 'Geplanter Scan fehlgeschlagen'));
    }
  };
  const first = setTimeout(() => void tick(), 20_000); // nach dem Start kurz warten
  const timer = setInterval(() => void tick(), 30_000);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
