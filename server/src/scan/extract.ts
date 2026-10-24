import { parseAllDocuments, isMap, isSeq, isScalar, isPair } from 'yaml';
import type { Node } from 'yaml';
import { minVersion } from 'semver';
import type { Locator } from '../lib/patch.js';

export interface ImageName {
  registry: string;
  repo: string;
}

export interface Ref {
  key: string;
  name: string;
  type: string;
  ecosystem: 'npm' | 'docker' | 'helm' | 'github';
  file: string;
  current: string;
  locator: Locator;
  image?: ImageName;
  /** Helm-Chart: Repository-URL und Chart-Name */
  helm?: { repo: string; chart: string };
}

export interface SourceFile {
  path: string;
  content: string;
}

/** `nginx` → docker.io/library/nginx, `ghcr.io/o/r` → ghcr.io / o/r */
export function parseImageName(name: string): ImageName {
  const parts = name.split('/');
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return { registry: first.toLowerCase(), repo: parts.slice(1).join('/') };
  }
  if (parts.length === 1) return { registry: 'docker.io', repo: `library/${name}` };
  return { registry: 'docker.io', repo: name };
}

/** Teilt `repo:tag` in Name und Tag. Digest-Pins und Variablen werden übersprungen. */
export function splitRef(ref: string): { image: string; tag: string } | null {
  if (ref.includes('@') || ref.includes('$') || ref.includes('{{')) return null;
  const idx = ref.lastIndexOf(':');
  const slash = ref.lastIndexOf('/');
  if (idx <= slash || idx < 1) return null;
  const image = ref.slice(0, idx);
  const tag = ref.slice(idx + 1);
  if (!/^[a-z0-9][a-z0-9._/:-]*$/i.test(image) || !/^[\w][\w.-]{0,127}$/.test(tag)) return null;
  return { image, tag };
}

const dockerRef = (file: string, image: string, tag: string, locator: Locator, key: string, type: string): Ref => ({
  key,
  name: image,
  type,
  ecosystem: 'docker',
  file,
  current: tag,
  locator,
  image: parseImageName(image),
});

function extractNpm(file: SourceFile): Ref[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(file.content);
  } catch {
    return [];
  }
  const out: Ref[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== 'string' || !/^[\^~]?\d+\.\d+\.\d+$/.test(range)) continue;
      const cur = minVersion(range)?.version;
      if (!cur) continue;
      out.push({
        key: `${file.path}#npm:${section}:${name}`,
        name,
        type: 'npm',
        ecosystem: 'npm',
        file: file.path,
        current: cur,
        locator: { type: 'npm', section, name },
      });
    }
  }
  return out;
}

function extractDockerfile(file: SourceFile): Ref[] {
  const out: Ref[] = [];
  const stages = new Set<string>();
  for (const line of file.content.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) continue;
    const ref = m[1] as string;
    const stage = m[2];
    const parsed = ref.toLowerCase() === 'scratch' || stages.has(ref) ? null : splitRef(ref);
    if (stage) stages.add(stage);
    if (!parsed) continue;
    out.push(
      dockerRef(file.path, parsed.image, parsed.tag, { type: 'dockerfile', image: parsed.image }, `${file.path}#from:${parsed.image}`, 'Dockerfile'),
    );
  }
  return out;
}

function str(node: unknown): string | null {
  return isScalar(node) && typeof node.value === 'string' ? node.value : null;
}

const TAGLIKE = /^[\w][\w.-]{0,127}$/;
const GH_RAW = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/(v?\d+(?:\.\d+)+[\w.-]*)\//;
const GH_REF = /^(?:https:\/\/|git::https:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/[^?]*)?\?ref=(v?\d+(?:\.\d+)+[\w.-]*)/;

function extractYaml(file: SourceFile): Ref[] {
  const docs = parseAllDocuments(file.content, { schema: 'failsafe' });
  if (!Array.isArray(docs)) return [];
  const isKustomization = /^kustomization\.ya?ml$/i.test(file.path.split('/').pop() ?? '');
  const out: Ref[] = [];
  docs.forEach((doc, d) => {
    if (doc.errors.length > 0 || !doc.contents) return;
    const keyOf = (path: (string | number)[], extra = ''): string => `${file.path}#${d > 0 ? `d${d}:` : ''}${extra}${path.join('.')}`;
    const loc = (path: (string | number)[], mode: 'ref' | 'tag' | 'urltag', image: string): Locator => ({ type: 'yaml', ...(d > 0 ? { doc: d } : {}), path, mode, image });

    const walk = (node: Node | null | undefined, path: (string | number)[]): void => {
      if (isMap(node)) {
        // Helm-Chart (Argo-CD-Application oder Chart.yaml-Abhängigkeit)
        const chart = str(node.get('chart', true));
        const repoUrl = str(node.get('repoURL', true));
        const rev = str(node.get('targetRevision', true));
        if (chart && repoUrl && rev && /^[\w][\w.+-]*$/.test(rev) && /^https?:\/\//.test(repoUrl)) {
          out.push({ key: keyOf([...path, 'targetRevision'], 'helm:'), name: chart, type: 'Helm-Chart', ecosystem: 'helm', file: file.path, current: rev,
            locator: loc([...path, 'targetRevision'], 'tag', chart), helm: { repo: repoUrl, chart } });
        }
        const depName = str(node.get('name', true));
        const depVersion = str(node.get('version', true));
        const depRepo = str(node.get('repository', true));
        if (depName && depVersion && depRepo && /^https?:\/\//.test(depRepo) && /^\d+\.\d+\.\d+$/.test(depVersion)) {
          out.push({ key: keyOf([...path, 'version'], 'helm:'), name: depName, type: 'Helm-Chart', ecosystem: 'helm', file: file.path, current: depVersion,
            locator: loc([...path, 'version'], 'tag', depName), helm: { repo: depRepo, chart: depName } });
        }
        for (const item of node.items) {
          if (!isPair(item)) continue;
          const k = str(item.key);
          if (k === null) continue;
          const v = item.value as Node | null;
          if (k === 'image') {
            const s = str(v);
            if (s) {
              const p = splitRef(s);
              if (p) out.push(dockerRef(file.path, p.image, p.tag, loc([...path, k], 'ref', p.image), keyOf([...path, k]), 'Image'));
              continue;
            }
            if (isMap(v)) {
              const repo = str(v.get('repository', true));
              const tag = str(v.get('tag', true));
              const registry = str(v.get('registry', true));
              if (repo && tag && TAGLIKE.test(tag) && !repo.includes('{{') && !tag.includes('{{')) {
                const image = registry && !registry.includes('{{') ? `${registry}/${repo}` : repo;
                out.push(dockerRef(file.path, image, tag, loc([...path, k, 'tag'], 'tag', image), keyOf([...path, k]), 'Image'));
                continue;
              }
            }
          }
          walk(v, [...path, k]);
        }
      } else if (isSeq(node)) {
        node.items.forEach((it, i) => {
          const s = str(it);
          if (isKustomization && s) {
            const m = GH_RAW.exec(s) ?? GH_REF.exec(s);
            if (m) {
              const slug = `${m[1]}/${m[2]}`;
              out.push({ key: keyOf([...path, i], 'gh:'), name: slug, type: 'GitHub-Release', ecosystem: 'github', file: file.path, current: m[3] as string,
                locator: loc([...path, i], 'urltag', slug) });
              return;
            }
          }
          walk(it as Node, [...path, i]);
        });
      }
    };
    walk(doc.contents as Node, []);
  });
  return out;
}

export const MAX_FILE_BYTES = 256 * 1024;

/** Pfade, die der Standard-Scan überhaupt liest. */
export function isInterestingPath(path: string): boolean {
  if (path.includes('node_modules/') || path.startsWith('.git/') || path.includes('/templates/') || path.startsWith('.github/')) return false;
  const base = path.split('/').pop() ?? '';
  return base === 'package.json' || /^Dockerfile/i.test(base) || /\.dockerfile$/i.test(base) || /\.ya?ml$/i.test(base);
}

export function extractRefs(files: SourceFile[]): Ref[] {
  const out: Ref[] = [];
  for (const f of files) {
    const base = f.path.split('/').pop() ?? '';
    if (base === 'package.json') out.push(...extractNpm(f));
    else if (/^Dockerfile/i.test(base) || /\.dockerfile$/i.test(base)) out.push(...extractDockerfile(f));
    else if (/\.ya?ml$/i.test(base)) out.push(...extractYaml(f));
  }
  // gleiche Schlüssel nur einmal
  return [...new Map(out.map((r) => [r.key, r])).values()];
}

// ---------- Server-Zuordnung (mehrere Server in einem Repository) ----------

interface AppInfo {
  file: string;
  path: string;
  label: string;
}

const clean = (p: string): string => p.replace(/^\.?\//, '').replace(/\/+$/, '');

/**
 * Findet heraus, auf welchem Server eine Datei ausgerollt wird.
 * 1. Über Argo-CD-Applications: `spec.source.path` zeigt auf den Ordner, `spec.project` bzw. das Ziel nennt den Server.
 * 2. Sonst über einen Ordnernamen wie `server2` im Pfad.
 */
export function inferServers(files: SourceFile[]): (path: string) => string[] {
  const apps: AppInfo[] = [];
  for (const f of files) {
    if (!/\.ya?ml$/i.test(f.path) || !f.content.includes('kind: Application')) continue;
    const docs = parseAllDocuments(f.content, { schema: 'failsafe' });
    if (!Array.isArray(docs)) continue;
    for (const doc of docs) {
      const j = doc.toJS({ maxAliasCount: 50 }) as {
        kind?: string;
        spec?: { project?: string; source?: { path?: string }; sources?: { path?: string }[]; destination?: { name?: string } };
      } | null;
      if (!j || j.kind !== 'Application' || !j.spec) continue;
      const project = j.spec.project && j.spec.project !== 'default' ? j.spec.project : null;
      const label = project ?? j.spec.destination?.name ?? f.path.split('/').slice(-2, -1)[0] ?? null;
      const paths = [j.spec.source?.path, ...(j.spec.sources ?? []).map((s) => s.path)].filter((x): x is string => !!x);
      if (!label) continue;
      for (const path of paths) apps.push({ file: f.path, path: clean(path), label });
      apps.push({ file: f.path, path: '', label }); // die Application-Datei selbst
    }
  }
  return (path: string): string[] => {
    const labels = new Set<string>();
    let bestLen = -1;
    for (const a of apps) {
      if (a.path === '') {
        if (a.file === path) {
          labels.clear();
          labels.add(a.label);
          bestLen = Number.MAX_SAFE_INTEGER;
        }
        continue;
      }
      if (path === a.path || path.startsWith(`${a.path}/`)) {
        if (a.path.length > bestLen) {
          labels.clear();
          bestLen = a.path.length;
        }
        if (a.path.length === bestLen) labels.add(a.label);
      }
    }
    if (labels.size === 0) {
      const seg = path.split('/').find((x) => /^server[\w-]*$/i.test(x));
      if (seg) labels.add(seg);
    }
    return [...labels].sort();
  };
}
