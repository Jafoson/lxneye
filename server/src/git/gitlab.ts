import { fetchJson, HttpError, safeFetch } from '../http.js';
import { InputError, type GitApi, type RemoteRepo, type RepoRef, type TreeEntry } from './provider.js';

const enc = encodeURIComponent;

export function parseGitlabUrl(url: string, base: URL): RepoRef {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new InputError('Ungültige Repository-URL.');
  }
  if (u.host !== base.host) throw new InputError(`Diese Adresse gehört nicht zu ${base.host}.`);
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => !/^[\w.-]+$/.test(p)) || parts.includes('-')) {
    throw new InputError(`URL muss die Form ${base.origin}/gruppe/projekt haben.`);
  }
  return { owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] as string };
}

/** GitLab-API (v4), gitlab.com oder selbst gehostet. */
export class GitLab implements GitApi {
  constructor(
    private base: URL,
    private token: string | undefined,
  ) {}

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private u(path: string): string {
    return `${this.base.origin}/api/v4${path}`;
  }

  private pid(r: RepoRef): string {
    return enc(`${r.owner}/${r.repo}`);
  }

  private async json<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      return await fetchJson<T>(url, {
        method: init.method,
        headers: { ...this.headers(), ...(init.body ? { 'content-type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) throw new Error('GitLab lehnt den Zugangstoken ab (401). Er ist ungültig oder abgelaufen.');
        if (err.status === 403) throw new Error('GitLab verweigert den Zugriff (403). Fehlen Rechte (Scope api) oder ist das Rate-Limit erreicht?');
        if (err.status === 404) throw new Error('Projekt oder Datei nicht gefunden (404). Bei privaten Projekten fehlt evtl. der Zugang.');
        if (err.status === 400 || err.status === 409) throw new Error(`GitLab hat die Anfrage abgelehnt: ${(/"message":\s*"?([^"}]+)/.exec(err.body ?? '')?.[1] ?? String(err.status)).slice(0, 200)}`);
      }
      throw err;
    }
  }

  async me(): Promise<{ login: string; name: string | null }> {
    const u = await this.json<{ username: string; name?: string }>(this.u('/user'));
    return { login: u.username, name: u.name ?? null };
  }

  async listRepos(): Promise<RemoteRepo[]> {
    const out: RemoteRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<
        { path_with_namespace: string; web_url: string; visibility: string; archived?: boolean; default_branch?: string | null; description?: string | null; last_activity_at?: string; forked_from_project?: unknown }[]
      >(this.u(`/projects?membership=true&per_page=100&order_by=last_activity_at&sort=desc&page=${page}`));
      for (const p of batch) {
        out.push({
          fullName: p.path_with_namespace,
          url: p.web_url,
          private: p.visibility !== 'public',
          archived: !!p.archived,
          fork: !!p.forked_from_project,
          defaultBranch: p.default_branch ?? null,
          description: p.description ?? null,
          pushedAt: p.last_activity_at ?? null,
        });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  async defaultBranch(r: RepoRef): Promise<string> {
    const p = await this.json<{ default_branch: string | null }>(this.u(`/projects/${this.pid(r)}`));
    if (!p.default_branch) throw new Error('Das Projekt hat noch keinen Standard-Branch (leeres Repository?).');
    return p.default_branch;
  }

  async tree(r: RepoRef, branch: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.json<{ path: string; type: string }[]>(this.u(`/projects/${this.pid(r)}/repository/tree?recursive=true&per_page=100&ref=${enc(branch)}&page=${page}`));
      out.push(...batch.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, type: 'blob' })));
      if (batch.length < 100) break;
    }
    return out;
  }

  async file(r: RepoRef, path: string, ref: string): Promise<{ content: string; sha: string }> {
    const f = await this.json<{ content: string; encoding: string; last_commit_id: string }>(this.u(`/projects/${this.pid(r)}/repository/files/${enc(path)}?ref=${enc(ref)}`));
    if (f.encoding !== 'base64') throw new Error(`Unerwartete Kodierung für ${path}`);
    return { content: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.last_commit_id };
  }

  async branchSha(r: RepoRef, branch: string): Promise<string> {
    return (await this.json<{ commit: { id: string } }>(this.u(`/projects/${this.pid(r)}/repository/branches/${enc(branch)}`))).commit.id;
  }

  async createBranch(r: RepoRef, name: string, fromSha: string): Promise<void> {
    await this.json(this.u(`/projects/${this.pid(r)}/repository/branches?branch=${enc(name)}&ref=${enc(fromSha)}`), { method: 'POST' });
  }

  async deleteBranch(r: RepoRef, name: string): Promise<void> {
    const res = await safeFetch(this.u(`/projects/${this.pid(r)}/repository/branches/${enc(name)}`), { method: 'DELETE', headers: this.headers() });
    if (res.status !== 204 && res.status !== 404) throw new Error(`Branch konnte nicht gelöscht werden (${res.status}).`);
  }

  async putFile(r: RepoRef, path: string, o: { message: string; content: string; sha: string; branch: string }): Promise<string> {
    await this.json(this.u(`/projects/${this.pid(r)}/repository/files/${enc(path)}`), {
      method: 'PUT',
      body: { branch: o.branch, commit_message: o.message, content: Buffer.from(o.content, 'utf8').toString('base64'), encoding: 'base64' },
    });
    return this.branchSha(r, o.branch);
  }

  async createPr(r: RepoRef, o: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }> {
    const mr = await this.json<{ iid: number; web_url: string }>(this.u(`/projects/${this.pid(r)}/merge_requests`), {
      method: 'POST',
      body: { source_branch: o.head, target_branch: o.base, title: o.title, description: o.body, remove_source_branch: true },
    });
    return { number: mr.iid, url: mr.web_url };
  }

  async pr(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean }> {
    const h = await this.prHead(r, n);
    return { state: h.state, merged: h.merged };
  }

  async prHead(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean; sha: string }> {
    const mr = await this.json<{ state: string; sha: string }>(this.u(`/projects/${this.pid(r)}/merge_requests/${n}`));
    return { state: mr.state === 'opened' ? 'open' : 'closed', merged: mr.state === 'merged', sha: mr.sha };
  }

  async closePr(r: RepoRef, n: number): Promise<void> {
    await this.json(this.u(`/projects/${this.pid(r)}/merge_requests/${n}`), { method: 'PUT', body: { state_event: 'close' } });
  }

  /** GitLab kennt Pipelines statt einzelner Check-Runs: die neueste Pipeline des Commits zählt. */
  async checks(r: RepoRef, sha: string): Promise<{ runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[]; restricted: boolean }> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('Ungültiger Commit');
    try {
      const pipes = await this.json<{ id: number; status: string }[]>(this.u(`/projects/${this.pid(r)}/pipelines?sha=${sha}&per_page=1`));
      const p = pipes[0];
      if (!p) return { runs: [], statuses: [], restricted: false };
      const done: Record<string, string> = { success: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped', manual: 'neutral' };
      const conclusion = done[p.status];
      return { runs: [{ name: `Pipeline #${p.id}`, status: conclusion ? 'completed' : 'in_progress', conclusion: conclusion ?? null }], statuses: [], restricted: false };
    } catch (e) {
      if (/\(40[34]\)/.test((e as Error).message)) return { runs: [], statuses: [], restricted: true };
      throw e;
    }
  }

  async renovatePrs(r: RepoRef): Promise<{ number: number; title: string; url: string; branch: string }[]> {
    const mrs = await this.json<{ iid: number; title: string; web_url: string; source_branch: string; author?: { username?: string } }[]>(
      this.u(`/projects/${this.pid(r)}/merge_requests?state=opened&per_page=100`),
    );
    return mrs
      .filter((m) => m.source_branch.startsWith('renovate/') || /^renovate/i.test(m.author?.username ?? ''))
      .map((m) => ({ number: m.iid, title: m.title, url: m.web_url, branch: m.source_branch }));
  }

  async diagnose(r: RepoRef): Promise<string> {
    const name = `${r.owner}/${r.repo}`;
    if (!this.token) return `${name} wurde nicht gefunden. Bei privaten Projekten brauchst du ein verbundenes Konto oder einen Zugangstoken.`;
    try {
      const me = await this.me();
      return `Der Zugang (Konto ${me.login}) ist gültig, hat aber keinen Zugriff auf ${name}. Prüfe die Mitgliedschaft im Projekt und den Scope "api" (bzw. "read_api" zum Lesen) und die Schreibweise der URL.`;
    } catch {
      return 'GitLab lehnt den Zugangstoken ab: Er ist ungültig oder abgelaufen. Verbinde das Konto neu.';
    }
  }
}
