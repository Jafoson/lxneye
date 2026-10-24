import type { Item, Source } from './types';

export function ago(ts: number | null): string {
  if (!ts) return 'noch nie';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  return `vor ${Math.floor(s / 86400)} Tg.`;
}

export const KIND_LABEL: Record<Source['kind'], string> = {
  git: 'Git-Repository',
  server: 'Server',
  kubernetes: 'Kubernetes',
};

export const BUMP_TIP: Record<string, string> = {
  Major: 'Major: große neue Version. Kann Änderungen enthalten, die Bestehendes brechen. Vor dem Update prüfen. Klicken für Details.',
  Minor: 'Minor: neue Funktionen, die abwärtskompatibel sein sollten. Meist unkritisch. Klicken für Details.',
  Patch: 'Patch: reine Fehlerbehebungen und kleine Korrekturen. Sehr sicher. Klicken für Details.',
};

export const BUMP_EXPLAIN: Record<string, string> = {
  Major: 'Eine neue Hauptversion. Sie kann Änderungen enthalten, die bestehende Konfigurationen oder Daten betreffen. Vor dem Update die Release Notes lesen und ein Backup bereithalten.',
  Minor: 'Eine Version mit neuen Funktionen, die mit der bisherigen kompatibel sein sollte. Meist ohne Aufwand einzuspielen.',
  Patch: 'Eine kleine Version, die nur Fehler behebt oder Sicherheitslücken schließt. Sehr geringes Risiko.',
};

/** Ein Update ist "in Arbeit", solange es offen/gemerged/committed ist, aber die neue Version noch nicht erkannt wurde. */
export function pendingLabel(it: Item): string | null {
  const u = it.update;
  if (!u || it.bump === '') return null;
  if (u.kind === 'rollback') return u.status === 'open' ? `Rollback-PR #${u.prNumber} offen` : null;
  if (u.status === 'open') return `PR #${u.prNumber} offen`;
  if (u.status === 'merged') return `PR #${u.prNumber} gemerged`;
  if (u.status === 'committed') return 'Commit erstellt';
  return null;
}

export const canRollback = (it: Item): boolean =>
  !!it.update && it.update.kind === 'update' && ['open', 'merged', 'committed'].includes(it.update.status) && it.bump !== '';

export const sevRank = (it: Item): number => (it.bump === '' ? 0 : it.cves.length > 0 ? 3 : pendingLabel(it) ? 1 : 2);
