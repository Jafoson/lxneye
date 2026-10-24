import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './api';
import { Modal } from './dialogs';
import type { Account, ProviderInfo, RemoteRepo } from './types';
import { ago } from './util';

const LABEL = { github: 'GitHub', gitlab: 'GitLab' } as const;

const TOKEN_HELP = {
  github: 'Fine-grained Token mit "Contents", "Pull requests" und "Checks" (Read and write bzw. Read-only) für die gewünschten Repositories, oder ein klassischer Token mit dem Scope "repo".',
  gitlab: 'Persönlicher Zugriffstoken mit dem Scope "api" (zum Lesen reicht "read_api", für Updates braucht es "api").',
} as const;

type Flow = { flowId: string; userCode: string; verificationUri: string; interval: number };

function Connect(props: { providers: ProviderInfo[]; onConnected: (a: Account) => void }) {
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const info = props.providers.find((p) => p.id === provider);
  const [access, setAccess] = useState<'private' | 'public'>('private');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stop = useRef(false);

  // Auf die Bestätigung bei der Plattform warten
  useEffect(() => {
    if (!flow) return;
    stop.current = false;
    let timer = 0;
    const tick = async () => {
      if (stop.current) return;
      try {
        const r = await api<{ status: 'pending' | 'ok' | 'error'; message?: string; account?: Account }>('POST', '/api/accounts/device/poll', { flowId: flow.flowId });
        if (stop.current) return;
        if (r.status === 'ok' && r.account) {
          setFlow(null);
          props.onConnected(r.account);
          return;
        }
        if (r.status === 'error') {
          setFlow(null);
          setError(r.message ?? 'Die Anmeldung ist fehlgeschlagen.');
          return;
        }
      } catch (e) {
        setFlow(null);
        setError((e as Error).message);
        return;
      }
      timer = window.setTimeout(tick, flow.interval * 1000 + 500);
    };
    timer = window.setTimeout(tick, 2000);
    return () => {
      stop.current = true;
      window.clearTimeout(timer);
    };
  }, [flow?.flowId]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Flow>('POST', '/api/accounts/device/start', { provider, access });
      setFlow(r);
      window.open(r.verificationUri, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveToken() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ account: Account }>('POST', '/api/accounts/token', { provider, token });
      setToken('');
      props.onConnected(r.account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="panel">
      <div class="panel-title">Konto verbinden</div>
      <div role="group" aria-label="Plattform" class="row-flex">
        {props.providers.map((p) => (
          <button key={p.id} class="choice" aria-pressed={provider === p.id} onClick={() => { setProvider(p.id); setFlow(null); setError(null); }}>
            {p.label}
            {p.id === 'gitlab' && p.host !== 'gitlab.com' ? ` (${p.host})` : ''}
          </button>
        ))}
      </div>

      {flow ? (
        <div class="box">
          <h3>Bestätige die Anmeldung bei {LABEL[provider]}</h3>
          <p>Gib dort diesen Code ein:</p>
          <div class="row-flex">
            <span class="mono" style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '0.08em' }}>{flow.userCode}</span>
            <button class="btn small" onClick={() => { void navigator.clipboard?.writeText(flow.userCode); setCopied(true); }}>{copied ? 'Kopiert' : 'Kopieren'}</button>
          </div>
          <p class="hint">
            Die Seite hat sich in einem neuen Tab geöffnet. Falls nicht: <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer">{flow.verificationUri}</a>. lxnEye wartet und macht dann automatisch weiter.
          </p>
          <div><button class="btn" onClick={() => setFlow(null)}>Abbrechen</button></div>
        </div>
      ) : (
        <>
          {info?.deviceFlow ? (
            <>
              {provider === 'github' && (
                <div role="group" aria-label="Zugriff" class="row-flex">
                  <button class="choice" aria-pressed={access === 'private'} onClick={() => setAccess('private')}>Auch private Repositories</button>
                  <button class="choice" aria-pressed={access === 'public'} onClick={() => setAccess('public')}>Nur öffentliche</button>
                </div>
              )}
              <div class="actions">
                <button class="btn primary" disabled={busy} onClick={start}>Mit {LABEL[provider]} anmelden</button>
                <button class="btn" onClick={() => setShowToken(!showToken)}>{showToken ? 'Token-Eingabe ausblenden' : 'Stattdessen Token einfügen'}</button>
              </div>
              <p class="hint">Du bestätigst die Anmeldung auf {info.host} mit einem Code. lxnEye sieht dein Passwort nie.</p>
            </>
          ) : (
            <p class="hint">
              Die Anmeldung per Klick ist für {LABEL[provider]} nicht eingerichtet. Dafür setzt du <span class="mono">{provider === 'github' ? 'GITHUB_CLIENT_ID' : 'GITLAB_CLIENT_ID'}</span> (siehe README). Du kannst stattdessen einen Token einfügen.
            </p>
          )}
          {(showToken || !info?.deviceFlow) && (
            <div class="box">
              <label class="field">
                Zugangstoken für {LABEL[provider]}
                <input type="password" autocomplete="off" value={token} placeholder="••••••••" onInput={(e) => setToken((e.target as HTMLInputElement).value.trim())} />
              </label>
              <p class="hint">{TOKEN_HELP[provider]}</p>
              <div><button class="btn primary" disabled={busy || token.length < 10} onClick={saveToken}>Konto verbinden</button></div>
            </div>
          )}
        </>
      )}
      {error && <p class="box danger">{error}</p>}
    </div>
  );
}

/** Konten verbinden, trennen und Repositories auswählen. Wird auf der Einstellungsseite und im Dialog genutzt. */
export function AccountsPanel(props: { onChanged: () => void; onPick: (a: Account) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ accounts: Account[]; providers: ProviderInfo[] }>('GET', '/api/accounts')
      .then((r) => {
        setAccounts(r.accounts);
        setProviders(r.providers);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function disconnect(a: Account) {
    try {
      await api('DELETE', `/api/accounts/${a.id}`);
      setConfirm(null);
      await load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {accounts.length > 0 && (
        <div class="box" style={{ padding: 0, gap: 0 }}>
          {accounts.map((a) => (
            <div key={a.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div class="row-flex" style={{ gap: '8px 12px' }}>
                <strong>{a.login}</strong>
                <span class="badge neutral">{LABEL[a.provider]}{a.host !== 'github.com' && a.host !== 'gitlab.com' ? ` · ${a.host}` : ''}</span>
                <span class="hint" style={{ flexGrow: 1 }}>{a.watched} {a.watched === 1 ? 'Repository wird' : 'Repositories werden'} beobachtet · verbunden {ago(a.createdAt)}{a.via === 'token' ? ' per Token' : ''}</span>
                <button class="btn primary small" onClick={() => props.onPick(a)}>Repositories auswählen</button>
                <button class="btn small danger" onClick={() => setConfirm(confirm === a.id ? null : a.id)}>Trennen</button>
              </div>
              {confirm === a.id && (
                <div class="box danger">
                  <p>
                    Das Konto wird getrennt und der Zugang gelöscht. Die {a.watched} beobachteten Repositories bleiben in lxnEye, können aber nicht mehr gelesen werden, bis du ein Konto oder einen Token neu hinterlegst.
                  </p>
                  <div class="actions">
                    <button class="btn danger small" onClick={() => disconnect(a)}>Wirklich trennen</button>
                    <button class="btn small" onClick={() => setConfirm(null)}>Abbrechen</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p class="box danger">{error}</p>}
      {providers.length > 0 && (
        <Connect
          providers={providers}
          onConnected={(a) => {
            void load();
            props.onChanged();
            props.onPick(a);
          }}
        />
      )}
    </>
  );
}

export function RepoPickerDialog(props: { account: Account; onClose: () => void; onSaved: (msg: string) => void }) {
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hideArchived, setHideArchived] = useState(true);
  const [hideForks, setHideForks] = useState(false);
  const [onlyWatched, setOnlyWatched] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = (fresh = false) => {
    setRepos(null);
    setError(null);
    api<{ repos: RemoteRepo[] }>('GET', `/api/accounts/${props.account.id}/repos${fresh ? '?refresh=1' : ''}`)
      .then((r) => {
        setRepos(r.repos);
        setChecked(new Set(r.repos.filter((x) => x.watchedSourceId).map((x) => x.fullName)));
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => load(), [props.account.id]);

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (repos ?? []).filter(
      (r) => (!hideArchived || !r.archived || checked.has(r.fullName)) && (!hideForks || !r.fork) && (!onlyWatched || checked.has(r.fullName)) && (!t || `${r.fullName} ${r.description ?? ''}`.toLowerCase().includes(t)),
    );
  }, [repos, q, hideArchived, hideForks, onlyWatched, checked]);

  const toggle = (n: string) =>
    setChecked((s) => {
      const c = new Set(s);
      if (c.has(n)) c.delete(n);
      else c.add(n);
      return c;
    });
  const allVisible = visible.length > 0 && visible.every((r) => checked.has(r.fullName));
  const toggleVisible = () =>
    setChecked((s) => {
      const c = new Set(s);
      for (const r of visible) allVisible ? c.delete(r.fullName) : c.add(r.fullName);
      return c;
    });

  // Änderungen gegenüber dem aktuellen Stand
  // Neu hinzugefügt wird nur, was noch nicht beobachtet wird. Von Hand angelegte Quellen behalten ihren eigenen Zugang.
  const add = (repos ?? []).filter((r) => checked.has(r.fullName) && !r.watchedSourceId).map((r) => r.fullName);
  const newOnes = add.length;
  const remove = (repos ?? []).filter((r) => !checked.has(r.fullName) && r.watchedSourceId && r.viaAccount).map((r) => r.watchedSourceId as string);
  const changed = newOnes > 0 || remove.length > 0;

  async function save() {
    if (remove.length > 0 && !confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ added: number; linked: number; removed: number }>('POST', `/api/accounts/${props.account.id}/watch`, { add, remove });
      props.onSaved(`${r.added + r.linked} Repositories werden beobachtet${r.removed ? `, ${r.removed} entfernt` : ''}. Die Scans laufen im Hintergrund.`);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal label="Repositories auswählen" onClose={props.onClose}>
      <div class="dialog-head">
        <div>
          <h2>Repositories von {props.account.login}</h2>
          <p class="hint">{LABEL[props.account.provider]} · Haken setzen = lxnEye beobachtet das Repository.</p>
        </div>
        <button class="btn" data-autofocus onClick={props.onClose}>Abbrechen</button>
      </div>

      <div class="filters">
        <label class="search">
          <input type="search" aria-label="Repositories suchen" value={q} placeholder="Suchen …" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        <button class="btn small" onClick={() => load(true)} title="Liste neu von der Plattform laden">Aktualisieren</button>
      </div>
      <div class="row-flex" style={{ fontSize: '13px' }}>
        <label class="row-flex"><input type="checkbox" class="chk" checked={hideArchived} onChange={(e) => setHideArchived((e.target as HTMLInputElement).checked)} /> Archivierte ausblenden</label>
        <label class="row-flex"><input type="checkbox" class="chk" checked={hideForks} onChange={(e) => setHideForks((e.target as HTMLInputElement).checked)} /> Forks ausblenden</label>
        <label class="row-flex"><input type="checkbox" class="chk" checked={onlyWatched} onChange={(e) => setOnlyWatched((e.target as HTMLInputElement).checked)} /> Nur ausgewählte</label>
      </div>

      {error && <p class="box danger">{error}</p>}
      {!repos && !error && <p class="hint">Lade Repositories …</p>}
      {repos && (
        <div class="box" style={{ padding: 0, gap: 0, maxHeight: '42vh', overflow: 'auto' }}>
          <label class="row-flex" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--surface-2)' }}>
            <input type="checkbox" class="chk" checked={allVisible} onChange={toggleVisible} />
            <strong>Alle sichtbaren auswählen ({visible.length})</strong>
          </label>
          {visible.length === 0 && <p class="hint" style={{ padding: '14px' }}>Keine Repositories für diese Auswahl.</p>}
          {visible.map((r) => (
            <label key={r.fullName} class="row-flex" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', alignItems: 'flex-start', gap: '12px' }}>
              <input type="checkbox" class="chk" style={{ marginTop: '2px' }} checked={checked.has(r.fullName)} onChange={() => toggle(r.fullName)} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                <span class="row-flex" style={{ gap: '6px' }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{r.fullName}</strong>
                  {r.private && <span class="badge neutral">privat</span>}
                  {r.archived && <span class="badge warn">archiviert</span>}
                  {r.fork && <span class="badge neutral">Fork</span>}
                  {r.watchedSourceId && !r.viaAccount && <span class="badge info">manuell angelegt</span>}
                </span>
                {r.description && <span class="hint">{r.description}</span>}
                {r.pushedAt && <span class="hint">zuletzt aktiv {ago(Date.parse(r.pushedAt))}</span>}
              </span>
            </label>
          ))}
        </div>
      )}

      {confirmRemove && (
        <div class="box danger">
          <p>{remove.length} {remove.length === 1 ? 'Repository wird' : 'Repositories werden'} nicht mehr beobachtet. Die Quelle und ihre gespeicherten Einträge in lxnEye werden entfernt. Dein Repository selbst bleibt unverändert.</p>
        </div>
      )}
      <div class="actions" style={{ justifyContent: 'space-between' }}>
        <span class="hint" style={{ alignSelf: 'center' }}>{checked.size} ausgewählt{newOnes > 0 ? `, ${newOnes} neu` : ''}{remove.length > 0 ? `, ${remove.length} werden entfernt` : ''}</span>
        <button class="btn primary" disabled={busy || !changed} onClick={save}>{confirmRemove ? 'Ja, entfernen und speichern' : 'Übernehmen'}</button>
      </div>
    </Modal>
  );
}
