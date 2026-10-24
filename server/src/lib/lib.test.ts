import { describe, expect, it } from 'vitest';
import { applyPatch, PatchError } from './patch.js';
import { bumpForTags, parseTag, pickLatestTag, tagCandidates } from './versions.js';
import { semverCandidates } from '../scan/registry.js';
import { parseRenovate, prMatches, renovateBlock } from '../git/renovate.js';
import { extractRefs, inferServers, parseImageName, splitRef } from '../scan/extract.js';

describe('Tags', () => {
  it('zerlegt Tags', () => {
    expect(parseTag('v1.2.3')).toEqual({ prefix: 'v', nums: [1, 2, 3], suffix: '' });
    expect(parseTag('20-alpine')).toEqual({ prefix: '', nums: [20], suffix: '-alpine' });
    expect(parseTag('latest')).toBeNull();
    expect(parseTag('1.2.3abc')).toBeNull();
  });

  it('wählt das neueste Tag gleicher Form', () => {
    const tags = ['3.1.2', '3.2.0', '3.2.1-rc1', '3.2.0-alpine', 'latest', '2.9.9', 'v3.9.0'];
    expect(pickLatestTag('3.1.2', tags)).toBe('3.2.0');
    expect(pickLatestTag('3.2.0-alpine', tags)).toBeNull();
    expect(pickLatestTag('latest', tags)).toBeNull();
    expect(pickLatestTag('16.4', ['16.4', '17.0', '16.5', '17.0.1'])).toBe('17.0');
  });

  it('klassifiziert Sprünge', () => {
    expect(bumpForTags('1.2.3', '2.0.0')).toBe('Major');
    expect(bumpForTags('1.2.3', '1.3.0')).toBe('Minor');
    expect(bumpForTags('1.2.3', '1.2.4')).toBe('Patch');
    expect(bumpForTags('1.2.3', '1.2.3')).toBe('');
  });
});

describe('Image-Namen', () => {
  it('erkennt Registries', () => {
    expect(parseImageName('nginx')).toEqual({ registry: 'docker.io', repo: 'library/nginx' });
    expect(parseImageName('grafana/grafana')).toEqual({ registry: 'docker.io', repo: 'grafana/grafana' });
    expect(parseImageName('ghcr.io/o/r')).toEqual({ registry: 'ghcr.io', repo: 'o/r' });
  });
  it('überspringt Digests und Variablen', () => {
    expect(splitRef('nginx:1.25')).toEqual({ image: 'nginx', tag: '1.25' });
    expect(splitRef('nginx@sha256:abc')).toBeNull();
    expect(splitRef('nginx:${TAG}')).toBeNull();
    expect(splitRef('nginx')).toBeNull();
    expect(splitRef('localhost:5000/x')).toBeNull();
  });
});

describe('Extraktion und Patch', () => {
  const dockerfile = 'FROM node:20-alpine AS build\nRUN x\nFROM build AS final\nFROM scratch\nFROM nginx:1.25.3\n';
  const values = `image:
  repository: ghcr.io/org/app # Kommentar
  tag: 1.10
other:
  image: "redis:7.2.0"
`;
  const pkg = JSON.stringify({ dependencies: { fastify: '^4.28.1', local: 'file:../x' }, devDependencies: { zod: '3.23.7' } }, null, 2);

  it('findet Abhängigkeiten', () => {
    const refs = extractRefs([
      { path: 'Dockerfile', content: dockerfile },
      { path: 'chart/values.yaml', content: values },
      { path: 'package.json', content: pkg },
    ]);
    const names = refs.map((r) => `${r.ecosystem}:${r.name}@${r.current}`).sort();
    expect(names).toEqual(['docker:ghcr.io/org/app@1.10', 'docker:nginx@1.25.3', 'docker:node@20-alpine', 'docker:redis@7.2.0', 'npm:fastify@4.28.1', 'npm:zod@3.23.7']);
  });

  it('patcht Dockerfile, YAML und package.json hin und zurück', () => {
    const refs = extractRefs([
      { path: 'Dockerfile', content: dockerfile },
      { path: 'values.yaml', content: values },
      { path: 'package.json', content: pkg },
    ]);
    const find = (n: string) => refs.find((r) => r.name === n)!;

    const d2 = applyPatch(dockerfile, find('nginx').locator, '1.25.3', '1.27.0');
    expect(d2).toContain('FROM nginx:1.27.0');
    expect(applyPatch(d2, find('nginx').locator, '1.27.0', '1.25.3')).toBe(dockerfile);

    const y2 = applyPatch(values, find('ghcr.io/org/app').locator, '1.10', '1.11');
    expect(y2).toContain('tag: 1.11');
    expect(y2).toContain('# Kommentar');
    const y3 = applyPatch(values, find('redis').locator, '7.2.0', '7.4.1');
    expect(y3).toContain('redis:7.4.1');

    const p2 = applyPatch(pkg, find('fastify').locator, '4.28.1', '5.0.0');
    expect(JSON.parse(p2).dependencies.fastify).toBe('^5.0.0');
    expect(applyPatch(pkg, find('zod').locator, '3.23.7', '3.23.8')).toContain('"zod": "3.23.8"');
  });

  it('verweigert Patches, wenn die Datei nicht zur erwarteten Version passt', () => {
    const refs = extractRefs([{ path: 'package.json', content: pkg }]);
    const loc = refs.find((r) => r.name === 'fastify')!.locator;
    expect(() => applyPatch(pkg, loc, '4.0.0', '5.0.0')).toThrow(PatchError);
    expect(() => applyPatch(dockerfile, { type: 'dockerfile', image: 'nginx' }, '9.9.9', '1.0.0')).toThrow(PatchError);
  });
});

describe('Kubernetes-Manifeste mit mehreren Dokumenten', () => {
  const multi = `# Kommentar am Anfang
apiVersion: v1
kind: Service
metadata:
  name: web
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: web
          image: "nextcloud:35.0.2-apache"   # gepinnt
          ports: [{ containerPort: 80 }]
        - name: redis
          image: redis:7.4.11-alpine
---
apiVersion: v1
kind: ConfigMap
`;

  it('findet Images auch hinter "---"', () => {
    const refs = extractRefs([{ path: 'workloads/app.yaml', content: multi }]);
    expect(refs.map((r) => `${r.name}:${r.current}`).sort()).toEqual(['nextcloud:35.0.2-apache', 'redis:7.4.11-alpine']);
  });

  it('ändert genau eine Zeile und lässt alles andere unberührt', () => {
    const refs = extractRefs([{ path: 'workloads/app.yaml', content: multi }]);
    const nc = refs.find((r) => r.name === 'nextcloud')!;
    const out = applyPatch(multi, nc.locator, '35.0.2-apache', '36.0.0-apache');
    expect(out).toBe(multi.replace('"nextcloud:35.0.2-apache"   # gepinnt', '"nextcloud:36.0.0-apache"   # gepinnt'));
    expect(applyPatch(out, nc.locator, '36.0.0-apache', '35.0.2-apache')).toBe(multi);
  });
});

describe('Helm-Charts und GitHub-URLs', () => {
  const app = `apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source:
    repoURL: https://bitnami.github.io/sealed-secrets
    chart: sealed-secrets
    targetRevision: 2.20.0   # App-Version 0.40.0
`;
  const chartYaml = `apiVersion: v2
name: meine-app
version: 0.1.0
dependencies:
  - name: redis
    version: 19.6.4
    repository: https://charts.bitnami.com/bitnami
  - name: lokal
    version: 1.0.0
    repository: file://../lokal
`;
  const kustom = `resources:
  - https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.6/manifests/install.yaml
  - github.com/org/repo//deploy?ref=v1.2.3
  - ./lokal.yaml
`;

  it('erkennt Argo-Charts, Chart-Abhängigkeiten und GitHub-Versionen in Kustomize', () => {
    const refs = extractRefs([
      { path: 'apps/ss.yaml', content: app },
      { path: 'chart/Chart.yaml', content: chartYaml },
      { path: 'workloads/argocd/kustomization.yaml', content: kustom },
    ]);
    const got = refs.map((r) => `${r.ecosystem}:${r.name}@${r.current}`).sort();
    expect(got).toEqual(['github:argoproj/argo-cd@v3.5.6', 'github:org/repo@v1.2.3', 'helm:redis@19.6.4', 'helm:sealed-secrets@2.20.0']);
    expect(refs.find((r) => r.name === 'sealed-secrets')?.helm).toEqual({ repo: 'https://bitnami.github.io/sealed-secrets', chart: 'sealed-secrets' });
  });

  it('patcht Chart-Version, Kommentar bleibt erhalten', () => {
    const ref = extractRefs([{ path: 'apps/ss.yaml', content: app }])[0]!;
    const out = applyPatch(app, ref.locator, '2.20.0', '2.21.1');
    expect(out).toContain('targetRevision: 2.21.1   # App-Version 0.40.0');
  });

  it('patcht URL-Tags in beiden Schreibweisen', () => {
    const refs = extractRefs([{ path: 'k/kustomization.yaml', content: kustom }]);
    const raw = refs.find((r) => r.name === 'argoproj/argo-cd')!;
    const ref = refs.find((r) => r.name === 'org/repo')!;
    expect(applyPatch(kustom, raw.locator, 'v3.5.6', 'v3.6.0')).toContain('argo-cd/v3.6.0/manifests/install.yaml');
    expect(applyPatch(kustom, ref.locator, 'v1.2.3', 'v1.3.0')).toContain('?ref=v1.3.0');
  });
});

describe('Update-Ziele je Stufe', () => {
  it('liefert Patch, Minor und Major getrennt', () => {
    const tags = ['15.19-alpine', '15.20-alpine', '15.21-alpine', '16.4-alpine', '17.0-alpine', '18.6-alpine', '18.6', '18.7-rc1-alpine', 'latest'];
    // zwei Stellen: 15.x → "Minor" (nur zwei Zahlen), 16/17/18 → Major (je Stufe nur das höchste)
    // erst die nächste Major (16), dann die neueste (18)
    expect(tagCandidates('15.19-alpine', tags)).toEqual([
      { level: 'Minor', version: '15.21-alpine' },
      { level: 'Major', version: '16.4-alpine' },
      { level: 'Major', version: '18.6-alpine' },
    ]);
    expect(tagCandidates('2.8.1', ['2.8.1', '2.8.4', '2.9.0', '2.10.1', '3.0.2', '3.1.0', '2.8.5-beta1'])).toEqual([
      { level: 'Patch', version: '2.8.4' },
      { level: 'Minor', version: '2.10.1' },
      { level: 'Major', version: '3.1.0' },
    ]);
    expect(tagCandidates('2.8.4', ['2.8.4', '2.8.3'])).toEqual([]);
    expect(tagCandidates('latest', ['1.0.0'])).toEqual([]);
  });

  it('liefert dasselbe für Semver (npm, Helm) und ignoriert Vorabversionen', () => {
    const v = ['4.28.1', '4.28.2', '4.29.0', '4.30.1', '5.0.0', '5.1.0', '6.0.0-rc.1', '3.9.0'];
    expect(semverCandidates('4.28.1', v)).toEqual([
      { level: 'Patch', version: '4.28.2' },
      { level: 'Minor', version: '4.30.1' },
      { level: 'Major', version: '5.1.0' },
    ]);
    expect(semverCandidates('v1.2.3', ['v1.2.4'])).toEqual([{ level: 'Patch', version: 'v1.2.4' }]);
    expect(semverCandidates('35.0.2', ['35.0.3', '36.0.1', '36.1.0', '37.0.0', '38.2.0'])).toEqual([
      { level: 'Patch', version: '35.0.3' },
      { level: 'Major', version: '36.1.0' },
      { level: 'Major', version: '38.2.0' },
    ]);
  });
});

describe('Server-Erkennung', () => {
  const app = (project: string, path: string) =>
    `apiVersion: argoproj.io/v1alpha1\nkind: Application\nspec:\n  project: ${project}\n  source:\n    path: ${path}\n`;
  const files = [
    { path: 'apps/server1/nextcloud.yaml', content: app('server1', 'workloads/nextcloud') },
    { path: 'apps/server2/nextcloud.yaml', content: app('server2', 'workloads/nextcloud') },
    { path: 'apps/server1/cf.yaml', content: app('server1', 'workloads/cloudflared') },
    { path: 'workloads/nextcloud/web.yaml', content: 'kind: Deployment' },
    { path: 'workloads/server2/barynt/app.yaml', content: 'kind: Deployment' },
    { path: 'workloads/ohne/app.yaml', content: 'kind: Deployment' },
  ];
  const of = inferServers(files);
  it('ordnet Dateien über Argo-Apps und Ordnernamen zu', () => {
    expect(of('workloads/cloudflared/c.yaml')).toEqual(['server1']);
    expect(of('workloads/nextcloud/web.yaml')).toEqual(['server1', 'server2']); // von zwei Servern genutzt
    expect(of('workloads/server2/barynt/app.yaml')).toEqual(['server2']); // nur über den Ordnernamen
    expect(of('apps/server1/nextcloud.yaml')).toEqual(['server1']);
    expect(of('workloads/ohne/app.yaml')).toEqual([]);
  });
});

describe('Renovate-Konfiguration', () => {
  // gekürzt aus einem echten renovate.json
  const json = JSON.stringify({
    extends: ['config:recommended'],
    kubernetes: { managerFilePatterns: ['/^workloads/'] },
    packageRules: [
      { description: 'Postgres/Redis: keine Major-Updates (Datenmigration nötig)', matchPackageNames: ['postgres', 'redis'], matchUpdateTypes: ['major'], enabled: false },
      { description: 'Nextcloud-Major nur nach Freigabe', matchPackageNames: ['nextcloud'], matchUpdateTypes: ['major'], dependencyDashboardApproval: true },
      { matchManagers: ['npm'], matchPackageNames: ['zod'], enabled: false }, // Bedingung unbekannt: wird übersprungen
      { matchPackageNames: ['!foo'], enabled: false }, // Negation: wird übersprungen
    ],
    ignoreDeps: ['busybox'],
  });
  const cfg = parseRenovate(json, 'renovate.json')!;

  it('liest nur Regeln, die lxnEye sicher beurteilen kann', () => {
    expect(cfg.rules).toHaveLength(2);
    expect(cfg.ignoreDeps).toEqual(['busybox']);
  });

  it('sperrt Major bei Postgres/Redis mit dem Grund aus der Regel, aber nicht Minor oder Patch', () => {
    expect(renovateBlock(cfg, 'postgres', 'Major')).toBe('Renovate: Postgres/Redis: keine Major-Updates (Datenmigration nötig)');
    expect(renovateBlock(cfg, 'redis', 'Major')).toMatch(/Datenmigration/);
    expect(renovateBlock(cfg, 'postgres', 'Minor')).toBeNull();
    expect(renovateBlock(cfg, 'docker.io/library/postgres', 'Major')).toMatch(/Datenmigration/);
    expect(renovateBlock(cfg, 'zod', 'Major')).toBeNull();
  });

  it('meldet Freigabe-Regeln und ignoreDeps', () => {
    expect(renovateBlock(cfg, 'nextcloud', 'Major')).toMatch(/Nextcloud-Major nur nach Freigabe/);
    expect(renovateBlock(cfg, 'nextcloud', 'Patch')).toBeNull();
    expect(renovateBlock(cfg, 'busybox', 'Minor')).toMatch(/ignoreDeps/);
    expect(renovateBlock(null, 'postgres', 'Major')).toBeNull();
  });

  it('unterstützt Platzhalter und reguläre Ausdrücke', () => {
    const c = parseRenovate(JSON.stringify({ packageRules: [{ matchPackageNames: ['ghcr.io/org/*', '/^node$/'], enabled: false }] }), 'renovate.json')!;
    expect(renovateBlock(c, 'ghcr.io/org/app', 'Patch')).toMatch(/deaktiviert/);
    expect(renovateBlock(c, 'node', 'Major')).toMatch(/deaktiviert/);
    expect(renovateBlock(c, 'nodemailer', 'Major')).toBeNull();
  });

  it('liest JSON5 mit Kommentaren und ignoriert kaputte Dateien', () => {
    const c = parseRenovate('{\n // Kommentar\n packageRules: [{ matchPackageNames: ["x"], enabled: false }],\n}', 'renovate.json5');
    expect(c?.rules).toHaveLength(1);
    expect(parseRenovate('{ kaputt', 'renovate.json')).toBeNull();
  });

  it('ordnet offene Renovate-Pull-Requests Paketen zu', () => {
    const pr = { number: 12, title: 'Update nextcloud Docker tag to v36', url: 'u', branch: 'renovate/nextcloud-36.x' };
    expect(prMatches(pr, 'nextcloud')).toBe(true);
    expect(prMatches(pr, 'postgres')).toBe(false);
    const gh = { number: 3, title: 'Update ghcr.io/paperless-ngx/paperless-ngx Docker tag to v3', url: 'u', branch: 'renovate/ghcr.io-paperless-ngx-paperless-ngx-3.x' };
    expect(prMatches(gh, 'ghcr.io/paperless-ngx/paperless-ngx')).toBe(true);
    expect(prMatches(gh, 'nextcloud')).toBe(false);
  });
});
