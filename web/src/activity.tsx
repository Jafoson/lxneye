import { useCallback, useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { ChecksBadge } from './checks';
import type { ActivityEvent, ActivityGroup } from './types';
import { ago } from './util';

type Filter = 'open' | 'merged' | 'closed' | 'all';

const EVENT: Record<ActivityEvent['type'], { label: string; cls: string }> = {
  opened: { label: 'Erstellt', cls: 'neutral' },
  checks_passed: { label: 'Prüfungen bestanden', cls: 'ok' },
  checks_failed: { label: 'Prüfungen fehlgeschlagen', cls: 'danger' },
  commit_pushed: { label: 'Branch geändert', cls: 'warn' },
  merged: { label: 'Gemergt', cls: 'ok' },
  closed: { label: 'Geschlossen', cls: 'neutral' },
};

function statusBadge(g: ActivityGroup): { text: string; cls: string } {
  const prefix = g.kind === 'rollback' ? 'Rollback ' : '';
  const pr = g.prNumber ? `PR #${g.prNumber}` : 'Commit';
  switch (g.status) {
    case 'open':
      return { text: `${prefix}${pr} offen`, cls: 'info' };
    case 'merged':
      return { text: `${prefix}${pr} gemergt`, cls: 'ok' };
    case 'closed':
      return { text: `${prefix}${pr} geschlossen`, cls: 'neutral' };
    case 'committed':
      return { text: `${prefix}Commit erstellt`, cls: 'ok' };
    case 'reverted':
      return { text: `${prefix}${pr} zurückgenommen`, cls: 'neutral' };
    default:
      return { text: 'fehlgeschlagen', cls: 'danger' };
  }
}

const matches = (g: ActivityGroup, f: Filter): boolean =>
  f === 'all' ? true : f === 'open' ? g.status === 'open' : f === 'merged' ? g.status === 'merged' || g.status === 'committed' : g.status === 'closed' || g.status === 'reverted';

export function ActivityPage(props: { onChanged: () => void; onNotify: (m: string) => void; onSeen: () => void; onGotoSettings: () => void }) {
  const [groups, setGroups] = useState<ActivityGroup[] | null>(null);
  const [check, setCheck] = useState<{ lastAt: number | null; nextAt: number; intervalMin: number } | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ groups: ActivityGroup[]; check: { lastAt: number | null; nextAt: number; intervalMin: number } }>('GET', '/api/activity');
      setGroups(r.groups);
      setCheck(r.check);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(t);
  }, [load]);

  // Beim ersten Laden: gibt es offene Pull Requests, zeige diese, sonst alles
  useEffect(() => {
    if (groups && filter === null) setFilter(groups.some((g) => g.status === 'open') ? 'open' : 'all');
  }, [groups, filter]);

  async function checkNow() {
    setBusy('check');
    try {
      const r = await api<{ checked: number; events: number }>('POST', '/api/activity/check');
      props.onNotify(r.checked === 0 ? 'Keine offenen Pull Requests zu prüfen.' : r.events > 0 ? `${r.events} Änderung${r.events === 1 ? '' : 'en'} gefunden.` : 'Keine Änderungen seit der letzten Prüfung.');
      await load();
      props.onChanged();
    } catch (e) {
      props.onNotify((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function markSeen(groupId?: string) {
    await api('POST', '/api/activity/seen', groupId ? { groupId } : {}).catch(() => undefined);
    await load();
    props.onSeen();
  }

  async function rollback(g: ActivityGroup) {
    setBusy(g.groupId);
    try {
      const r = await api<{ rollback: unknown }>('POST', `/api/updates/${g.updateId}/rollback`);
      props.onNotify(r.rollback ? 'Rollback eingereicht.' : 'Pull Request geschlossen.');
      await load();
      props.onChanged();
    } catch (e) {
      props.onNotify((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const f = filter ?? 'all';
  const shown = (groups ?? []).filter((g) => matches(g, f));
  const unseenTotal = (groups ?? []).reduce((n, g) => n + g.unseen, 0);
  const count = (x: Filter) => (groups ?? []).filter((g) => matches(g, x)).length;

  return (
    <div class="settings">
      <div class="row-flex" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 300px' }}>
          <h1 style={{ fontSize: '22px' }}>Pull Requests</h1>
          <p class="hint">
            Alles, was lxnEye in deine Repositories geschrieben hat, mit aktuellem Stand. lxnEye prüft offene Pull Requests{check ? ` alle ${check.intervalMin} Min.` : ''} von selbst und meldet Änderungen.{' '}
            <a href="#/einstellungen/scans" onClick={props.onGotoSettings}>Intervall ändern</a>
          </p>
          {check && (
            <p class="hint">
              Zuletzt geprüft: {check.lastAt ? ago(check.lastAt) : 'noch nicht'}
              {check.nextAt > Date.now() ? ` · nächste Prüfung in etwa ${Math.max(1, Math.round((check.nextAt - Date.now()) / 60_000))} Min.` : ''}
            </p>
          )}
        </div>
        <div class="actions">
          {unseenTotal > 0 && <button class="btn" onClick={() => markSeen()}>Alles als gelesen markieren</button>}
          <button class="btn primary" disabled={busy === 'check'} onClick={checkNow}>{busy === 'check' ? 'Prüfe …' : 'Jetzt prüfen'}</button>
        </div>
      </div>

      <div class="seg" role="group" aria-label="Filter" style={{ alignSelf: 'flex-start' }}>
        {([['open', 'Offen'], ['merged', 'Gemergt'], ['closed', 'Geschlossen'], ['all', 'Alle']] as [Filter, string][]).map(([id, label]) => (
          <button key={id} aria-pressed={f === id} onClick={() => setFilter(id)}>
            {label} ({count(id)})
          </button>
        ))}
      </div>

      {error && <p class="box danger">{error}</p>}
      {!groups && !error && <p class="hint">Lade …</p>}
      {groups && shown.length === 0 && (
        <div class="card empty">{groups.length === 0 ? 'Noch keine Updates. Sobald du in der Übersicht ein Update auslöst, erscheint es hier mit seinem Stand.' : 'Keine Einträge für diesen Filter.'}</div>
      )}

      {shown.map((g) => {
        const st = statusBadge(g);
        const title = g.changes.length === 1 ? `${g.changes[0]?.name} ${g.changes[0]?.from} → ${g.changes[0]?.to}` : `${g.changes.length} Updates`;
        return (
          <section class="card pr" key={g.groupId} aria-label={title}>
            <div class="row-flex" style={{ gap: '8px 12px', alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <h2 style={{ fontSize: '16px', overflowWrap: 'anywhere' }}>
                  {g.unseen > 0 && <span class="dot" role="img" aria-label="Neue Änderungen" title="Neue Änderungen" />}
                  {title}
                </h2>
                <p class="hint">
                  {g.sourceName} · {ago(g.createdAt)}{g.actor ? ` · ${g.actor}` : ''} · {g.mode === 'pr' ? 'Pull Request' : 'Direkt-Commit'}
                </p>
              </div>
              <span class={`badge ${st.cls}`} style={{ fontSize: '13px', padding: '4px 10px' }}>{st.text}</span>
              {g.status === 'open' && g.checks && <ChecksBadge status={{ state: 'open', checks: g.checks, total: 0, failed: g.checksFailed, running: 0 }} />}
            </div>

            <div class="box">
              {g.changes.map((c) => (
                <div key={`${c.name}${c.from}${c.to}`} class="loc">
                  <strong>{c.name}</strong>
                  <span class="mono">{c.from} → {c.to}</span>
                  <span class="hint mono" style={{ fontSize: '12px' }}>{c.files.join(', ')}</span>
                </div>
              ))}
            </div>

            <ol class="timeline" aria-label="Verlauf">
              {g.events.map((e) => (
                <li key={e.id} class={e.seen ? '' : 'new'}>
                  <span class={`badge ${EVENT[e.type]?.cls ?? 'neutral'}`}>{EVENT[e.type]?.label ?? e.type}</span>
                  <span>{e.detail}</span>
                  <span class="hint">{ago(e.ts)}</span>
                </li>
              ))}
            </ol>

            <div class="actions">
              {g.prUrl && <a class="btn small" href={g.prUrl} target="_blank" rel="noopener noreferrer">Pull Request öffnen ↗</a>}
              {g.unseen > 0 && <button class="btn small" onClick={() => markSeen(g.groupId)}>Als gelesen markieren</button>}
              {g.canRollback && <button class="btn small" disabled={busy === g.groupId} onClick={() => rollback(g)}>Rollback</button>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
