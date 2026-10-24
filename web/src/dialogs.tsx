import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api } from './api';
import { ChecksBadge } from './checks';
import { ICON_KEYS, iconLabel, LinkIcon } from './icons';
import type { Item, PrStatus, QuickLink, Section, Settings, Source, SummaryResponse } from './types';
import { BUMP_EXPLAIN, canRollback, fixesCves, KIND_LABEL, pendingLabel } from './util';

export function Modal(props: { label: string; onClose: () => void; top?: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => prev?.focus();
  }, []);
  return (
    <div class={`overlay ${props.top ? 'top' : ''}`}>
      <div
        ref={ref}
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

function Sections(props: { sections: Section[] }) {
  return (
    <>
      {props.sections.map((s) => (
        <div class="section" key={s.title}>
          <h3>{s.title}</h3>
          <p>{s.text}</p>
        </div>
      ))}
    </>
  );
}

const PROVIDER_LABEL = { openai: 'OpenAI', gemini: 'Google Gemini' } as const;

export function DetailDialog(props: {
  item: Item;
  mode: 'badge' | 'item';
  settings: Settings;
  live: Record<string, PrStatus>;
  onClose: () => void;
  onToItem: () => void;
  onUpdate: (to: string) => void;
  onRollback: () => void;
  onOpenAi: () => void;
}) {
  const { item, mode, settings } = props;
  const top = item.candidates[item.candidates.length - 1]?.version ?? item.latest ?? '';
  const [to, setTo] = useState(top);
  useEffect(() => setTo(top), [item.id, top]);
  const level = item.candidates.find((c) => c.version === to)?.level ?? item.bump;
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'item') return;
    let alive = true;
    setSummary(null);
    setError(null);
    api<SummaryResponse>('GET', `/api/items/${item.id}/summary${to ? `?to=${encodeURIComponent(to)}` : ''}`)
      .then((s) => alive && setSummary(s))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [item.id, mode, to, settings.ai.connected]);

  async function askAi() {
    setAiBusy(true);
    setError(null);
    try {
      const r = await api<{ sections: Section[]; provider: string }>('POST', `/api/items/${item.id}/summary/ai${to ? `?to=${encodeURIComponent(to)}` : ''}`);
      setSummary((s) => (s ? { ...s, ai: r, aiConnected: true } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  const pending = pendingLabel(item);
  const worst = item.cves.length > 0;
  return (
    <Modal label="Details zum Eintrag" onClose={props.onClose}>
      <div class="dialog-head">
        <div>
          <h2>{item.name}</h2>
          <p class="hint">
            {item.type} · {item.sourceName}
          </p>
        </div>
        <button class="btn" data-autofocus onClick={props.onClose}>
          Schließen
        </button>
      </div>

      <div class="row-flex">
        <span class="mono">
          {item.current} → {to || '?'}
        </span>
        {level && <span class={`badge ${level}`}>{level}</span>}
        {worst && <span class="badge danger">CVE</span>}
      </div>

      {item.candidates.length > 1 && (
        <div role="group" aria-label="Zielversion wählen" class="row-flex">
          <span class="hint">Zielversion</span>
          {[...item.candidates].reverse().map((c) => (
            <button key={c.version} class="choice" aria-pressed={to === c.version} onClick={() => setTo(c.version)} style={{ minHeight: '36px', padding: '0 12px' }}>
              {c.level} <span class="mono">{c.version}</span>{fixesCves(item, c.version) ? ' · behebt CVE' : ''}
            </button>
          ))}
        </div>
      )}

      {item.candidates.find((c) => c.version === to)?.blocked && (
        <div class="box danger">
          <h3>Hinweis aus deiner Renovate-Konfiguration</h3>
          <p>{item.candidates.find((c) => c.version === to)?.blocked}</p>
        </div>
      )}

      <div class="box">
        <h3>{item.locations.length > 1 ? `Steht an ${item.locations.length} Stellen (wird gemeinsam geändert)` : 'Wo es steht'}</h3>
        {item.locations.map((l) => (
          <div class="loc" key={l.id}>
            <span class="mono">{l.file ?? item.type}</span>
            {l.servers.map((s) => (
              <span class="srv" key={s}>{s}</span>
            ))}
          </div>
        ))}
      </div>

      {mode === 'badge' && (
        <>
          {level && (
            <div class="box">
              <h3>Was bedeutet {level}?</h3>
              <p>{BUMP_EXPLAIN[level]}</p>
            </div>
          )}
          {worst && (
            <div class="box danger">
              <h3>Sicherheitslücke (CVE)</h3>
              {item.cves.map((c) => (
                <p key={c.id}>
                  <strong>{c.id}</strong> ({c.severity}){c.summary ? `: ${c.summary}` : ''}
                  {c.fixed ? ` Behoben ab ${c.fixed}.` : ''}
                </p>
              ))}
            </div>
          )}
          <div>
            <button class="btn outline" onClick={props.onToItem}>
              Zusammenfassung zu diesem Update ansehen
            </button>
          </div>
        </>
      )}

      {mode === 'item' && (
        <>
          {error && <p class="box danger">{error}</p>}
          {!summary && !error && <p class="hint">Lade Zusammenfassung …</p>}
          {summary && (
            <>
              <div class="panel">
                <div class="panel-title">Automatische Zusammenfassung</div>
                <p class="hint">Quellen: {summary.auto.sources.length ? summary.auto.sources.join(', ') : 'keine gefunden'}</p>
                <div>
                  <span class={`badge ${summary.auto.recommendation.level}`} style={{ fontSize: '13px', padding: '4px 10px', borderRadius: '999px' }}>
                    {summary.auto.recommendation.label}
                  </span>
                </div>
                <Sections sections={summary.auto.sections} />
                {summary.auto.excerpt.length > 0 && (
                  <div class="box">
                    <h3>Auszug aus den Release Notes (Englisch)</h3>
                    <p class="pre">{summary.auto.excerpt.join('\n')}</p>
                  </div>
                )}
              </div>

              <div class="panel">
                <div class="panel-title">
                  <span style={{ flexGrow: 1 }}>KI-Zusammenfassung auf Deutsch</span>
                  {settings.ai.connected && settings.ai.provider && <span class="hint">{PROVIDER_LABEL[settings.ai.provider]}</span>}
                </div>
                {!settings.ai.connected && (
                  <>
                    <p class="hint">Optional: Verbinde OpenAI oder Gemini, dann übersetzt und fasst die KI die Angaben oben in einfachem Deutsch zusammen.</p>
                    <div>
                      <button class="btn outline" onClick={props.onOpenAi}>
                        KI verbinden
                      </button>
                    </div>
                  </>
                )}
                {settings.ai.connected && !summary.ai && !aiBusy && (
                  <>
                    <p class="hint">Übersetzt die Release Notes und erklärt in einfachem Deutsch, was neu ist und was du beachten musst.</p>
                    <div>
                      <button class="btn primary" onClick={askAi}>
                        Mit KI zusammenfassen
                      </button>
                    </div>
                  </>
                )}
                {aiBusy && <p class="hint">Die KI liest Release Notes und CVE-Eintrag …</p>}
                {summary.ai && <Sections sections={summary.ai.sections} />}
              </div>
            </>
          )}
        </>
      )}

      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        {item.bump !== '' && !pending && item.updatable && (
          <button class="btn primary" onClick={() => props.onUpdate(to)}>
            Jetzt auf {to} updaten
          </button>
        )}
        {item.bump !== '' && !pending && !item.updatable && item.updateHint && <p class="hint">{item.updateHint}</p>}
        {pending && <span style={{ alignSelf: 'center', fontWeight: 600 }}>{pending}</span>}
        {pending && item.update?.prNumber && <ChecksBadge status={props.live[`${item.update.sourceId}:${item.update.prNumber}`]} />}
        {canRollback(item) && (
          <button class="btn" onClick={props.onRollback}>
            Rollback
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------- Quelle hinzufügen ----------

const SCAN_MODES = [
  { id: 'standard', label: 'Standard-Scan', hint: 'Liest bekannte Dateien (package.json, Dockerfile, values.yaml …). Schlägt er fehl, siehst du die Fehlermeldung.' },
  { id: 'offer', label: 'Standard + KI bei Fehler', hint: 'Wie Standard. Schlägt der Scan fehl, kannst du die KI mit einem Klick versuchen lassen. (Empfohlen)' },
  { id: 'ai', label: 'Nur KI-Scan', hint: 'Die KI liest die Dateien und erkennt Abhängigkeiten selbst. Langsamer und verbraucht API-Aufrufe. Gefundene Einträge lassen sich nicht automatisch updaten.' },
] as const;

const KIND_HINT: Record<Source['kind'], string> = {
  git: 'Erkennt automatisch Dependencies (npm), Dockerfiles sowie Helm-Charts, Compose-Dateien und Images in YAML. Updates kommen als Pull Request oder Commit zurück. Aktuell wird GitHub unterstützt.',
  kubernetes: 'Ein kleiner Agent im Cluster meldet read-only, welche Images laufen. Er verbindet sich ausgehend zu lxnEye, es muss kein Port geöffnet werden.',
  server: 'Installiere den lxnEye-Agent auf dem Server. Er meldet, welche Docker-Container laufen. Es muss kein Port geöffnet werden.',
};

export function AddSourceDialog(props: {
  sources: Source[];
  aiConnected: boolean;
  onOpenAccounts: () => void;
  onClose: () => void;
  onCreated: () => void;
  onOpenAi: () => void;
}) {
  const [kind, setKind] = useState<Source['kind']>('server');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [scanMode, setScanMode] = useState<'standard' | 'offer' | 'ai'>('offer');
  const [linked, setLinked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const gits = props.sources.filter((s) => s.kind === 'git');
  const needsAi = kind === 'git' && scanMode !== 'standard' && !props.aiConnected;
  const canSubmit = name.trim().length > 0 && (kind !== 'git' || url.trim().length > 0) && !busy;
  const origin = location.origin;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ agentToken: string | null }>('POST', '/api/sources', {
        kind,
        name: name.trim(),
        ...(kind === 'git' ? { url: url.trim(), scanMode, ...(token ? { token } : {}) } : { ...(linked ? { linkedSourceId: linked } : {}) }),
      });
      props.onCreated();
      if (r.agentToken) setCreated({ token: r.agentToken, name: name.trim() });
      else props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const cmd1 = `curl -fsSLO ${origin}/agent.mjs`;
    const cmd2 = `LXNEYE_URL=${origin} LXNEYE_TOKEN=${created.token} node agent.mjs`;
    return (
      <Modal label="Agent einrichten" onClose={props.onClose}>
        <div class="dialog-head">
          <div>
            <h2>Agent für „{created.name}“ einrichten</h2>
            <p class="hint">Der Token wird nur jetzt angezeigt. Speichere ihn sicher, später ist er nicht mehr abrufbar.</p>
          </div>
        </div>
        <div class="code">{cmd1}</div>
        <div class="code">{cmd2}</div>
        <p class="hint">
          Auf dem Server wird Node.js 20 oder neuer benötigt. Der Agent liest nur die Container-Liste über den Docker-Socket und sendet sie per HTTPS an lxnEye. Für Dauerbetrieb und Kubernetes siehe README.
        </p>
        <div class="actions" style={{ justifyContent: 'flex-end' }}>
          <button class="btn" onClick={() => navigator.clipboard?.writeText(cmd2)}>
            Befehl kopieren
          </button>
          <button class="btn primary" data-autofocus onClick={props.onClose}>
            Fertig
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal label="Quelle hinzufügen" onClose={props.onClose}>
      <div class="dialog-head">
        <h2>Neue Quelle hinzufügen</h2>
        <button class="btn" onClick={props.onClose}>
          Abbrechen
        </button>
      </div>
      <div role="group" aria-label="Typ der Quelle" class="row-flex">
        {(['server', 'kubernetes', 'git'] as const).map((k) => (
          <button key={k} class="choice" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div class="grid2">
        <label class="field">
          Name
          <input data-autofocus type="text" value={name} maxLength={80} placeholder="z. B. nas-01" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {kind === 'git' && (
          <>
            <label class="field">
              Repository-URL
              <input type="text" value={url} placeholder="https://github.com/nutzer/projekt" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              Zugangstoken (optional, für private Repos)
              <input type="password" autocomplete="off" value={token} placeholder="••••••••" onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
            </label>
          </>
        )}
        {kind !== 'git' && (
          <label class="field">
            Git-Repository für Updates (optional)
            <select value={linked} onChange={(e) => setLinked((e.target as HTMLSelectElement).value)}>
              <option value="">Keines</option>
              {gits.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p class="hint">{KIND_HINT[kind]}</p>
      {kind === 'git' && (
        <div class="box">
          <h3>Besser über ein Konto</h3>
          <p class="hint">Melde dich bei GitHub oder GitLab an und wähle aus der Liste deiner Repositories. Das geht schneller, und private Repos brauchen keinen eigenen Token. Diese Eingabe ist für ein einzelnes Repository per Adresse.</p>
          <div>
            <button class="btn outline" onClick={() => { props.onClose(); props.onOpenAccounts(); }}>Zu den Konten</button>
          </div>
        </div>
      )}
      {kind === 'git' && (
        <p class="hint">
          Token für private Repos: bei GitHub einen <strong>Fine-grained Token</strong> erstellen, genau dieses Repository auswählen und „Contents: Read-only“ erlauben. Für Updates zusätzlich „Contents“ und „Pull requests“ auf „Read and write“. Bei einem klassischen Token reicht der Scope „repo“.
        </p>
      )}
      {kind === 'git' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <strong style={{ fontSize: '13px' }}>Scan-Methode</strong>
          <div role="group" aria-label="Scan-Methode" class="row-flex">
            {SCAN_MODES.map((m) => (
              <button key={m.id} class="choice" aria-pressed={scanMode === m.id} onClick={() => setScanMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <p class="hint">{SCAN_MODES.find((m) => m.id === scanMode)?.hint}</p>
          {needsAi && (
            <div class="row-flex">
              <span class="hint" style={{ color: 'var(--warn-text)' }}>
                Dafür muss eine KI verbunden sein.
              </span>
              <button class="btn outline" onClick={props.onOpenAi}>
                KI verbinden
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p class="box danger">{error}</p>}
      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        <button class="btn primary" disabled={!canSubmit} onClick={submit}>
          {kind === 'git' ? 'Hinzufügen & scannen' : 'Hinzufügen'}
        </button>
      </div>
    </Modal>
  );
}

// ---------- KI verbinden ----------

type TestState = { phase: 'idle' } | { phase: 'testing' } | { phase: 'ok'; models: string[]; defaultModel: string } | { phase: 'error'; message: string };

const DEFAULT_LABEL = { openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' } as const;

export function AiDialog(props: { settings: Settings; onClose: () => void; onChanged: () => void }) {
  const cur = props.settings.ai;
  const [provider, setProvider] = useState<'openai' | 'gemini'>(cur.provider ?? 'openai');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(cur.model ?? '');
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ping, setPing] = useState<{ phase: 'idle' } | { phase: 'running' } | { phase: 'ok'; ms: number; model: string } | { phase: 'error'; message: string }>({ phase: 'idle' });

  // Ein gespeicherter Key gilt nur für denselben Anbieter.
  const storedKeyUsable = cur.connected && cur.provider === provider;

  // Verbindung direkt prüfen: kurz nach dem Tippen des Keys, beim Wechsel des Anbieters und beim Öffnen mit gespeichertem Key.
  useEffect(() => {
    if (key.length < 8 && !(key.length === 0 && storedKeyUsable)) {
      setTest({ phase: 'idle' });
      return;
    }
    let alive = true;
    setTest({ phase: 'testing' });
    const t = window.setTimeout(
      () => {
        api<{ models: string[]; defaultModel: string }>('POST', '/api/settings/ai/test', { provider, ...(key ? { apiKey: key } : {}) })
          .then((r) => alive && setTest({ phase: 'ok', models: r.models, defaultModel: r.defaultModel }))
          .catch((e: Error) => alive && setTest({ phase: 'error', message: e.message }));
      },
      key ? 600 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [provider, key, storedKeyUsable]);

  const models = test.phase === 'ok' ? test.models : [];
  const modelOptions = model && !models.includes(model) ? [model, ...models] : models;
  const canSave = test.phase === 'ok' && !saving;

  // Ergebnis eines früheren Tests gilt nicht mehr, wenn sich Key, Anbieter oder Modell ändern.
  useEffect(() => setPing({ phase: 'idle' }), [provider, key, model]);

  async function runPing() {
    setPing({ phase: 'running' });
    try {
      const r = await api<{ ms: number; model: string }>('POST', '/api/settings/ai/ping', { provider, ...(key ? { apiKey: key } : {}), model });
      setPing({ phase: 'ok', ms: r.ms, model: r.model });
    } catch (e) {
      setPing({ phase: 'error', message: (e as Error).message });
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api('PUT', '/api/settings/ai', { provider, ...(key ? { apiKey: key } : {}), model });
      props.onChanged();
      props.onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function disconnect() {
    await api('DELETE', '/api/settings/ai');
    props.onChanged();
    props.onClose();
  }

  return (
    <Modal label="KI verbinden" onClose={props.onClose} top>
      <div class="dialog-head">
        <h2>KI verbinden</h2>
        <button class="btn" onClick={props.onClose}>
          Abbrechen
        </button>
      </div>
      <div role="group" aria-label="Anbieter" class="row-flex">
        {(['openai', 'gemini'] as const).map((p) => (
          <button
            key={p}
            class="choice"
            aria-pressed={provider === p}
            onClick={() => {
              setProvider(p);
              setKey('');
              setModel(cur.provider === p ? (cur.model ?? '') : '');
            }}
          >
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>
      <label class="field">
        API-Key
        <input
          data-autofocus
          type="password"
          autocomplete="off"
          value={key}
          placeholder={storedKeyUsable ? 'Gespeichert. Zum Ändern neu eingeben.' : provider === 'openai' ? 'sk-…' : 'AIza…'}
          onInput={(e) => setKey((e.target as HTMLInputElement).value.trim())}
        />
      </label>
      <div role="status" aria-live="polite" class="hint" style={{ minHeight: '20px' }}>
        {test.phase === 'testing' && 'Verbindung wird geprüft …'}
        {test.phase === 'ok' && (
          <span style={{ color: 'var(--ok-text)', fontWeight: 600 }}>
            Verbindung erfolgreich. {test.models.length} {test.models.length === 1 ? 'Modell' : 'Modelle'} verfügbar.
          </span>
        )}
        {test.phase === 'error' && <span style={{ color: 'var(--danger-text)', fontWeight: 600 }}>{test.message}</span>}
      </div>
      <label class="field">
        Modell
        <select value={model} disabled={test.phase !== 'ok'} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
          <option value="">Standard ({DEFAULT_LABEL[provider]})</option>
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <div class="row-flex">
        <button class="btn outline" disabled={test.phase !== 'ok' || ping.phase === 'running'} onClick={runPing}>
          {ping.phase === 'running' ? 'Teste …' : 'Modell testen'}
        </button>
        <span role="status" aria-live="polite" class="hint">
          {ping.phase === 'ok' && (
            <span style={{ color: 'var(--ok-text)', fontWeight: 600 }}>
              {ping.model} antwortet in {(ping.ms / 1000).toFixed(1).replace('.', ',')} s.
            </span>
          )}
          {ping.phase === 'error' && <span style={{ color: 'var(--danger-text)', fontWeight: 600 }}>{ping.message}</span>}
          {ping.phase === 'idle' && 'Schickt eine kurze Testanfrage an das gewählte Modell.'}
        </span>
      </div>
      {provider === 'gemini' && /^gemma/i.test(model) && (
        <p class="hint">Gemma kennt keinen JSON-Modus. lxnEye behilft sich damit, die Antwort aus dem Text zu lesen. Bei kleinen Modellen kann das häufiger fehlschlagen.</p>
      )}
      <p class="hint">Der Key wird verschlüsselt auf deinem lxnEye-Server gespeichert und nie wieder an den Browser gesendet. Anfragen an die KI laufen über das Backend.</p>
      {saveError && <p class="box danger">{saveError}</p>}
      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        {cur.connected && (
          <button class="btn danger" onClick={disconnect}>
            Trennen
          </button>
        )}
        <button class="btn primary" disabled={!canSave} onClick={save}>
          Speichern
        </button>
      </div>
    </Modal>
  );
}

// ---------- Quelle bearbeiten / löschen ----------

export function EditSourceDialog(props: { source: Source; sources: Source[]; onClose: () => void; onSaved: () => void }) {
  const src = props.source;
  const [name, setName] = useState(src.name);
  const [url, setUrl] = useState(src.url ?? '');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [scanMode, setScanMode] = useState(src.scanMode);
  const [linked, setLinked] = useState(src.linkedSourceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gits = props.sources.filter((g) => g.kind === 'git' && g.id !== src.id);

  async function save() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {};
    if (name.trim() !== src.name) body.name = name.trim();
    if (src.kind === 'git') {
      if (url.trim() !== (src.url ?? '')) body.url = url.trim();
      if (scanMode !== src.scanMode) body.scanMode = scanMode;
      if (token) body.token = token;
      else if (clearToken) body.token = null;
    } else if (linked !== (src.linkedSourceId ?? '')) {
      body.linkedSourceId = linked || null;
    }
    try {
      if (Object.keys(body).length > 0) await api('PATCH', `/api/sources/${src.id}`, body);
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="Quelle bearbeiten" onClose={props.onClose}>
      <div class="dialog-head">
        <div>
          <h2>Quelle bearbeiten</h2>
          <p class="hint">{KIND_LABEL[src.kind]}</p>
        </div>
        <button class="btn" onClick={props.onClose}>
          Abbrechen
        </button>
      </div>
      <div class="grid2">
        <label class="field">
          Name
          <input data-autofocus type="text" value={name} maxLength={80} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {src.kind === 'git' && (
          <>
            <label class="field">
              Repository-URL
              <input type="text" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              Zugangstoken {src.hasToken ? '(gespeichert, zum Ersetzen neu eingeben)' : '(keiner hinterlegt)'}
              <input type="password" autocomplete="off" value={token} onInput={(e) => { setToken((e.target as HTMLInputElement).value.trim()); setClearToken(false); }} />
            </label>
            <label class="field">
              Scan-Methode
              <select value={scanMode} onChange={(e) => setScanMode((e.target as HTMLSelectElement).value as typeof scanMode)}>
                {SCAN_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {src.kind !== 'git' && (
          <label class="field">
            Git-Repository für Updates
            <select value={linked} onChange={(e) => setLinked((e.target as HTMLSelectElement).value)}>
              <option value="">Keines</option>
              {gits.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {src.kind === 'git' && src.hasToken && (
        <label class="row-flex" style={{ fontSize: '13px' }}>
          <input type="checkbox" checked={clearToken} disabled={!!token} onChange={(e) => setClearToken((e.target as HTMLInputElement).checked)} />
          Gespeicherten Token entfernen
        </label>
      )}
      {src.kind === 'git' && src.accountName && <p class="hint">Zugang über das verbundene Konto <strong>{src.accountName}</strong> ({src.provider === 'gitlab' ? 'GitLab' : 'GitHub'}). Ein hier hinterlegter Token wird in diesem Fall nicht verwendet.</p>}
      {src.kind === 'git' && <p class="hint">Eine geänderte URL oder ein neuer Token startet automatisch einen neuen Scan.</p>}
      {error && <p class="box danger">{error}</p>}
      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        <button class="btn primary" disabled={busy || name.trim().length === 0} onClick={save}>
          Speichern
        </button>
      </div>
    </Modal>
  );
}

export function DeleteSourceDialog(props: { source: Source; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    try {
      await api('DELETE', `/api/sources/${props.source.id}`);
      props.onDeleted();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal label="Quelle löschen" onClose={props.onClose}>
      <h2>„{props.source.name}“ löschen?</h2>
      <p>
        Die Quelle und alle ihre gespeicherten Einträge werden aus lxnEye entfernt. Dein Repository, dein Server und bereits erstellte Pull Requests bleiben unverändert.
      </p>
      {error && <p class="box danger">{error}</p>}
      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        <button class="btn" data-autofocus onClick={props.onClose}>
          Abbrechen
        </button>
        <button class="btn danger" disabled={busy} onClick={remove}>
          Endgültig löschen
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog(props: { title: string; reasons: string[]; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal label={props.title} onClose={props.onCancel} top>
      <h2>{props.title}</h2>
      <div class="box danger">
        {props.reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
      </div>
      <p class="hint">Die Entscheidung liegt bei dir. lxnEye erstellt das Update trotzdem, wenn du bestätigst.</p>
      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        <button class="btn" data-autofocus onClick={props.onCancel}>
          Abbrechen
        </button>
        <button class="btn primary" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Sammel-Update ----------

interface CheckRow {
  id: string;
  name: string;
  to: string | null;
  level: string | null;
  files: string[];
  status: 'ok' | 'error';
  error: string | null;
  warnings: string[];
}
interface BatchRes {
  id: string;
  ok: boolean;
  error?: string;
  prNumber?: number | null;
  prUrl?: string | null;
}

const PRESETS = [
  { id: 'safe', label: 'Nur Patch und Minor', hint: 'Das höchste Patch- oder Minor-Update, Majors werden übersprungen.' },
  { id: 'patch', label: 'Nur Patch', hint: 'Nur reine Fehlerbehebungen.' },
  { id: 'top', label: 'Jeweils das neueste', hint: 'Das höchste verfügbare Ziel, auch Major.' },
] as const;

function presetTarget(it: Item, preset: (typeof PRESETS)[number]['id']): string {
  const c = it.candidates;
  if (preset === 'top') return c[c.length - 1]?.version ?? '';
  const allowed = c.filter((x) => (preset === 'patch' ? x.level === 'Patch' : x.level !== 'Major'));
  return allowed[allowed.length - 1]?.version ?? '';
}

export function BatchDialog(props: { items: Item[]; mode: 'pr' | 'commit'; preset?: 'patch'; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.items.map((i) => [i.id, props.preset ? presetTarget(i, props.preset) : (i.candidates[i.candidates.length - 1]?.version ?? '')])),
  );
  const [bundle, setBundle] = useState(true);
  const [check, setCheck] = useState<{ rows: Record<string, CheckRow>; shared: { file: string; names: string[] }[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<'edit' | 'running' | 'done'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchRes[] | null>(null);

  const chosen = props.items.filter((i) => choice[i.id]);

  // Auswahl vorab prüfen, sobald sich etwas ändert
  useEffect(() => {
    if (chosen.length === 0) {
      setCheck({ rows: {}, shared: [] });
      return;
    }
    let alive = true;
    setChecking(true);
    const t = window.setTimeout(() => {
      api<{ results: CheckRow[]; shared: { file: string; names: string[] }[] }>('POST', '/api/updates/check', { items: chosen.map((i) => ({ id: i.id, to: choice[i.id] })) })
        .then((r) => alive && setCheck({ rows: Object.fromEntries(r.results.map((x) => [x.id, x])), shared: r.shared }))
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setChecking(false));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [JSON.stringify(choice)]);

  const rows = chosen.map((i) => check?.rows[i.id]).filter((r): r is CheckRow => !!r);
  const okRows = rows.filter((r) => r.status === 'ok');
  const warned = okRows.filter((r) => r.warnings.length > 0);
  const canRun = !checking && okRows.length > 0 && (warned.length === 0 || ack) && phase === 'edit';
  const sharedFiles = check?.shared ?? [];

  async function run() {
    setPhase('running');
    setError(null);
    try {
      const r = await api<{ results: BatchRes[] }>('POST', '/api/updates/batch', { items: okRows.map((x) => ({ id: x.id, to: x.to ?? undefined })), bundle });
      setResults(r.results);
      setPhase('done');
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
      setPhase('edit');
    }
  }

  const byId = new Map(props.items.map((i) => [i.id, i]));
  if (phase === 'done' && results) {
    const ok = results.filter((r) => r.ok);
    const prs = [...new Map(ok.filter((r) => r.prNumber).map((r) => [r.prNumber, r.prUrl])).entries()];
    return (
      <Modal label="Sammel-Update fertig" onClose={props.onClose}>
        <h2>{ok.length} von {results.length} Updates {props.mode === 'pr' ? 'eingereicht' : 'committet'}</h2>
        {prs.length > 0 && (
          <p>
            Pull {prs.length === 1 ? 'Request' : 'Requests'}:{' '}
            {prs.map(([n, url]) => (
              <a key={n} href={url ?? '#'} target="_blank" rel="noopener noreferrer" style={{ marginRight: '8px' }}>#{n}</a>
            ))}
          </p>
        )}
        <div class="box">
          {results.map((r) => (
            <div class="loc" key={r.id}>
              <span class={`badge ${r.ok ? 'ok' : 'danger'}`}>{r.ok ? 'ok' : 'Fehler'}</span>
              <strong>{byId.get(r.id)?.name}</strong>
              {r.error && <span class="hint">{r.error}</span>}
            </div>
          ))}
        </div>
        <div class="actions" style={{ justifyContent: 'flex-end' }}>
          <button class="btn primary" data-autofocus onClick={props.onClose}>Fertig</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal label="Sammel-Update" onClose={props.onClose}>
      <div class="dialog-head">
        <div>
          <h2>{props.items.length} Einträge updaten</h2>
          <p class="hint">Wähle je Eintrag die Zielversion. lxnEye prüft vorab, ob alles zusammen geht, und ändert erst nach deiner Bestätigung etwas.</p>
        </div>
        <button class="btn" data-autofocus onClick={props.onClose}>Abbrechen</button>
      </div>

      <div class="row-flex">
        <span class="hint">Für alle:</span>
        {PRESETS.map((p) => (
          <button key={p.id} class="btn small" title={p.hint} onClick={() => setChoice(Object.fromEntries(props.items.map((i) => [i.id, presetTarget(i, p.id)])))}>
            {p.label}
          </button>
        ))}
      </div>

      <div class="box" style={{ padding: 0, gap: 0, maxHeight: '45vh', overflow: 'auto' }}>
        {props.items.map((i) => {
          const r = check?.rows[i.id];
          const sel = choice[i.id] ?? '';
          return (
            <div key={i.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div class="row-flex" style={{ gap: '8px 12px' }}>
                <strong style={{ flex: '1 1 160px', overflowWrap: 'anywhere' }}>{i.name}</strong>
                <span class="mono hint">{i.current} →</span>
                <select class="compact" aria-label={`Zielversion für ${i.name}`} value={sel} style={{ minHeight: '36px', maxWidth: '220px' }} onChange={(e) => setChoice({ ...choice, [i.id]: (e.target as HTMLSelectElement).value })}>
                  <option value="">nicht updaten</option>
                  {[...i.candidates].reverse().map((c) => (
                    <option key={c.version} value={c.version}>
                      {c.level} {c.version}{fixesCves(i, c.version) ? ' · behebt CVE' : ''}{c.blocked ? ' ⚠' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {sel && (
                <div class="hint" style={{ minHeight: '18px' }}>
                  {!r && checking && 'Prüfe …'}
                  {r?.status === 'ok' && (
                    <span style={{ color: 'var(--ok-text)', fontWeight: 600 }}>
                      Bereit · {r.files.length} {r.files.length === 1 ? 'Datei' : 'Dateien'}
                    </span>
                  )}
                  {r?.status === 'error' && <span style={{ color: 'var(--danger-text)', fontWeight: 600 }}>{r.error}</span>}
                  {r?.status === 'ok' && r.warnings.map((w) => (
                    <div key={w} style={{ color: 'var(--warn-text)' }}>⚠ {w}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sharedFiles.length > 0 && (
        <div class="box">
          <h3>Gemeinsame Dateien</h3>
          {sharedFiles.map((f) => (
            <p key={f.file} class="hint">
              <span class="mono">{f.file}</span>: {f.names.join(', ')}. Getrennte Pull Requests können sich beim Mergen in die Quere kommen, gebündelt passt alles zusammen.
            </p>
          ))}
        </div>
      )}

      <label class="row-flex" style={{ fontSize: '14px' }}>
        <input type="checkbox" checked={bundle} onChange={(e) => setBundle((e.target as HTMLInputElement).checked)} />
        {props.mode === 'pr' ? 'Alles in einem Pull Request bündeln (empfohlen)' : 'Änderungen an derselben Datei gemeinsam schreiben (empfohlen)'}
      </label>
      {!bundle && props.mode === 'pr' && <p class="hint">Jeder Eintrag bekommt einen eigenen Pull Request.</p>}

      {warned.length > 0 && (
        <label class="row-flex" style={{ fontSize: '14px', color: 'var(--warn-text)' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck((e.target as HTMLInputElement).checked)} />
          Ich habe die Hinweise gelesen und möchte trotzdem updaten ({warned.length})
        </label>
      )}
      {rows.some((r) => r.status === 'error') && <p class="hint">Einträge mit Fehler werden übersprungen, die übrigen laufen durch.</p>}
      {error && <p class="box danger">{error}</p>}

      <div class="actions" style={{ justifyContent: 'flex-end' }}>
        <button class="btn primary" disabled={!canRun} onClick={run}>
          {phase === 'running' ? 'Läuft …' : checking ? 'Prüfe …' : `${okRows.length} ${okRows.length === 1 ? 'Update' : 'Updates'} ausführen`}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Schnellnavigation ----------

export function LinkDialog(props: { link: QuickLink | null; onClose: () => void; onSaved: () => void }) {
  const cur = props.link;
  const [title, setTitle] = useState(cur?.title ?? '');
  const [url, setUrl] = useState(cur?.url ?? '');
  const [iconKey, setIconKey] = useState(cur && ICON_KEYS.includes(cur.icon.replace(/^i:/, '')) ? cur.icon.replace(/^i:/, '') : 'link');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const icon = `i:${iconKey}`;
  const looksValid = /^https?:\/\/\S+$/i.test(url.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { title: title.trim(), url: url.trim(), icon };
      if (cur) await api('PATCH', `/api/links/${cur.id}`, body);
      else await api('POST', '/api/links', body);
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function remove() {
    if (!cur) return;
    setBusy(true);
    try {
      await api('DELETE', `/api/links/${cur.id}`);
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal label={cur ? 'Link bearbeiten' : 'Link hinzufügen'} onClose={props.onClose}>
      <div class="dialog-head">
        <h2>{cur ? 'Link bearbeiten' : 'Link hinzufügen'}</h2>
        <button class="btn" onClick={props.onClose}>
          Abbrechen
        </button>
      </div>
      <div class="grid2">
        <label class="field">
          Name
          <input data-autofocus type="text" value={title} maxLength={40} placeholder="z. B. Grafana" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          Adresse
          <input type="url" value={url} placeholder="https://grafana.example.com" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {url && !looksValid && <p class="hint" style={{ color: 'var(--warn-text)' }}>Die Adresse muss mit http:// oder https:// beginnen.</p>}

      <fieldset class="icon-picker">
        <legend>Symbol</legend>
        <div class="icon-grid" role="radiogroup" aria-label="Symbol wählen">
          {ICON_KEYS.map((k) => (
            <button key={k} role="radio" aria-checked={iconKey === k} aria-label={iconLabel(k)} title={iconLabel(k)} class="icon-btn" onClick={() => setIconKey(k)}>
              <LinkIcon icon={`i:${k}`} size={20} />
            </button>
          ))}
        </div>
      </fieldset>

      <div class="row-flex">
        <span class="hint">Vorschau:</span>
        <span class="quick-preview">
          <LinkIcon icon={icon} /> {title.trim() || 'Name'}
        </span>
      </div>
      {error && <p class="box danger">{error}</p>}
      <div class="actions" style={{ justifyContent: 'space-between' }}>
        <div class="actions">
          {cur && !confirmDelete && (
            <button class="btn danger" onClick={() => setConfirmDelete(true)}>
              Löschen
            </button>
          )}
          {cur && confirmDelete && (
            <button class="btn danger" disabled={busy} onClick={remove}>
              Wirklich löschen
            </button>
          )}
        </div>
        <button class="btn primary" disabled={busy || !title.trim() || !looksValid} onClick={save}>
          Speichern
        </button>
      </div>
    </Modal>
  );
}
