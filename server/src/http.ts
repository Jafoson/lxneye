/**
 * Ausgehende Anfragen laufen ausschließlich über diesen Wrapper:
 * nur HTTPS, nur Hosts aus der Erlaubnisliste (schützt vor SSRF), Timeout, Größenlimit,
 * Weiterleitungen werden einzeln neu geprüft.
 */

const BASE_HOSTS = [
  'api.github.com',
  'github.com',
  'gitlab.com',
  'artifacthub.io',
  'registry.npmjs.org',
  'api.osv.dev',
  'hub.docker.com',
  'registry-1.docker.io',
  'auth.docker.io',
  'ghcr.io',
  'quay.io',
  'registry.k8s.io',
  'gcr.io',
  'mcr.microsoft.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  '*.pkg.dev',
];

let extraHosts: string[] = [];
let allowInsecureLocalhost = false;

export function configureHttp(opts: { extraHosts: string[]; allowInsecureLocalhost?: boolean }): void {
  extraHosts = opts.extraHosts;
  allowInsecureLocalhost = opts.allowInsecureLocalhost ?? false;
}

export function isHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return [...BASE_HOSTS, ...extraHosts].some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p));
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
  }
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchResult {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

function checkUrl(u: URL): void {
  const local = allowInsecureLocalhost && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (!local && u.protocol !== 'https:') throw new HttpError(`Nur HTTPS erlaubt: ${u.origin}`, 0);
  if (u.username || u.password) throw new HttpError('Zugangsdaten in der URL sind nicht erlaubt', 0);
  if (!local && !isHostAllowed(u.hostname)) throw new HttpError(`Host nicht erlaubt: ${u.hostname}`, 0);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError('Antwort zu groß', 0);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function safeFetch(input: string, opts: FetchOpts = {}): Promise<FetchResult> {
  let url = new URL(input);
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  for (let hop = 0; hop < 4; hop++) {
    checkUrl(url);
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'user-agent': 'lxnEye/0.1', ...opts.headers },
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location') as string, url);
      // Zugangsdaten nie an einen anderen Host weiterreichen
      if (opts.headers && new URL(input).host !== url.host) {
        const kept = Object.entries(opts.headers).filter(([k]) => !['authorization', 'x-goog-api-key'].includes(k.toLowerCase()));
        opts = { ...opts, headers: Object.fromEntries(kept) };
      }
      await res.body?.cancel();
      continue;
    }
    return { status: res.status, headers: res.headers, text: await readCapped(res, maxBytes), url: url.toString() };
  }
  throw new HttpError('Zu viele Weiterleitungen', 0);
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await safeFetch(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`${new URL(url).host} antwortete mit ${res.status}`, res.status, res.text.slice(0, 500));
  }
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new HttpError(`Ungültige JSON-Antwort von ${new URL(url).host}`, res.status);
  }
}

/** Führt fn mit begrenzter Parallelität über alle Elemente aus. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
