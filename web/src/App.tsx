import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, setCsrf } from './api';
import { AddSourceDialog, AiDialog, BatchDialog, ConfirmDialog, DeleteSourceDialog, DetailDialog, EditSourceDialog, LinkDialog } from './dialogs';
import { RepoPickerDialog } from './accounts';
import { ChecksBadge } from './checks';
import { LinkIcon } from './icons';
import { SettingsPage } from './settings';
import type { Account, Candidate, Item, PrStatus, QuickLink, SessionInfo, Settings, Source } from './types';
import { ago, BUMP_TIP, canRollback, fixesCves, KIND_LABEL, pendingLabel, sevRank } from './util';

type StatusFilter = 'all' | 'outdated' | 'cve' | 'current';
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'outdated', label: 'Veraltet' },
  { id: 'cve', label: 'Mit CVE' },
  { id: 'current', label: 'Aktuell' },
];

const EyeIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [links, setLinks] = useState<QuickLink[]>([]);
  const [prLive, setPrLive] = useState<Record<string, PrStatus>>({});
  const [linkDialog, setLinkDialog] = useState<{ link: QuickLink | null } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>({ updateMode: 'pr', ai: { connected: false } });
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [serverFilter, setServerFilter] = useState('');
  const [detail, setDetail] = useState<{ id: string; mode: 'badge' | 'item' } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pickAccount, setPickAccount] = useState<Account | null>(null);
  const [hash, setHash] = useState(window.location.hash);
  const [showAi, setShowAi] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [batchPreset, setBatchPreset] = useState<'patch' | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ it: Item; to?: string; reasons: string[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Zwei Ansichten: Übersicht (#/) und Einstellungen (#/einstellungen[/abschnitt]). Der Zurück-Knopf des Browsers funktioniert.
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const view = hash.startsWith('#/einstellungen') ? 'settings' : 'dashboard';
  const go = (to: string) => {
    window.location.hash = to;
  };
  useEffect(() => {
    if (view !== 'settings') return;
    const section = hash.split('/')[2];
    const el = section ? document.getElementById(section) : null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo(0, 0);
  }, [hash, view]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  useEffect(() => {
    api<SessionInfo>('GET', '/api/session')
      .then((s) => {
        if (s.csrf) setCsrf(s.csrf);
        setSession(s);
      })
      .catch(() => setSession({ authenticated: false }));
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, i, st, l] = await Promise.all([
        api<{ sources: Source[] }>('GET', '/api/sources'),
        api<{ items: Item[] }>('GET', '/api/items'),
        api<Settings>('GET', '/api/settings'),
        api<{ links: QuickLink[] }>('GET', '/api/links'),
      ]);
      setLinks(l.links);
      setSources(s.sources);
      setItems(i.items);
      setSettings(st);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setSession({ authenticated: false });
    }
  }, []);

  const scanning = sources.some((s) => s.status === 'running' || s.status === 'pending');
  const authed = session?.authenticated === true;
  useEffect(() => {
    if (!authed) return;
    void load();
    const t = window.setInterval(() => void load(), scanning ? 5000 : 60000);
    return () => window.clearInterval(t);
  }, [authed, scanning, load]);

  // Prüfläufe (CI/CD) der Pull Requests: unsere eigenen und die von Renovate
  const prKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const i of items) {
      if (i.update?.prNumber && i.update.status === 'open' && i.bump !== '') keys.add(`${i.update.sourceId}:${i.update.prNumber}`);
      for (const p of i.renovatePrs) if (p.sourceId) keys.add(`${p.sourceId}:${p.number}`);
    }
    return [...keys].sort().join(',');
  }, [items]);
  useEffect(() => {
    if (!authed || !prKeys) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await api<{ statuses: Record<string, PrStatus> }>('GET', `/api/prs/status?keys=${encodeURIComponent(prKeys)}`);
        if (!alive) return;
        setPrLive(r.statuses);
        // Wurde ein PR inzwischen gemergt oder geschlossen, hat der Server das schon vermerkt: Liste neu laden
        if (Object.values(r.statuses).some((s) => s.state !== 'open')) void load();
        const wait = Object.values(r.statuses).some((s) => s.checks === 'pending') ? 20_000 : 90_000;
        timer = window.setTimeout(tick, wait);
      } catch {
        if (alive) timer = window.setTimeout(tick, 120_000);
      }
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [authed, prKeys, load]);

  const run = async (id: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusyIds((b) => new Set(b).add(id));
    try {
      await fn();
      if (okMsg) notify(okMsg);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusyIds((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
      await load();
    }
  };

  const doUpdate = (it: Item, to?: string) =>
    run(it.id, async () => {
      const r = await api<{ update: { mode: 'pr' | 'commit'; prNumber: number | null; toVersion: string } }>('POST', `/api/items/${it.id}/update`, to ? { to } : {});
      const where = it.locations.length > 1 ? ` (${it.locations.length} Dateien)` : '';
      notify(r.update.mode === 'pr' ? `Pull Request #${r.update.prNumber} für ${it.name} ${r.update.toVersion} erstellt${where}.` : `Commit für ${it.name} ${r.update.toVersion} erstellt${where}.`);
    });

  /** Fragt nach, wenn Renovate-Regeln oder ein offener Renovate-PR gegen das Update sprechen. */
  const requestUpdate = (it: Item, to?: string) => {
    const target = to ?? it.candidates[it.candidates.length - 1]?.version;
    const reasons: string[] = [];
    const blocked = it.candidates.find((c) => c.version === target)?.blocked;
    if (blocked) reasons.push(blocked);
    if (it.renovatePrs.length > 0) {
      reasons.push(`Renovate hat dafür schon einen offenen Pull Request: ${it.renovatePrs.map((p) => `#${p.number}`).join(', ')}. Ein weiteres Update erzeugt einen zweiten.`);
    }
    if (reasons.length > 0) setConfirm({ it, to, reasons });
    else void doUpdate(it, to);
  };

  const doRollback = (it: Item) =>
    it.update &&
    run(it.id, async () => {
      const r = await api<{ rollback: { mode: string } | null }>('POST', `/api/updates/${it.update?.id}/rollback`);
      notify(r.rollback ? 'Rollback eingereicht.' : 'Pull Request geschlossen.');
    });

  // ---------- Ableitungen ----------
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const cur = tab === 'all' ? null : sourceById.get(tab) ?? null;
  useEffect(() => {
    if (tab !== 'all' && sources.length > 0 && !sourceById.has(tab)) setTab('all');
  }, [tab, sources, sourceById]);

  const inSource = useMemo(() => (cur ? items.filter((i) => i.sourceId === cur.id) : items), [items, cur]);
  const serverNames = useMemo(() => [...new Set(inSource.flatMap((i) => i.servers))].sort(), [inSource]);
  useEffect(() => {
    if (serverFilter && !serverNames.includes(serverFilter)) setServerFilter('');
  }, [serverFilter, serverNames]);
  const scopeItems = useMemo(() => (serverFilter ? inSource.filter((i) => i.servers.includes(serverFilter)) : inSource), [inSource, serverFilter]);
  const outdated = scopeItems.filter((i) => i.bump !== '').length;
  const withCve = scopeItems.filter((i) => i.cves.length > 0).length;
  const unknownCount = scopeItems.filter((i) => i.latest === null && i.bump === '').length;
  const pendingCount = scopeItems.filter((i) => pendingLabel(i)).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopeItems
      .filter((i) => {
        const open = i.bump !== '';
        const ok = status === 'all' ? true : status === 'outdated' ? open : status === 'cve' ? i.cves.length > 0 : !open;
        return ok && (!q || `${i.name} ${i.type} ${i.sourceName}`.toLowerCase().includes(q));
      })
      .sort((a, b) => sevRank(b) - sevRank(a) || a.name.localeCompare(b.name));
  }, [scopeItems, query, status]);

  const selectable = (i: Item) => i.bump !== '' && i.updatable && !pendingLabel(i);
  const visibleSelectable = rows.filter(selectable);
  const selectedItems = items.filter((i) => selected.has(i.id) && selectable(i));
  const allSelected = visibleSelectable.length > 0 && visibleSelectable.every((i) => selected.has(i.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      for (const i of visibleSelectable) {
        if (allSelected) n.delete(i.id);
        else n.add(i.id);
      }
      return n;
    });

  const patchItems = scopeItems.filter((i) => i.candidates.some((c) => c.level === 'Patch') && i.updatable && !pendingLabel(i));
  const failed = sources.filter((s) => s.status === 'failed');

  /** Wählt alle Einträge mit einem Patch-Ziel aus und öffnet die Vorabprüfung mit der Voreinstellung "Nur Patch". */
  function updatePatches() {
    setSelected(new Set(patchItems.map((i) => i.id)));
    setBatchPreset('patch');
    setShowBatch(true);
  }

  const detailItem = detail ? items.find((i) => i.id === detail.id) ?? null : null;

  // ---------- Anzeige ----------
  if (!session) return <div class="login"><p class="hint">Lade …</p></div>;
  if (!authed) {
    return (
      <main class="login">
        <div class="card login-card">
          <EyeIcon />
          <h1>lxnEye</h1>
          <p class="hint">Melde dich über den Single-Sign-On deiner Instanz an.</p>
          <a class="btn primary" href="/auth/login">Mit SSO anmelden</a>
        </div>
      </main>
    );
  }

  const logout = async () => {
    await api('POST', '/auth/logout');
    setSession({ authenticated: false });
  };

  return (
    <>
      <header class="header">
        <div class="header-inner">
          <button class="brand-link" onClick={() => go('#/')} aria-label="Zur Übersicht">
            <EyeIcon /> lxnEye
          </button>
          <div style={{ flexGrow: 1 }} />
          <div class="toolbar">
            <span class="hint">Update-Modus</span>
            <div class="seg" role="group" aria-label="Update-Modus">
              {(['pr', 'commit'] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={settings.updateMode === m}
                  onClick={() => api('PUT', '/api/settings/update-mode', { mode: m }).then(load).catch((e: Error) => notify(e.message))}
                >
                  {m === 'pr' ? 'Pull Request' : 'Direkt-Commit'}
                </button>
              ))}
            </div>
            {session.devAuth ? (
              <span class="badge warn tip" data-tip="Entwicklungsmodus: Die Anmeldung ist ausgeschaltet.">Dev ohne SSO</span>
            ) : (
              <button class="btn" onClick={logout} title={session.user?.email ?? ''}>
                Abmelden
              </button>
            )}
          </div>
        </div>
      </header>

      <div class="page">
        <div class="side">
        <nav class="nav" aria-label="Quellen">
          <div class="nav-head">
            <div class="nav-title">Quellen</div>
            <button class="icon-only" aria-label="Quelle hinzufügen" title="Quelle hinzufügen" onClick={() => setShowAdd(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          <button class="nav-item" aria-current={view === 'dashboard' && tab === 'all'} onClick={() => { setTab('all'); setQuery(''); setStatus('all'); go('#/'); }}>
            <span class="nav-text">
              <span class="nav-name">Übersicht</span>
              <span class="nav-sub">{sources.length} Quellen</span>
            </span>
            {items.filter((i) => i.bump !== '').length > 0 && <span class="pill">{items.filter((i) => i.bump !== '').length}</span>}
          </button>
          {sources.map((s) => (
            <button key={s.id} class="nav-item" aria-current={view === 'dashboard' && tab === s.id} onClick={() => { setTab(s.id); setQuery(''); setStatus('all'); go('#/'); }}>
              <span class="nav-text">
                <span class="nav-name">{s.name}</span>
                <span class="nav-sub">{KIND_LABEL[s.kind]}</span>
              </span>
              {s.status === 'failed' ? (
                <span class="pill danger">Fehler</span>
              ) : s.status === 'running' || s.status === 'pending' ? (
                <span class="pill info">Scan …</span>
              ) : (
                s.counts.outdated > 0 && <span class="pill">{s.counts.outdated}</span>
              )}
            </button>
          ))}
        </nav>

        <nav class="nav" aria-label="Schnellnavigation">
          <div class="nav-head">
            <div class="nav-title">Schnellnavigation</div>
            <button class="icon-only" aria-label="Link hinzufügen" title="Link hinzufügen" onClick={() => setLinkDialog({ link: null })}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          {links.length === 0 && <p class="hint" style={{ padding: '0 12px' }}>Hier kannst du Links zu deinen Diensten ablegen, zum Beispiel Grafana oder Argo CD.</p>}
          {links.map((l) => (
            <div class="quick-row" key={l.id}>
              <a class="quick-link" href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.url} (öffnet in neuem Tab)`}>
                <LinkIcon icon={l.icon} />
                <span class="qt">{l.title}</span>
              </a>
              <button class="icon-only" aria-label={`${l.title} bearbeiten`} title="Bearbeiten" onClick={() => setLinkDialog({ link: l })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></svg>
              </button>
            </div>
          ))}
        </nav>

        <nav class="nav" aria-label="Einstellungen">
          <div class="nav-title">Verwaltung</div>
          <button class="nav-item" aria-current={view === 'settings'} onClick={() => go('#/einstellungen')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ flex: '0 0 auto' }}>
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
            </svg>
            <span class="nav-text">
              <span class="nav-name">Einstellungen</span>
              <span class="nav-sub">Konten, Quellen, KI, Updates</span>
            </span>
          </button>
          {view === 'settings' && (
            <div class="subnav">
              {[['konten', 'Konten'], ['quellen', 'Quellen'], ['ki', 'KI'], ['updates', 'Updates']].map(([id, label]) => (
                <a key={id} href={`#/einstellungen/${id}`} aria-current={hash.split('/')[2] === id}>
                  {label}
                </a>
              ))}
            </div>
          )}
        </nav>
        </div>

        {view === 'settings' ? (
          <div class="main">
            <SettingsPage
              sources={sources}
              settings={settings}
              onReload={load}
              onNotify={notify}
              onPick={setPickAccount}
              onAddSource={() => setShowAdd(true)}
              onEditSource={setEditing}
              onDeleteSource={setDeleting}
              onOpenAi={() => setShowAi(true)}
            />
          </div>
        ) : (
        <main class="main">
          {cur && <Banner source={cur} aiConnected={settings.ai.connected} onOpenAi={() => setShowAi(true)} reload={load} notify={notify} />}
          {!cur && failed.length > 0 && (
            <section class="banner danger" aria-label="Scan-Status">
              <h2>{failed.length === 1 ? '1 Quelle mit Scan-Fehler' : `${failed.length} Quellen mit Scan-Fehler`}</h2>
              <p>{failed.map((s) => s.name).join(', ')}</p>
              <div class="actions">
                <button class="btn" onClick={() => setTab((failed[0] as Source).id)}>Anzeigen</button>
              </div>
            </section>
          )}

          <div class="row-flex" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <h1 style={{ fontSize: '22px' }}>{cur ? cur.name : 'Übersicht'}</h1>
              <p class="hint">
                {cur
                  ? `${KIND_LABEL[cur.kind]}${cur.url ? ` · ${cur.url}` : ''} · zuletzt ${cur.kind === 'git' ? 'gescannt' : 'gemeldet'} ${ago(cur.lastScanAt)}${cur.scannedByAi ? ' · per KI gescannt' : ''}`
                  : 'Alle Server und Repositories auf einen Blick'}
              </p>
              {cur?.meta.renovate && (
                <p class="hint">
                  <span class="badge warn tip" data-tip="Dieses Repository nutzt Renovate. lxnEye beachtet dessen Regeln als Hinweis und zeigt offene Renovate-Pull-Requests an.">Renovate erkannt</span>{' '}
                  {(cur.meta.renovate as { file: string; rules: unknown[]; prs: unknown[] }).file}: {(cur.meta.renovate as { rules: unknown[] }).rules.length} Regeln, {(cur.meta.renovate as { prs: unknown[] }).prs.length} offene Pull Requests
                </p>
              )}
            </div>
            {cur && (
              <div class="actions">
                {cur.kind === 'git' && (
                  <button class="btn" disabled={cur.status === 'running'} onClick={() => api('POST', `/api/sources/${cur.id}/scan`, {}).then(load).catch((e: Error) => notify(e.message))}>
                    Jetzt scannen
                  </button>
                )}
                <button class="btn" onClick={() => setEditing(cur)}>Bearbeiten</button>
                <button class="btn danger" onClick={() => setDeleting(cur)}>Löschen</button>
              </div>
            )}
          </div>

          <section class="stats" aria-label="Zusammenfassung">
            <Stat label="Einträge gesamt" value={scopeItems.length} sub={unknownCount > 0 ? `davon ${unknownCount} nicht prüfbar` : 'Veraltet + aktuell'} />
            <Stat label="Veraltet" value={outdated} sub="Update verfügbar" color="var(--warn-text)" />
            <Stat label="Mit Sicherheitslücke" value={withCve} sub="Zuerst updaten" color="var(--danger-text)" />
            <Stat label="Aktuell" value={scopeItems.length - outdated - unknownCount} sub={pendingCount > 0 ? `davon ${pendingCount} in Arbeit (PR/Commit)` : 'Auf dem neuesten Stand'} color="var(--accent)" />
          </section>

          <section class="filters" aria-label="Suche und Filter">
            <label class="search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input type="search" aria-label="Suchen" value={query} placeholder="Suchen nach Name, Typ oder Quelle …" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
            </label>
            <div class="seg" role="group" aria-label="Statusfilter">
              {FILTERS.map((f) => (
                <button key={f.id} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            {visibleSelectable.length > 1 && (
              <label class="row-flex" style={{ gap: '6px', minHeight: '44px' }}>
                <input type="checkbox" class="chk" checked={allSelected} onChange={toggleAll} />
                <span class="hint">Alle auswählen ({visibleSelectable.length})</span>
              </label>
            )}
            {serverNames.length > 1 && (
              <label class="row-flex" style={{ gap: '6px' }}>
                <span class="hint">Server</span>
                <select class="compact" aria-label="Nach Server filtern" value={serverFilter} onChange={(e) => setServerFilter((e.target as HTMLSelectElement).value)}>
                  <option value="">Alle</option>
                  {serverNames.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            {patchItems.length > 0 && (
              <button class="btn outline" onClick={updatePatches}>
                Alle Patches updaten ({patchItems.length})
              </button>
            )}
          </section>

          <section class="card list" aria-label="Einträge">
            {sources.length === 0 && (
              <div class="welcome">
                <h2 style={{ fontSize: '18px' }}>Willkommen bei lxnEye</h2>
                <p class="hint" style={{ maxWidth: '520px' }}>Verbinde dein GitHub- oder GitLab-Konto und wähle aus, welche Repositories beobachtet werden. Server und Kubernetes fügst du in den Einstellungen unter Quellen hinzu.</p>
                <div class="actions" style={{ justifyContent: 'center' }}>
                  <button class="btn primary" onClick={() => go('#/einstellungen/konten')}>Konto verbinden</button>
                  <button class="btn" onClick={() => setShowAdd(true)}>Server oder Kubernetes hinzufügen</button>
                </div>
              </div>
            )}
            {sources.length > 0 && rows.length === 0 && (
              <div class="empty">{scopeItems.length === 0 ? 'Noch keine Daten für diese Auswahl.' : 'Keine Treffer für diese Suche oder diesen Filter.'}</div>
            )}
            {rows.map((it) => (
              <ItemRow
                key={it.id}
                it={it}
                showSource={!cur}
                live={prLive}
                selectable={selectable(it)}
                selected={selected.has(it.id)}
                onToggle={() => toggle(it.id)}
                showServers={rows.some((r) => r.servers.length > 0)}
                onServer={setServerFilter}
                busy={busyIds.has(it.id)}
                onSource={() => setTab(it.sourceId)}
                onOpen={(mode) => setDetail({ id: it.id, mode })}
                onUpdate={(to) => requestUpdate(it, to)}
                onRollback={() => doRollback(it)}
              />
            ))}
          </section>

          {selectedItems.length > 0 && (
            <div class="selbar" role="region" aria-label="Auswahl">
              <strong>{selectedItems.length} ausgewählt</strong>
              <span class="hint" style={{ flexGrow: 1 }}>Zielversionen wählst du im nächsten Schritt. Vorher wird alles geprüft.</span>
              <button class="btn" onClick={() => setSelected(new Set())}>Auswahl aufheben</button>
              <button class="btn primary" onClick={() => { setBatchPreset(undefined); setShowBatch(true); }}>Prüfen & updaten</button>
            </div>
          )}
        </main>
        )}
      </div>

      {detailItem && detail && (
        <DetailDialog
          item={detailItem}
          mode={detail.mode}
          settings={settings}
          live={prLive}
          onClose={() => setDetail(null)}
          onToItem={() => setDetail({ id: detailItem.id, mode: 'item' })}
          onUpdate={(to) => requestUpdate(detailItem, to)}
          onRollback={() => doRollback(detailItem)}
          onOpenAi={() => setShowAi(true)}
        />
      )}
      {showAdd && (
        <AddSourceDialog
          sources={sources}
          aiConnected={settings.ai.connected}
          onOpenAccounts={() => go('#/einstellungen/konten')}
          onClose={() => setShowAdd(false)}
          onCreated={load}
          onOpenAi={() => setShowAi(true)}
        />
      )}
      {linkDialog && <LinkDialog link={linkDialog.link} onClose={() => setLinkDialog(null)} onSaved={load} />}
      {editing && <EditSourceDialog source={editing} sources={sources} onClose={() => setEditing(null)} onSaved={load} />}
      {deleting && <DeleteSourceDialog source={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setTab('all'); void load(); }} />}
      {showBatch && (
        <BatchDialog
          items={selectedItems}
          preset={batchPreset}
          mode={settings.updateMode}
          onClose={() => setShowBatch(false)}
          onDone={() => {
            setSelected(new Set());
            void load();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`${confirm.it.name} trotzdem updaten?`}
          reasons={confirm.reasons}
          confirmLabel="Trotzdem updaten"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void doUpdate(c.it, c.to);
          }}
        />
      )}
      {pickAccount && (
        <RepoPickerDialog
          account={pickAccount}
          onClose={() => setPickAccount(null)}
          onSaved={(msg) => {
            notify(msg);
            void load();
          }}
        />
      )}
      {showAi && <AiDialog settings={settings} onClose={() => setShowAi(false)} onChanged={load} />}
      {toast && <div class="toast" role="status">{toast}</div>}
    </>
  );
}

function Stat(props: { label: string; value: number; sub: string; color?: string }) {
  return (
    <div class="card stat">
      <div class="stat-label">{props.label}</div>
      <div class="stat-value" style={props.color ? { color: props.color } : undefined}>{props.value}</div>
      <div class="stat-sub">{props.sub}</div>
    </div>
  );
}

function UpdateMenu(props: { it: Item; busy: boolean; onUpdate: (to?: string) => void }) {
  const { it } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (it.candidates.length <= 1) {
    return (
      <button class="btn primary tip" data-tip={it.candidates[0]?.blocked ?? ''} disabled={props.busy} onClick={() => props.onUpdate(it.candidates[0]?.version)} style={it.candidates[0]?.blocked ? { outline: '2px dashed var(--warn-text)', outlineOffset: '2px' } : undefined}>
        {props.busy ? '…' : 'Update'}
      </button>
    );
  }
  const pick = (c: Candidate) => {
    setOpen(false);
    props.onUpdate(c.version);
  };
  return (
    <div class="menu-wrap" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button class="btn primary" disabled={props.busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.busy ? '…' : 'Update ▾'}
      </button>
      {open && (
        <div class="menu" role="menu" aria-label="Zielversion wählen">
          {[...it.candidates].reverse().map((c) => (
            <button key={c.version} role="menuitem" onClick={() => pick(c)}>
              <span class={`badge ${c.level}`}>{c.level}</span>
              <span class="ver">{c.version}</span>
              {fixesCves(it, c.version) && <span class="badge ok">behebt CVE</span>}
              {c.blocked && <span class="badge warn tip" data-tip={c.blocked}>Renovate-Regel</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow(props: {
  it: Item;
  live: Record<string, PrStatus>;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  showSource: boolean;
  showServers: boolean;
  busy: boolean;
  onSource: () => void;
  onServer: (name: string) => void;
  onOpen: (mode: 'badge' | 'item') => void;
  onUpdate: (to?: string) => void;
  onRollback: () => void;
}) {
  const { it } = props;
  const pending = pendingLabel(it);
  const open = it.bump !== '';
  const places = it.locations.length;
  const cols = ['24px', 'minmax(130px, 1fr)', props.showSource && '100px', props.showServers && '100px', 'minmax(100px, 160px)', 'minmax(96px, 160px)', '112px'].filter(Boolean).join(' ');
  return (
    <div class={`row ${props.showServers ? 'has-srv' : ''}`} style={{ '--cols': cols } as Record<string, string>}>
      <div class="row-sel">
        {props.selectable && <input type="checkbox" class="chk" checked={props.selected} onChange={props.onToggle} aria-label={`${it.name} auswählen`} />}
      </div>
      <div class="row-name">
        <button class="link tip" data-tip="Klicken für eine Zusammenfassung auf Deutsch: was ist neu, was ist zu beachten." onClick={() => props.onOpen('item')}>
          {it.name}
        </button>
        <span class="row-type">{it.type}</span>
        {places > 1 && (
          <span class="meta-line">
            <span class="tip" tabindex={0} data-tip={it.locations.map((l) => l.file).join(', ')}>
              {places} Stellen
            </span>
          </span>
        )}
      </div>
      {props.showSource && (
        <div class="row-src">
          <button class="chip" onClick={props.onSource}>{it.sourceName}</button>
        </div>
      )}
      {props.showServers && (
        <div class="row-srv">
          {it.servers.map((sv) => (
            <button key={sv} class="chip" aria-label={`Nach Server ${sv} filtern`} onClick={() => props.onServer(sv)}>{sv}</button>
          ))}
        </div>
      )}
      <div class="row-version">{open ? (pending ? (it.update?.toVersion ?? it.latest) : `${it.current}  →  ${it.latest}`) : it.current}</div>
      <div class="row-badges">
        {open && !pending && [...new Set(it.candidates.map((c) => c.level))].map((level) => {
          const versions = it.candidates.filter((c) => c.level === level).map((c) => c.version);
          return (
            <button key={level} class={`badge tip ${level}`} data-tip={`${level} → ${versions.join(' oder ')}. ${BUMP_TIP[level] ?? ''}`} aria-label={`${level}-Update auf ${versions.join(' oder ')}, Details öffnen`} onClick={() => props.onOpen('badge')}>
              {level}
            </button>
          );
        })}
        {it.cves.length > 0 && (
          <button class="badge danger tip" data-tip={`Bekannte Sicherheitslücke (CVE) in der installierten Version${it.cves.find((c) => c.fixed)?.fixed ? `, behoben ab ${it.cves.find((c) => c.fixed)?.fixed}` : ''}${open ? '' : '. Es ist noch keine neuere Version bekannt'}. Klicken für Details.`} aria-label="Sicherheitslücke, Details öffnen" onClick={() => props.onOpen('badge')}>
            CVE
          </button>
        )}
        {!open && it.latest !== null && <span class="badge ok tip" data-tip="Die neueste Version ist bereits installiert.">aktuell</span>}
        {!open && it.latest === null && (
          <span class="badge neutral tip" tabindex={0} data-tip={it.note ? `Die neueste Version konnte nicht ermittelt werden: ${it.note}` : 'Für diesen Eintrag gibt es keine Versionsprüfung.'}>
            nicht prüfbar
          </span>
        )}
        {open && !pending && it.renovatePrs.map((p) => (
          <a key={p.number} class="badge warn tip" data-tip={`Renovate hat dafür schon einen offenen Pull Request: ${p.title}`} href={p.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
            Renovate #{p.number}
          </a>
        ))}
        {open && !pending && it.renovatePrs.map((p) => (p.sourceId ? <ChecksBadge key={`c${p.number}`} status={props.live[`${p.sourceId}:${p.number}`]} /> : null))}
        {it.aiFound && <span class="badge ai tip" data-tip="Von der KI erkannt, nicht von einem Standard-Scan. Bitte stichprobenartig prüfen.">KI</span>}
        {pending && it.update?.prNumber && <ChecksBadge status={props.live[`${it.update.sourceId}:${it.update.prNumber}`]} />}
        {pending && (
          it.update?.prUrl ? (
            <a class="badge ok tip" data-tip="Das Update wurde in Git eingereicht und wartet auf Merge oder Deploy. Klicken öffnet den Pull Request." href={it.update.prUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
              {pending}
            </a>
          ) : (
            <span class="badge ok">{pending}</span>
          )
        )}
      </div>
      <div class="row-action">
        {open && !pending && it.updatable && <UpdateMenu it={it} busy={props.busy} onUpdate={props.onUpdate} />}
        {open && !pending && !it.updatable && (
          <span class="hint tip" data-tip={it.updateHint ?? ''} style={{ textAlign: 'right' }}>
            kein Auto-Update
          </span>
        )}
        {canRollback(it) && (
          <button class="btn" disabled={props.busy} onClick={props.onRollback}>
            Rollback
          </button>
        )}
      </div>
    </div>
  );
}

function Banner(props: { source: Source; aiConnected: boolean; onOpenAi: () => void; reload: () => Promise<void>; notify: (m: string) => void }) {
  const s = props.source;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      props.notify((e as Error).message);
    }
    await props.reload();
  };
  if (s.status === 'failed') {
    const wantsAi = s.scanMode !== 'standard';
    return (
      <section class="banner danger" aria-label="Scan-Status">
        <h2>Scan fehlgeschlagen</h2>
        <p>{s.scanError}</p>
        {s.kind === 'git' && (
          <div class="actions">
            {wantsAi && props.aiConnected && (
              <button class="btn primary" onClick={() => act(() => api('POST', `/api/sources/${s.id}/scan`, { ai: true }))}>Mit KI scannen</button>
            )}
            {wantsAi && !props.aiConnected && (
              <button class="btn primary" onClick={props.onOpenAi}>KI verbinden, um mit KI zu scannen</button>
            )}
            {!wantsAi && (
              <button class="btn" onClick={() => act(() => api('PATCH', `/api/sources/${s.id}`, { scanMode: 'offer' }))}>KI-Fallback für diese Quelle aktivieren</button>
            )}
            <button class="btn" onClick={() => act(() => api('POST', `/api/sources/${s.id}/scan`, {}))}>Erneut versuchen</button>
          </div>
        )}
      </section>
    );
  }
  if (s.status === 'running' || (s.status === 'pending' && s.kind === 'git')) {
    return (
      <section class="banner info" aria-label="Scan-Status">
        <h2>Scan läuft …</h2>
        <p>Die Einträge erscheinen hier, sobald der Scan fertig ist.</p>
      </section>
    );
  }
  if (s.status === 'pending') {
    return (
      <section class="banner info" aria-label="Scan-Status">
        <h2>Warte auf den ersten Bericht des Agents</h2>
        <p>Richte den Agent auf dem Server ein. Die Quelle füllt sich, sobald er sich meldet.</p>
      </section>
    );
  }
  if (s.scannedByAi) {
    return (
      <section class="banner ai" aria-label="Scan-Status">
        <h2>Per KI gescannt</h2>
        <p>Der Standard-Scan hatte nichts gefunden. Die Einträge mit dem Hinweis „KI“ wurden von der KI erkannt. Bitte stichprobenartig prüfen.</p>
      </section>
    );
  }
  return null;
}
