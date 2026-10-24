import type { Config } from './config.js';
import type { Db } from './db.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  /** Schlüssel für gespeicherte Geheimnisse (AES-256-GCM) */
  key: Buffer;
}

export interface SourceRow {
  id: string;
  kind: 'git' | 'server' | 'kubernetes';
  name: string;
  url: string | null;
  scan_mode: 'standard' | 'offer' | 'ai';
  credential_enc: string | null;
  agent_token_hash: string | null;
  linked_source_id: string | null;
  status: 'pending' | 'ok' | 'failed' | 'running';
  scan_error: string | null;
  scanned_by_ai: number;
  /** 'github' | 'gitlab' (leer = aus der URL ableiten) */
  provider: string | null;
  /** verbundenes Konto, dessen Zugang genutzt wird */
  account_id: string | null;
  meta: string;
  last_scan_at: number | null;
  created_at: number;
}

export interface ItemRow {
  id: string;
  source_id: string;
  key: string;
  name: string;
  type: string;
  ecosystem: 'npm' | 'docker' | 'helm' | 'github' | 'other';
  file: string | null;
  current: string;
  latest: string | null;
  bump: 'Major' | 'Minor' | 'Patch' | '';
  cves: string;
  locator: string | null;
  image: string | null;
  ai_found: number;
  /** JSON: [{level, version}] mögliche Update-Ziele je Stufe */
  candidates: string;
  /** kommagetrennt: Server, auf dem die Stelle ausgerollt wird (aus Argo-CD-Apps / Pfad) */
  server: string | null;
  /** Warum die neueste Version nicht ermittelt werden konnte */
  note: string | null;
  updated_at: number;
}

export interface UpdateRow {
  id: string;
  item_id: string;
  target_source_id: string;
  kind: 'update' | 'rollback';
  parent_id: string | null;
  group_id: string | null;
  mode: 'pr' | 'commit';
  file: string;
  from_version: string;
  to_version: string;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  commit_sha: string | null;
  status: 'open' | 'merged' | 'closed' | 'committed' | 'reverted' | 'failed';
  error: string | null;
  actor: string | null;
  created_at: number;
}

export interface AccountRow {
  id: string;
  provider: 'github' | 'gitlab';
  host: string;
  login: string;
  display_name: string | null;
  token_enc: string;
  refresh_enc: string | null;
  expires_at: number | null;
  scope: string | null;
  via: 'device' | 'token';
  created_at: number;
}
