import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { AccountsPanel } from './accounts';
import type { Account, ScheduleStatus, Settings, Source } from './types';
import { ago, KIND_LABEL } from './util';

const STATUS: Record<Source['status'], { label: string; cls: string }> = {
  ok: { label: 'ok', cls: 'ok' },
  failed: { label: 'Fehler', cls: 'danger' },
  running: { label: 'Scan läuft', cls: 'info' },
  pending: { label: 'wartet', cls: 'neutral' },
};

function via(s: Source): { text: string; cls: string } {
  if (s.kind !== 'git') return { text: s.linkedSourceId ? 'Agent, Updates über Git' : 'Agent', cls: 'neutral' };
  if (s.accountName) return { text: `Konto ${s.accountName}`, cls: 'ok' };
  if (s.hasToken) return { text: 'eigener Token', cls: 'neutral' };
  return { text: 'ohne Token (nur öffentlich)', cls: 'neutral' };
}

function scanLabel(min: number): string {
  if (min < 60) return `${min} Minuten`;
  if (min === 60) return '1 Stunde';
  if (min < 1440) return `${min / 60} Stunden`;
  return min === 1440 ? 'Täglich' : min === 10080 ? 'Wöchentlich' : `${min / 1440} Tage`;
}
const watchLabel = (min: number): string => (min === 1 ? '1 Minute' : min === 60 ? '1 Stunde' : `${min} Minuten`);
const when = (ts: number | null): string => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');

/** Zeitplan: wie oft Quellen automatisch gescannt und offene Pull Requests geprüft werden. */
function ScheduleSection(props: { onNotify: (m: string) => void; onReload: () => Promise<void> }) {
  const [st, setSt] = useState<ScheduleStatus | null>(null);

  const load = () => api<ScheduleStatus>('GET', '/api/settings/schedule').then(setSt).catch((e: Error) => props.onNotify(e.message));
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), st?.running ? 3000 : 15000);
    return () => window.clearInterval(t);
  }, [st?.running]);

  const save = (patch: Partial<Pick<ScheduleStatus, 'enabled' | 'scanIntervalMin' | 'watchIntervalMin'>>) => {
    if (!st) return;
    const next = { enabled: st.enabled, scanIntervalMin: st.scanIntervalMin, watchIntervalMin: st.watchIntervalMin, ...patch };
    api<ScheduleStatus>('PUT', '/api/settings/schedule', next).then(setSt).catch((e: Error) => props.onNotify(e.message));
  };
  const scanNow = () =>
    api('POST', '/api/scan-all')
      .then(() => {
        props.onNotify('Scan aller Quellen gestartet.');
        void load();
      })
      .catch((e: Error) => props.onNotify(e.message));

  if (!st) return <p class="hint">Lade …</p>;
  return (
    <>
      <label class="row-flex" style={{ fontSize: '14px', fontWeight: 600 }}>
        <input type="checkbox" class="chk" checked={st.enabled} onChange={(e) => save({ enabled: (e.target as HTMLInputElement).checked })} />
        Quellen automatisch scannen
      </label>
      <div class="grid2">
        <label class="field">
          Scan-Intervall
          <select disabled={!st.enabled} value={st.scanIntervalMin} onChange={(e) => save({ scanIntervalMin: Number((e.target as HTMLSelectElement).value) })}>
            {st.options.scan.map((m) => <option key={m} value={m}>Alle {scanLabel(m)}{m >= 1440 ? '' : ''}</option>)}
          </select>
        </label>
        <label class="field">
          Offene Pull Requests prüfen
          <select value={st.watchIntervalMin} onChange={(e) => save({ watchIntervalMin: Number((e.target as HTMLSelectElement).value) })}>
            {st.options.watch.map((m) => <option key={m} value={m}>Alle {watchLabel(m)}</option>)}
          </select>
        </label>
      </div>
      <div class="box">
        <p>
          <strong>Letzter Scan:</strong>{' '}
          {st.lastScan ? `${when(st.lastScan.at)} (${st.lastScan.trigger}), ${st.lastScan.sources} Quellen, ${st.lastScan.failed > 0 ? `${st.lastScan.failed} mit Fehler` : 'alle ohne Fehler'}, ${Math.max(1, Math.round(st.lastScan.durationMs / 1000))} s` : 'noch keiner'}
        </p>
        <p>
          <strong>Nächster Scan:</strong> {st.running ? 'läuft gerade …' : st.enabled ? when(st.nextScanAt) : 'ausgeschaltet'}
        </p>
        <p>
          <strong>Pull Requests zuletzt geprüft:</strong> {when(st.lastWatchAt)}
        </p>
      </div>
      <div class="actions">
        <button class="btn primary" disabled={st.running} onClick={scanNow}>{st.running ? 'Scan läuft …' : 'Jetzt alle Quellen scannen'}</button>
      </div>
      <p class="hint">Nach einem Merge scannt lxnEye die betroffene Quelle automatisch neu, damit die neue Version sofort erscheint. Server und Kubernetes melden sich selbst über den Agent.</p>
    </>
  );
}

/** Einstellungsseite: Konten zuerst, danach alle Quellen, KI und Update-Modus. */
export function SettingsPage(props: {
  sources: Source[];
  settings: Settings;
  onReload: () => Promise<void>;
  onNotify: (m: string) => void;
  onPick: (a: Account) => void;
  onAddSource: () => void;
  onEditSource: (s: Source) => void;
  onDeleteSource: (s: Source) => void;
  onOpenAi: () => void;
}) {
  const { sources, settings } = props;
  const gitViaAccount = sources.filter((s) => s.kind === 'git' && s.accountId);
  const others = sources.filter((s) => !(s.kind === 'git' && s.accountId));

  const scan = (s: Source) =>
    api('POST', `/api/sources/${s.id}/scan`, {})
      .then(props.onReload)
      .catch((e: Error) => props.onNotify(e.message));

  const row = (s: Source) => {
    const v = via(s);
    return (
      <div class="srow" key={s.id}>
        <div class="srow-name">
          <strong>{s.name}</strong>
          <span class="hint">
            {KIND_LABEL[s.kind]}
            {s.provider && s.kind === 'git' ? ` · ${s.provider === 'gitlab' ? 'GitLab' : 'GitHub'}` : ''} · {s.kind === 'git' ? 'gescannt' : 'gemeldet'} {ago(s.lastScanAt)}
          </span>
        </div>
        <span class={`badge ${v.cls}`}>{v.text}</span>
        <span class={`badge ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
        <span class="hint srow-count">{s.counts.outdated} veraltet · {s.counts.total} gesamt</span>
        <div class="actions">
          {s.kind === 'git' && (
            <button class="btn small" disabled={s.status === 'running'} onClick={() => scan(s)}>Scannen</button>
          )}
          <button class="btn small" onClick={() => props.onEditSource(s)}>Bearbeiten</button>
          <button class="btn small danger" onClick={() => props.onDeleteSource(s)}>Löschen</button>
        </div>
      </div>
    );
  };

  return (
    <div class="settings">
      <div>
        <h1 style={{ fontSize: '22px' }}>Einstellungen</h1>
        <p class="hint">Hier verbindest du Konten, verwaltest Quellen und richtest KI und Updates ein.</p>
      </div>

      <section class="card sec" id="konten" aria-labelledby="h-konten">
        <div>
          <h2 id="h-konten">Konten</h2>
          <p class="hint">Der einfachste Weg: Melde dich bei GitHub oder GitLab an und wähle aus der Liste deiner Repositories, welche lxnEye beobachten soll. Private Repositories brauchen dann keinen eigenen Token.</p>
        </div>
        <AccountsPanel onChanged={props.onReload} onPick={props.onPick} />
      </section>

      <section class="card sec" id="quellen" aria-labelledby="h-quellen">
        <div class="row-flex" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 260px' }}>
            <h2 id="h-quellen">Quellen</h2>
            <p class="hint">Alles, was lxnEye beobachtet. Repositories kommen am besten über ein Konto. Server, Kubernetes oder ein einzelnes Repository per Adresse fügst du hier von Hand hinzu.</p>
          </div>
          <button class="btn outline" onClick={props.onAddSource}>+ Weitere Quelle hinzufügen</button>
        </div>
        {sources.length === 0 && <p class="hint">Noch keine Quellen. Verbinde oben ein Konto oder füge einen Server hinzu.</p>}
        {gitViaAccount.length > 0 && (
          <div>
            <h3 class="sgroup">Über ein Konto ({gitViaAccount.length})</h3>
            <div class="slist">{gitViaAccount.map(row)}</div>
          </div>
        )}
        {others.length > 0 && (
          <div>
            <h3 class="sgroup">Von Hand hinzugefügt ({others.length})</h3>
            <div class="slist">{others.map(row)}</div>
          </div>
        )}
      </section>

      <section class="card sec" id="scans" aria-labelledby="h-scans">
        <div>
          <h2 id="h-scans">Automatische Scans</h2>
          <p class="hint">lxnEye scannt deine Repositories regelmäßig von selbst und prüft offene Pull Requests auf Änderungen.</p>
        </div>
        <ScheduleSection onNotify={props.onNotify} onReload={props.onReload} />
      </section>

      <section class="card sec" id="ki" aria-labelledby="h-ki">
        <div>
          <h2 id="h-ki">KI</h2>
          <p class="hint">Erklärt Updates in einfachem Deutsch und kann Repositories scannen, deren Abhängigkeiten der Standard-Scan nicht kennt. Optional.</p>
        </div>
        <div class="row-flex">
          <span class={`badge ${settings.ai.connected ? 'ok' : 'neutral'}`}>
            {settings.ai.connected ? `verbunden: ${settings.ai.provider === 'gemini' ? 'Google Gemini' : 'OpenAI'}${settings.ai.model ? ` (${settings.ai.model})` : ''}` : 'nicht verbunden'}
          </span>
          <button class="btn" onClick={props.onOpenAi}>{settings.ai.connected ? 'Ändern oder testen' : 'KI verbinden'}</button>
        </div>
      </section>

      <section class="card sec" id="updates" aria-labelledby="h-updates">
        <div>
          <h2 id="h-updates">Updates</h2>
          <p class="hint">Wie lxnEye ein Update ins Repository schreibt.</p>
        </div>
        <div class="seg" role="group" aria-label="Update-Modus" style={{ alignSelf: 'flex-start' }}>
          {(['pr', 'commit'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={settings.updateMode === m}
              onClick={() => api('PUT', '/api/settings/update-mode', { mode: m }).then(props.onReload).catch((e: Error) => props.onNotify(e.message))}
            >
              {m === 'pr' ? 'Pull Request' : 'Direkt-Commit'}
            </button>
          ))}
        </div>
        <p class="hint">{settings.updateMode === 'pr' ? 'Pull Request (empfohlen): Du prüfst jede Änderung und mergst sie selbst. Ein Rollback schließt den Pull Request.' : 'Direkt-Commit: lxnEye schreibt die Änderung sofort auf den Hauptzweig, ohne Prüfung. Ein Rollback erzeugt einen Gegen-Commit.'}</p>
      </section>
    </div>
  );
}
