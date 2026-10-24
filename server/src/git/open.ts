import type { AccountRow, Ctx, SourceRow } from '../ctx.js';
import type { Config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { now } from '../db.js';
import { fetchJson } from '../http.js';
import { GitHub, parseGithubUrl } from './github.js';
import { GitLab, parseGitlabUrl } from './gitlab.js';
import { InputError, type GitApi, type RepoRef } from './provider.js';

export type Provider = 'github' | 'gitlab';

/** Erkennt Plattform und Repository aus einer Web-Adresse und liefert die saubere Adresse zurück. */
export function parseRepoUrl(cfg: Config, url: string): { provider: Provider; ref: RepoRef; url: string } {
  let host = '';
  try {
    host = new URL(url.trim()).host;
  } catch {
    throw new InputError('Ungültige Repository-URL.');
  }
  if (host === cfg.gitlabUrl.host) {
    const ref = parseGitlabUrl(url, cfg.gitlabUrl);
    return { provider: 'gitlab', ref, url: `${cfg.gitlabUrl.origin}/${ref.owner}/${ref.repo}` };
  }
  try {
    const ref = parseGithubUrl(url);
    return { provider: 'github', ref, url: `https://github.com/${ref.owner}/${ref.repo}` };
  } catch {
    throw new InputError(`Unterstützt werden GitHub (github.com) und GitLab (${cfg.gitlabUrl.host}). Beispiel: https://github.com/besitzer/repo`);
  }
}

export function providerOf(cfg: Config, src: SourceRow): Provider {
  if (src.provider === 'github' || src.provider === 'gitlab') return src.provider;
  return src.url && new URL(src.url).host === cfg.gitlabUrl.host ? 'gitlab' : 'github';
}

const refreshing = new Map<string, Promise<string>>();

/** Liefert das gültige Zugangstoken eines Kontos. Abgelaufene GitLab-Tokens werden mit dem Refresh-Token erneuert. */
export async function accountToken(ctx: Ctx, acc: AccountRow): Promise<string> {
  const token = decrypt(ctx.key, acc.token_enc);
  if (!acc.expires_at || acc.expires_at - 60_000 > now() || !acc.refresh_enc) return token;
  let p = refreshing.get(acc.id);
  if (!p) {
    p = (async () => {
      const clientId = ctx.cfg.gitlabClientId;
      if (acc.provider !== 'gitlab' || !clientId) throw new Error('Das Zugangstoken ist abgelaufen. Bitte verbinde das Konto neu.');
      const r = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(`${ctx.cfg.gitlabUrl.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: decrypt(ctx.key, acc.refresh_enc as string) }).toString(),
      }).catch(() => {
        throw new Error('Das Zugangstoken ist abgelaufen und ließ sich nicht erneuern. Bitte verbinde das Konto neu.');
      });
      ctx.db
        .prepare('UPDATE accounts SET token_enc = ?, refresh_enc = ?, expires_at = ? WHERE id = ?')
        .run(encrypt(ctx.key, r.access_token), r.refresh_token ? encrypt(ctx.key, r.refresh_token) : acc.refresh_enc, r.expires_in ? now() + r.expires_in * 1000 : null, acc.id);
      return r.access_token;
    })().finally(() => refreshing.delete(acc.id));
    refreshing.set(acc.id, p);
  }
  return p;
}

export function apiFor(cfg: Config, provider: Provider, token: string | undefined): GitApi {
  return provider === 'gitlab' ? new GitLab(cfg.gitlabUrl, token) : new GitHub(token);
}

/** Öffnet den Zugang zu einem Repository: über das verbundene Konto, sonst über den Token der Quelle. */
export async function openRepo(ctx: Ctx, src: SourceRow): Promise<{ api: GitApi; repo: RepoRef; provider: Provider }> {
  const provider = providerOf(ctx.cfg, src);
  let token: string | undefined;
  if (src.account_id) {
    const acc = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(src.account_id) as AccountRow | undefined;
    if (!acc) throw new Error('Das verbundene Konto wurde entfernt. Verbinde es neu oder hinterlege einen Token.');
    token = await accountToken(ctx, acc);
  } else if (src.credential_enc) {
    token = decrypt(ctx.key, src.credential_enc);
  }
  const { ref } = parseRepoUrl(ctx.cfg, src.url ?? '');
  return { api: apiFor(ctx.cfg, provider, token), repo: ref, provider };
}
