export type Bump = 'Major' | 'Minor' | 'Patch' | '';

export interface Candidate {
  level: 'Patch' | 'Minor' | 'Major';
  version: string;
  /** Grund, falls eine Renovate-Regel des Repositories dieses Update sperrt */
  blocked?: string;
}

export interface Cve {
  id: string;
  severity: string;
  summary: string;
  fixed: string | null;
}

export interface Source {
  id: string;
  kind: 'git' | 'server' | 'kubernetes';
  name: string;
  url: string | null;
  scanMode: 'standard' | 'offer' | 'ai';
  status: 'pending' | 'ok' | 'failed' | 'running';
  scanError: string | null;
  scannedByAi: boolean;
  linkedSourceId: string | null;
  provider: 'github' | 'gitlab';
  accountId: string | null;
  accountName: string | null;
  hasToken: boolean;
  lastScanAt: number | null;
  meta: Record<string, unknown>;
  counts: { total: number; outdated: number; cve: number };
}

export interface UpdateInfo {
  id: string;
  status: 'open' | 'merged' | 'closed' | 'committed' | 'reverted' | 'failed';
  mode: 'pr' | 'commit';
  kind: 'update' | 'rollback';
  sourceId: string;
  prNumber: number | null;
  prUrl: string | null;
  toVersion: string;
  createdAt: number;
}

export interface Item {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  type: string;
  ecosystem: 'npm' | 'docker' | 'helm' | 'github' | 'other';
  file: string | null;
  current: string;
  latest: string | null;
  /** Warum die neueste Version nicht ermittelt werden konnte */
  note: string | null;
  bump: Bump;
  /** mögliche Update-Ziele je Stufe (Patch, Minor, Major), das höchste zuletzt */
  candidates: Candidate[];
  cves: Cve[];
  aiFound: boolean;
  /** Offene Renovate-Pull-Requests für dieses Paket */
  renovatePrs: { number: number; title: string; url: string; sourceId: string | null }[];
  /** Server, auf denen es läuft (aus Argo-CD-Apps oder Ordnernamen) */
  servers: string[];
  /** Alle Stellen (Dateien), an denen diese Version steht */
  locations: { id: string; file: string | null; servers: string[] }[];
  updatable: boolean;
  updateHint: string | null;
  update: UpdateInfo | null;
}

export interface Section {
  title: string;
  text: string;
}

export interface SummaryResponse {
  auto: {
    recommendation: { label: string; level: 'danger' | 'warn' | 'ok' };
    sections: Section[];
    excerpt: string[];
    sources: string[];
  };
  ai: { sections: Section[]; provider: string } | null;
  aiConnected: boolean;
}

export interface Settings {
  updateMode: 'pr' | 'commit';
  ai: { connected: boolean; provider?: 'openai' | 'gemini'; model?: string };
}

export interface SessionInfo {
  authenticated: boolean;
  user?: { email: string | null; name: string | null };
  csrf?: string;
  devAuth?: boolean;
}

export interface QuickLink {
  id: string;
  title: string;
  url: string;
  icon: string;
}

/** Live-Zustand eines Pull Requests: ob er noch offen ist und ob die Prüfungen (CI/CD) bestanden haben */
export interface PrStatus {
  state: 'open' | 'merged' | 'closed';
  checks: 'success' | 'failure' | 'pending' | 'none' | 'unknown';
  total: number;
  failed: string[];
  running: number;
}

export interface Account {
  id: string;
  provider: 'github' | 'gitlab';
  host: string;
  login: string;
  name: string | null;
  via: 'device' | 'token';
  scope: string | null;
  createdAt: number;
  expiresAt: number | null;
  watched: number;
}

export interface ProviderInfo {
  id: 'github' | 'gitlab';
  label: string;
  host: string;
  deviceFlow: boolean;
}

export interface RemoteRepo {
  fullName: string;
  url: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  defaultBranch: string | null;
  description: string | null;
  pushedAt: string | null;
  watchedSourceId: string | null;
  viaAccount: boolean;
}
