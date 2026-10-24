export type Bump = 'Major' | 'Minor' | 'Patch' | '';

export interface ParsedTag {
  prefix: string;
  nums: number[];
  suffix: string;
}

const PRE = /^[-_.]?(rc|alpha|beta|dev|pre|snapshot|nightly|canary|next|test|preview)/i;

/** Zerlegt Image-Tags wie `v1.2.3`, `20-alpine`, `3.1.2-alpine3.19`. */
export function parseTag(tag: string): ParsedTag | null {
  const m = /^(v?)(\d+(?:\.\d+){0,3})(.*)$/.exec(tag);
  if (!m) return null;
  const suffix = m[3] ?? '';
  if (suffix && !/^[-_]/.test(suffix)) return null;
  return { prefix: m[1] ?? '', nums: (m[2] as string).split('.').map(Number), suffix };
}

export function isPrerelease(tag: string): boolean {
  const p = parseTag(tag);
  return !p || PRE.test(p.suffix);
}

export function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function bumpBetween(cur: number[], lat: number[]): Bump {
  if (compareNums(cur, lat) >= 0) return '';
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    if ((cur[i] ?? 0) !== (lat[i] ?? 0)) return i === 0 ? 'Major' : i === 1 ? 'Minor' : 'Patch';
  }
  return '';
}

/**
 * Wählt aus einer Tag-Liste das neueste Tag mit derselben "Form" wie das aktuelle
 * (gleiches Präfix, gleicher Suffix, gleiche Stellenzahl). Floating Tags (latest, stable) liefern null.
 */
export function pickLatestTag(current: string, tags: string[]): string | null {
  const cur = parseTag(current);
  if (!cur) return null;
  let best: { tag: string; nums: number[] } | null = null;
  for (const t of tags) {
    const p = parseTag(t);
    if (!p || p.prefix !== cur.prefix || p.suffix !== cur.suffix || p.nums.length !== cur.nums.length) continue;
    if (PRE.test(p.suffix)) continue;
    if (compareNums(p.nums, cur.nums) <= 0) continue;
    if (!best || compareNums(p.nums, best.nums) > 0) best = { tag: t, nums: p.nums };
  }
  return best?.tag ?? null;
}

export function bumpForTags(current: string, latest: string | null): Bump {
  const c = parseTag(current);
  const l = latest ? parseTag(latest) : null;
  if (!c || !l) return '';
  return bumpBetween(c.nums, l.nums);
}

export type Level = 'Patch' | 'Minor' | 'Major';
export interface Cand {
  level: Level;
  version: string;
}

const ORDER: Level[] = ['Patch', 'Minor', 'Major'];

/**
 * Das jeweils höchste Update je Stufe: Patch (gleiche Minor), Minor (gleiche Major) und Major.
 * Bei Major kommt, wenn es mehrere Sprünge gibt, zusätzlich die nächste Major (z. B. 15 → 16) vor der neuesten (15 → 18),
 * denn Datenbanken und Nextcloud sollten oft Schritt für Schritt aktualisiert werden.
 */
export function tagCandidates(current: string, tags: string[]): Cand[] {
  const cur = parseTag(current);
  if (!cur) return [];
  const best = new Map<Level, { tag: string; nums: number[] }>();
  let nextMajor: { tag: string; nums: number[] } | null = null;
  for (const t of tags) {
    const p = parseTag(t);
    if (!p || p.prefix !== cur.prefix || p.suffix !== cur.suffix || p.nums.length !== cur.nums.length || PRE.test(p.suffix)) continue;
    const level = bumpBetween(cur.nums, p.nums) as Level | '';
    if (!level) continue;
    const b = best.get(level);
    if (!b || compareNums(p.nums, b.nums) > 0) best.set(level, { tag: t, nums: p.nums });
    if (level === 'Major' && p.nums[0] === (cur.nums[0] ?? 0) + 1 && (!nextMajor || compareNums(p.nums, nextMajor.nums) > 0)) nextMajor = { tag: t, nums: p.nums };
  }
  const out: Cand[] = ORDER.filter((l) => best.has(l) && l !== 'Major').map((l) => ({ level: l, version: (best.get(l) as { tag: string }).tag }));
  const major = best.get('Major');
  if (nextMajor && major && nextMajor.tag !== major.tag) out.push({ level: 'Major', version: nextMajor.tag });
  if (major) out.push({ level: 'Major', version: major.tag });
  return out;
}

/** Höchstes Ziel = höchste vorhandene Stufe. */
export function topCandidate(c: Cand[]): Cand | null {
  return c.length === 0 ? null : (c[c.length - 1] as Cand);
}
