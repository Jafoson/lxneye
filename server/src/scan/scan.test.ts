import { afterEach, describe, expect, it, vi } from 'vitest';
import { npmVulnerabilities } from './osv.js';
import { latestNpm } from './registry.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.restoreAllMocks());

describe('Sicherheitslücken (OSV)', () => {
  it('wählt die Fix-Version, die zur installierten Version passt, nicht die des ältesten Zweigs', async () => {
    const vuln = (id: string, fixes: string[], sev = 'CRITICAL') => ({
      id,
      aliases: [],
      summary: 'Beispiel',
      database_specific: { severity: sev },
      affected: [{ package: { name: 'next', ecosystem: 'npm' }, ranges: [{ events: fixes.flatMap((f, i) => [{ introduced: `${i}.0.0` }, { fixed: f }]) }] }],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/querybatch')) return json({ results: [{ vulns: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }] });
      if (url.endsWith('/A')) return json(vuln('A', ['15.5.28', '16.4.1']));
      if (url.endsWith('/B')) return json(vuln('B', ['16.4.1']));
      return json(vuln('C', ['14.0.1'])); // alter Zweig: schon vor der installierten Version behoben
    });
    const [cves] = await npmVulnerabilities([{ name: 'next', version: '16.3.8' }]);
    expect(cves?.map((c) => [c.id, c.fixed, c.severity])).toEqual([['A', '16.4.1', 'Kritisch'], ['B', '16.4.1', 'Kritisch'], ['C', '14.0.1', 'Kritisch']]);
  });
});

describe('npm-Registry', () => {
  it('verarbeitet auch sehr große Paket-Dokumente wie das von next', async () => {
    const versions: Record<string, object> = {};
    for (let i = 0; i < 60_000; i++) versions[`15.${i}.0`] = { dist: { tarball: 'https://registry.npmjs.org/next/-/next-1.tgz', integrity: 'x'.repeat(100) } };
    versions['16.3.8'] = {};
    versions['16.4.1'] = {};
    const body = JSON.stringify({ 'dist-tags': { latest: '16.4.1' }, versions });
    expect(body.length).toBeGreaterThan(5 * 1024 * 1024); // größer als das normale Limit von 5 MB
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const r = await latestNpm('next', '16.3.8');
    expect(r.latest).toBe('16.4.1');
    expect(r.candidates.map((c) => c.version)).toEqual(['16.4.1']);
  });
});
