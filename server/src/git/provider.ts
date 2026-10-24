/** Gemeinsame Schnittstelle für Git-Plattformen. GitHub und GitLab implementieren sie. */

export interface RepoRef {
  /** GitHub: Besitzer. GitLab: Namensraum, ggf. mit Untergruppen (gruppe/untergruppe) */
  owner: string;
  repo: string;
}

export class InputError extends Error {}

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
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
}

export interface GitApi {
  /** Wer ist mit dem Zugang angemeldet? */
  me(): Promise<{ login: string; name: string | null }>;
  /** Alle Repositories, auf die der Zugang zugreifen darf */
  listRepos(): Promise<RemoteRepo[]>;
  defaultBranch(r: RepoRef): Promise<string>;
  tree(r: RepoRef, branch: string): Promise<TreeEntry[]>;
  file(r: RepoRef, path: string, ref: string): Promise<{ content: string; sha: string }>;
  branchSha(r: RepoRef, branch: string): Promise<string>;
  createBranch(r: RepoRef, name: string, fromSha: string): Promise<void>;
  deleteBranch(r: RepoRef, name: string): Promise<void>;
  putFile(r: RepoRef, path: string, o: { message: string; content: string; sha: string; branch: string }): Promise<string>;
  createPr(r: RepoRef, o: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }>;
  pr(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean }>;
  prHead(r: RepoRef, n: number): Promise<{ state: 'open' | 'closed'; merged: boolean; sha: string }>;
  closePr(r: RepoRef, n: number): Promise<void>;
  checks(r: RepoRef, sha: string): Promise<{ runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[]; restricted: boolean }>;
  renovatePrs(r: RepoRef): Promise<{ number: number; title: string; url: string; branch: string }[]>;
  diagnose(r: RepoRef): Promise<string>;
}
