import { fetchJson, HttpError, safeFetch } from '../http.js';
import { InputError, type GitApi, type RemoteRepo, type RepoRef } from './provider.js';

export { InputError, type RepoRef };

export function parseGithubUrl(url: string): RepoRef {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new InputError('Ungültige Repository-URL.');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') {
    throw new InputError('Diese Version unterstützt nur GitHub-Repositories (https://github.com/besitzer/repo).');
  }
  const m = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) throw new InputError('URL muss die Form https://github.com/besitzer/repo haben.');
  return { owner: m[1] as string, repo: m[2] as string };
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export class GitHub implements GitApi {
  constructor(private token: string | undefined) {}

  private headers(): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private url(r: RepoRef, path: string): string {
    return `https://api.github.com/repos/${r.owner}/${r.repo}${path}`;
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
        if (err.status === 401) throw new Error('GitHub lehnt den Zugangstoken ab (401).');
        if (err.status === 403) throw new Error('GitHub verweigert den Zugriff (403). Fehlen Rechte oder ist das Rate-Limit erreicht?');
        if (err.status === 404) throw new Error('Repository oder Datei nicht gefunden (404). Bei privaten Repos fehlt evtl. der Token.');
        if (err.status === 422) throw new Error(`GitHub hat die Anfrage abgelehnt: ${err.body?.slice(0, 200) ?? '422'}`);
      }
      throw err;
    }
  }

  /** Erklärt, warum ein Repository nicht erreichbar ist (Token fehlt, ungültig oder ohne Zugriff). */
  async diagnose(r: RepoRef): Promise<string> {
    const name = `${r.owner}/${r.repo}`;
    if (!this.token) {
      return `${name} wurde nicht gefunden. Wenn das Repository privat ist, hinterlege einen Zugangstoken (unter "Quelle verwalten").`;
    }
    let login: string | null = null;
    try {
      const me = await fetchJson<{ login: string }>('https://api.github.com/user', { headers: this.headers() });
      login = me.login;
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        return 'GitHub lehnt den Zugangstoken ab: Er ist ungültig, abgelaufen oder widerrufen. Erstelle einen neuen Token und hinterlege ihn unter "Quelle verwalten".';
      }
      if (err instanceof HttpError && err.status === 403) {
        return 'GitHub verweigert den Zugriff (403). Das Rate-Limit ist erreicht, oder die Organisation blockiert den Token.';
      }
    }
    return (
      `Der Token${login ? ` (Konto ${login})` : ''} ist gültig, hat aber keinen Zugriff auf ${name}. ` +
      'Fine-grained Token: unter "Repository access" genau dieses Repository auswählen und "Contents: Read-only" erlauben (für Updates zusätzlich "Contents" und "Pull requests" auf "Read and write"). ' +
      'Gehört das Repo einer Organisation, muss die Organisation den Token freigeben. Klassischer Token: Scope "repo". ' +
      `Prüfe außerdem die Schreibweise der URL (${name}).`
    );
  }

  async me(): Promise<{ login: string; name: string | null }> {
    const u = await this.json<{ login: string; name: string | null }>('https://api.github.com/user');
    return { login: u.login, name: u.name };
  }

  /** Alle Repositories, auf die der Zugang zugreift: eigene, als Mitarbeiter und über Organisationen. */
  async listRepos(): Promise<RemoteRepo[]> {
    const out: RemoteRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json<
        { full_name: string; html_url: string; private: boolean; archived: boolean; fork: boolean; default_branch: string | null; description: string | null; pushed_at: string | null }[]
      >(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
      for (const p of batch) {
        out.push({ fullName: p.full_name, url: p.html_url, private: p.private, archived: p.archived, fork: p.fork, defaultBranch: p.default_branch, description: p.description, pushedAt: p.pushed_at });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  async defaultBranch(r: RepoRef): Promise<string> {
    return (await this.json<{ default_branch: string }>(this.url(r, ''))).default_branch;
  }

  async tree(r: RepoRef, branch: string): Promise<TreeEntry[]> {
    const t = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(
      this.url(r, `/git/trees/${encodeURIComponent(branch)}?recursive=1`),
    );
    return t.tree.filter((e) => e.type === 'blob');
  }

  async file(r: RepoRef, path: string, ref: string): Promise<{ content: string; sha: string }> {
    const f = await this.json<{ content: string; sha: string; encoding: string }>(
      this.url(r, `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`),
    );
    if (f.encoding !== 'base64') throw new Error(`Unerwartete Kodierung für ${path}`);
    return { content: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
  }

  async branchSha(r: RepoRef, branch: string): Promise<string> {
    return (await this.json<{ object: { sha: string } }>(this.url(r, `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`))).object.sha;
  }

  async createBranch(r: RepoRef, name: string, fromSha: string): Promise<void> {
    await this.json(this.url(r, '/git/refs'), { method: 'POST', body: { ref: `refs/heads/${name}`, sha: fromSha } });
  }

  async deleteBranch(r: RepoRef, name: string): Promise<void> {
    const res = await safeFetch(this.url(r, `/git/refs/heads/${name.split('/').map(encodeURIComponent).join('/')}`), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status !== 204 && res.status !== 422 && res.status !== 404) throw new Error(`Branch konnte nicht gelöscht werden (${res.status}).`);
  }

  async putFile(
    r: RepoRef,
    path: string,
    o: { message: string; content: string; sha: string; branch: string },
  ): Promise<string> {
    const res = await this.json<{ commit: { sha: string } }>(
      this.url(r, `/contents/${path.split('/').map(encodeURIComponent).join('/')}`),
      {
        method: 'PUT',
        body: { message: o.message, content: Buffer.from(o.content, 'utf8').toString('base64'), sha: o.sha, branch: o.branch },
      },
    );
    return res.commit.sha;
  }

  async createPr(r: RepoRef, o: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }> {
    const pr = await this.json<{ number: number; html_url: string }>(this.url(r, '/pulls'), { method: 'POST', body: o });
    return { number: pr.number, url: pr.html_url };
  }

  async pr(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean }> {
    const pr = await this.json<{ state: 'open' | 'closed'; merged: boolean }>(this.url(r, `/pulls/${n}`));
    return { state: pr.state, merged: pr.merged };
  }

  /** Zustand eines Pull Requests samt Commit des Branches (für die Prüfläufe). */
  async prHead(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean; sha: string }> {
    const pr = await this.json<{ state: 'open' | 'closed'; merged: boolean; head: { sha: string } }>(this.url(r, `/pulls/${n}`));
    return { state: pr.state, merged: pr.merged, sha: pr.head.sha };
  }

  /** Prüfläufe und Commit-Status. `restricted`, wenn der Token sie nicht lesen darf. */
  async checks(r: RepoRef, sha: string): Promise<{ runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[]; restricted: boolean }> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('Ungültiger Commit');
    let restricted = false;
    const runs = await this.json<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(this.url(r, `/commits/${sha}/check-runs?per_page=100`)).then(
      (x) => x.check_runs,
      (e: Error) => {
        if (/\(40[34]\)|403|404/.test(e.message)) restricted = true;
        else throw e;
        return [];
      },
    );
    const statuses = await this.json<{ statuses: { context: string; state: string }[] }>(this.url(r, `/commits/${sha}/status`)).then(
      (x) => x.statuses,
      (e: Error) => {
        if (/\(40[34]\)|403|404/.test(e.message)) restricted = true;
        else throw e;
        return [];
      },
    );
    return { runs, statuses, restricted };
  }

  async closePr(r: RepoRef, n: number): Promise<void> {
    await this.json(this.url(r, `/pulls/${n}`), { method: 'PATCH', body: { state: 'closed' } });
  }

  /** Offene Pull Requests, die von Renovate stammen (Bot-Konto oder Branch `renovate/…`). */
  async renovatePrs(r: RepoRef): Promise<{ number: number; title: string; url: string; branch: string }[]> {
    const prs = await this.json<{ number: number; title: string; html_url: string; head: { ref: string }; user?: { login?: string } }[]>(
      this.url(r, '/pulls?state=open&per_page=100'),
    );
    return prs
      .filter((p) => p.head.ref.startsWith('renovate/') || /^renovate/i.test(p.user?.login ?? ''))
      .map((p) => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head.ref }));
  }

  async releaseNotes(r: RepoRef, version: string): Promise<string | null> {
    for (const tag of [`v${version}`, version]) {
      try {
        const rel = await this.json<{ body?: string }>(this.url(r, `/releases/tags/${encodeURIComponent(tag)}`));
        if (rel.body) return rel.body;
      } catch {
        /* nächster Versuch */
      }
    }
    return null;
  }
}
