import { parse as parseYaml } from 'yaml';

/**
 * Liest die Renovate-Konfiguration eines Repositories und wertet die Regeln aus, die lxnEye sicher beurteilen kann.
 * Regeln mit Bedingungen, die wir nicht kennen (matchManagers, matchFileNames …), werden bewusst übersprungen,
 * damit niemand fälschlich vor einem Update gewarnt wird.
 */

export interface RenovateRule {
  description: string | null;
  names: string[];
  types: string[];
  disabled: boolean;
  approval: boolean;
}

export interface RenovateConfig {
  file: string;
  rules: RenovateRule[];
  ignoreDeps: string[];
}

export const RENOVATE_FILES = ['renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', '.github/renovate.json', '.github/renovate.json5', '.gitlab/renovate.json'];

const UNSUPPORTED = ['matchManagers', 'matchDatasources', 'matchFileNames', 'matchCurrentVersion', 'matchCurrentValue', 'matchRepositories', 'matchBaseBranches', 'matchCategories', 'matchSourceUrls', 'matchDepTypes', 'matchNewValue'];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseRenovate(text: string, file: string): RenovateConfig | null {
  let raw: unknown;
  try {
    // JSON5 ist fast YAML im Flow-Stil. Kommentare (// und /* */) werden vorher entfernt.
    const cleaned = file.endsWith('5') ? text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') : text;
    raw = file.endsWith('5') ? parseYaml(cleaned) : JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as { packageRules?: unknown; ignoreDeps?: unknown };
  const rules: RenovateRule[] = [];
  for (const r of Array.isArray(cfg.packageRules) ? cfg.packageRules : []) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (UNSUPPORTED.some((k) => k in o)) continue;
    const disabled = o.enabled === false;
    const approval = o.dependencyDashboardApproval === true;
    if (!disabled && !approval) continue;
    const names = [...strings(o.matchPackageNames), ...strings(o.matchDepNames), ...strings(o.matchPackagePatterns).map((p) => `/${p}/`)];
    if (names.some((n) => n.startsWith('!'))) continue; // Negationen werden nicht ausgewertet
    const types = strings(o.matchUpdateTypes);
    if (names.length === 0 && types.length === 0) continue;
    rules.push({ description: typeof o.description === 'string' ? o.description : null, names, types, disabled, approval });
  }
  return { file, rules, ignoreDeps: strings(cfg.ignoreDeps) };
}

function nameMatches(pattern: string, name: string): boolean {
  const n = name.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i').test(name);
    } catch {
      return false;
    }
  }
  if (p.includes('*')) return new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n);
  // Docker-Images ohne Registry-Präfix (docker.io/library/…) gelten für beide Schreibweisen
  return n === p || n === `docker.io/${p}` || n === `docker.io/library/${p}`;
}

/** Warum Renovate dieses Update nicht (ohne Weiteres) vorschlagen würde. `null`, wenn nichts dagegen spricht. */
export function renovateBlock(cfg: RenovateConfig | null, name: string, level: 'Patch' | 'Minor' | 'Major'): string | null {
  if (!cfg) return null;
  if (cfg.ignoreDeps.some((p) => nameMatches(p, name))) return 'Renovate: dieses Paket steht in ignoreDeps.';
  const type = level.toLowerCase();
  for (const r of cfg.rules) {
    if (r.types.length > 0 && !r.types.includes(type)) continue;
    if (r.names.length > 0 && !r.names.some((p) => nameMatches(p, name))) continue;
    if (r.description) return `Renovate: ${r.description}`;
    return r.disabled ? 'Renovate: eine Regel in deiner Konfiguration deaktiviert dieses Update.' : 'Renovate: dieses Update braucht eine Freigabe im Dependency Dashboard.';
  }
  return null;
}

export interface RenovatePr {
  number: number;
  title: string;
  url: string;
  branch: string;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Gehört ein offener Renovate-Pull-Request zu diesem Paket? Renovate nennt Branches `renovate/<paket>-<version>`. */
export function prMatches(pr: RenovatePr, name: string): boolean {
  const s = slug(name);
  const short = slug(name.split('/').pop() ?? name);
  const branch = slug(pr.branch.replace(/^renovate\//, ''));
  const title = pr.title.toLowerCase();
  return branch.startsWith(`${s}-`) || branch === s || title.includes(` ${name.toLowerCase()} `) || (short.length > 3 && (branch.startsWith(`${short}-`) || title.includes(` ${short} `)));
}
