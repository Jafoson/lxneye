import { gt, valid, diff, prerelease, rcompare, major } from 'semver';
import { fetchJson, HttpError, isHostAllowed, safeFetch } from '../http.js';
import { tagCandidates, topCandidate, type Bump, type Cand, type Level } from '../lib/versions.js';
import type { ImageName } from './extract.js';

export interface Latest {
  latest: string | null;
  bump: Bump;
  /** mögliche Ziele je Stufe; `latest` ist das höchste davon */
  candidates: Cand[];
  note?: string;
}

const NONE = (latest: string | null = null, note?: string): Latest => ({ latest, bump: '', candidates: [], note });

function fromCandidates(current: string, c: Cand[]): Latest {
  const top = topCandidate(c);
  return top ? { latest: top.version, bump: top.level, candidates: c } : NONE(current);
}

/** Semver-Versionen (npm, Helm): höchstes Update je Stufe, ohne Vorabversionen. */
export function semverCandidates(current: string, versions: string[]): Cand[] {
  const cur = current.replace(/^v/, '');
  if (!valid(cur)) return [];
  const best = new Map<Level, string>();
  let nextMajor: string | null = null;
  for (const raw of versions) {
    const v = raw.replace(/^v/, '');
    if (!valid(v) || prerelease(v) || !gt(v, cur)) continue;
    const d = diff(cur, v);
    const level: Level | null = d === 'major' ? 'Major' : d === 'minor' ? 'Minor' : d === 'patch' ? 'Patch' : null;
    if (!level) continue;
    const b = best.get(level);
    if (!b || rcompare(v, b.replace(/^v/, '')) < 0) best.set(level, raw);
    if (level === 'Major' && major(v) === major(cur) + 1 && (!nextMajor || rcompare(v, nextMajor.replace(/^v/, '')) < 0)) nextMajor = raw;
  }
  const out: Cand[] = (['Patch', 'Minor'] as Level[]).filter((l) => best.has(l)).map((l) => ({ level: l, version: best.get(l) as string }));
  const top = best.get('Major');
  if (nextMajor && top && nextMajor !== top) out.push({ level: 'Major', version: nextMajor });
  if (top) out.push({ level: 'Major', version: top });
  return out;
}

export async function latestNpm(name: string, current: string): Promise<Latest> {
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  // Pakete mit sehr vielen Versionen (z. B. next, typescript) haben mehrere MB große Dokumente
  const meta = await fetchJson<{ 'dist-tags'?: { latest?: string }; versions?: Record<string, unknown> }>(`https://registry.npmjs.org/${enc}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    maxBytes: 64 * 1024 * 1024,
    timeoutMs: 45_000,
  });
  const versions = Object.keys(meta.versions ?? {});
  if (versions.length === 0 && meta['dist-tags']?.latest) versions.push(meta['dist-tags'].latest);
  return fromCandidates(current, semverCandidates(current, versions));
}

// ---------- Docker / OCI ----------

const tagCache = new Map<string, { at: number; tags: string[] }>();
const TAG_TTL = 10 * 60_000;

async function hubTags(repo: string): Promise<string[]> {
  const tags: string[] = [];
  let url: string | null = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`;
  for (let page = 0; page < 5 && url; page++) {
    const body: { results?: { name: string }[]; next?: string | null } = await fetchJson(url);
    tags.push(...(body.results ?? []).map((r) => r.name));
    url = body.next && isHostAllowed(new URL(body.next).hostname) ? body.next : null;
  }
  return tags;
}

async function registryToken(challenge: string, repo: string): Promise<string | null> {
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return null;
  const u = new URL(realm);
  if (!isHostAllowed(u.hostname)) throw new HttpError(`Token-Host nicht erlaubt: ${u.hostname}`, 0);
  if (service) u.searchParams.set('service', service);
  u.searchParams.set('scope', `repository:${repo}:pull`);
  const body = await fetchJson<{ token?: string; access_token?: string }>(u.toString());
  return body.token ?? body.access_token ?? null;
}

async function v2Tags(registry: string, repo: string): Promise<string[]> {
  const tags: string[] = [];
  let url: string | null = `https://${registry}/v2/${repo}/tags/list?n=1000`;
  let token: string | null = null;
  for (let page = 0; page < 5 && url; page++) {
    const call = (): Promise<Awaited<ReturnType<typeof safeFetch>>> =>
      safeFetch(url as string, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    let res = await call();
    if (res.status === 401 && !token) {
      token = await registryToken(res.headers.get('www-authenticate') ?? '', repo);
      if (!token) throw new HttpError(`${registry} verlangt Anmeldung für ${repo}`, 401);
      res = await call();
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(`${registry} verlangt Anmeldung für ${repo}`, res.status);
    if (res.status === 404) throw new HttpError(`${repo} auf ${registry} nicht gefunden`, 404);
    if (res.status !== 200) throw new HttpError(`${registry} antwortete mit ${res.status}`, res.status);
    tags.push(...((JSON.parse(res.text) as { tags?: string[] }).tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    url = next ? new URL(next, url).toString() : null;
  }
  return tags;
}

export async function listTags(img: ImageName): Promise<string[]> {
  const key = `${img.registry}/${img.repo}`;
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.at < TAG_TTL) return hit.tags;
  const tags = img.registry === 'docker.io' ? await hubTags(img.repo) : await v2Tags(img.registry, img.repo);
  tagCache.set(key, { at: Date.now(), tags });
  return tags;
}

export async function latestDocker(img: ImageName, currentTag: string): Promise<Latest> {
  if (img.registry !== 'docker.io' && !isHostAllowed(img.registry)) {
    return NONE(null, `Registry ${img.registry} ist nicht freigegeben (EXTRA_REGISTRY_HOSTS)`);
  }
  return fromCandidates(currentTag, tagCandidates(currentTag, await listTags(img)));
}

/** Findet über das OCI-Label das Quell-Repository (für Release Notes). Gibt owner/repo auf GitHub zurück. */
export async function githubRepoFromImage(img: ImageName): Promise<string | null> {
  if (img.registry === 'ghcr.io') {
    const [owner, repo] = img.repo.split('/');
    return owner && repo ? `${owner}/${repo}` : null;
  }
  return null;
}

// ---------- Helm-Charts (über ArtifactHub) ----------

const normUrl = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

export async function latestHelm(repoUrl: string, chart: string, current: string): Promise<Latest> {
  const res = await fetchJson<{ packages?: { name: string; version: string; repository: { url: string; name: string } }[] }>(
    `https://artifacthub.io/api/v1/packages/search?kind=0&limit=60&ts_query_web=${encodeURIComponent(chart)}`,
  );
  const hit = (res.packages ?? []).find((p) => p.name === chart && normUrl(p.repository.url) === normUrl(repoUrl));
  if (!hit) return NONE(null, `${chart} in ${repoUrl} nicht bei ArtifactHub gefunden`);
  let versions = [hit.version];
  try {
    const detail = await fetchJson<{ available_versions?: { version: string }[] }>(
      `https://artifacthub.io/api/v1/packages/helm/${encodeURIComponent(hit.repository.name)}/${encodeURIComponent(chart)}`,
    );
    if (detail.available_versions?.length) versions = detail.available_versions.map((v) => v.version);
  } catch {
    /* Es bleibt bei der neuesten Version aus der Suche */
  }
  return fromCandidates(current, semverCandidates(current, versions));
}

// ---------- GitHub-Releases (z. B. Kustomize-Ressourcen per URL) ----------

let githubToken: string | undefined;
export const setGithubToken = (t: string | undefined): void => {
  githubToken = t;
};

export async function latestGithubRelease(slug: string, current: string): Promise<Latest> {
  const rel = await fetchJson<{ tag_name?: string }>(`https://api.github.com/repos/${slug}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) },
  });
  return rel.tag_name ? fromCandidates(current, semverCandidates(current, [rel.tag_name])) : NONE();
}
