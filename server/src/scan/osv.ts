import { fetchJson } from '../http.js';

export interface Cve {
  id: string;
  severity: string;
  summary: string;
  fixed: string | null;
}

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
}

const SEV: Record<string, string> = { LOW: 'Niedrig', MODERATE: 'Mittel', MEDIUM: 'Mittel', HIGH: 'Hoch', CRITICAL: 'Kritisch' };

const vulnCache = new Map<string, { at: number; v: OsvVuln }>();

async function getVuln(id: string): Promise<OsvVuln> {
  const hit = vulnCache.get(id);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.v;
  const v = await fetchJson<OsvVuln>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);
  vulnCache.set(id, { at: Date.now(), v });
  return v;
}

/** Fragt OSV.dev nach bekannten Sicherheitslücken für npm-Pakete (Name + Version). */
export async function npmVulnerabilities(pkgs: { name: string; version: string }[]): Promise<Cve[][]> {
  if (pkgs.length === 0) return [];
  const result: Cve[][] = pkgs.map(() => []);
  for (let start = 0; start < pkgs.length; start += 500) {
    const chunk = pkgs.slice(start, start + 500);
    const res = await fetchJson<{ results: { vulns?: { id: string }[] }[] }>('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })),
      }),
    });
    for (let i = 0; i < chunk.length; i++) {
      const ids = (res.results[i]?.vulns ?? []).slice(0, 10).map((v) => v.id);
      const pkgName = (chunk[i] as { name: string }).name;
      const list: Cve[] = [];
      for (const id of ids) {
        try {
          const v = await getVuln(id);
          const fixed =
            v.affected
              ?.filter((a) => a.package?.name === pkgName)
              .flatMap((a) => a.ranges ?? [])
              .flatMap((r) => r.events ?? [])
              .map((e) => e.fixed)
              .find(Boolean) ?? null;
          const sev = (v.database_specific?.severity ?? '').toUpperCase();
          list.push({
            id: v.aliases?.find((a) => a.startsWith('CVE-')) ?? v.id,
            severity: SEV[sev] ?? 'Unbekannt',
            summary: (v.summary ?? '').slice(0, 300),
            fixed,
          });
        } catch {
          list.push({ id, severity: 'Unbekannt', summary: '', fixed: null });
        }
      }
      result[start + i] = list;
    }
  }
  return result;
}
