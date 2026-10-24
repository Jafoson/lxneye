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
