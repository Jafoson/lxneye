import { z } from 'zod';

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().optional(),
  PUBLIC_URL: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  SECRET_KEY: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  OIDC_ALLOWED_EMAILS: z.string().optional(),
  OIDC_ALLOWED_DOMAINS: z.string().optional(),
  OIDC_ALLOWED_GROUPS: z.string().optional(),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_REQUIRE_EMAIL_VERIFIED: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(720).default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().min(5).max(10080).default(120),
  SCAN_INTERVAL_MINUTES: z.coerce.number().min(0).default(360),
  GITHUB_TOKEN: z.string().optional(),
  EXTRA_REGISTRY_HOSTS: z.string().optional(),
  WEB_DIR: z.string().optional(),
  AUTH_DISABLED: z.string().optional(),
});

export interface Config {
  env: 'production' | 'development' | 'test';
  isProd: boolean;
  port: number;
  host: string;
  publicUrl: URL;
  trustProxy: boolean | string[];
  tls: { certFile: string; keyFile: string } | null;
  secretKey: string;
  dataDir: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    groupsClaim: string;
    allowedEmails: string[];
    allowedDomains: string[];
    allowedGroups: string[];
    requireEmailVerified: boolean;
  };
  sessionTtlMs: number;
  sessionIdleMs: number;
  scanIntervalMs: number;
  githubToken: string | undefined;
  extraHosts: string[];
  webDir: string | undefined;
  /** Nur Entwicklung: Anmeldung ist aus, jede Anfrage gilt als angemeldeter Entwickler. */
  devAuth: boolean;
}

export class ConfigError extends Error {}

/** Liest und validiert die Umgebungsvariablen. Wirft ConfigError mit allen Problemen auf einmal. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const problems: string[] = [];
  const devAuth = bool(e.AUTH_DISABLED, false);
  if (devAuth && e.NODE_ENV !== 'development') {
    problems.push('AUTH_DISABLED ist nur mit NODE_ENV=development erlaubt. In Produktion ist SSO Pflicht.');
  }
  if (devAuth && e.HOST && !['127.0.0.1', 'localhost', '::1'].includes(e.HOST)) {
    problems.push('Mit AUTH_DISABLED darf der Server nur auf localhost lauschen (HOST=127.0.0.1).');
  }

  const publicRaw = e.PUBLIC_URL ?? (isProd ? '' : 'http://localhost:5173');
  let publicUrl = new URL('http://localhost:5173');
  try {
    publicUrl = new URL(publicRaw);
  } catch {
    problems.push('PUBLIC_URL fehlt oder ist keine gültige URL.');
  }
  if (isProd && publicUrl.protocol !== 'https:') {
    problems.push('PUBLIC_URL muss in Produktion mit https:// beginnen. HTTP ist dort nicht erlaubt.');
  }
  if (publicUrl.username || publicUrl.password || publicUrl.pathname !== '/') {
    problems.push('PUBLIC_URL darf keinen Pfad und keine Zugangsdaten enthalten (z. B. https://lxneye.example.com).');
  }

  let trustProxy: boolean | string[] = false;
  const tp = (e.TRUST_PROXY ?? '').trim();
  if (tp === 'true') trustProxy = true;
  else if (tp && tp !== 'false') trustProxy = list(tp);

  const tls = e.TLS_CERT_FILE && e.TLS_KEY_FILE ? { certFile: e.TLS_CERT_FILE, keyFile: e.TLS_KEY_FILE } : null;
  if ((e.TLS_CERT_FILE || e.TLS_KEY_FILE) && !tls) problems.push('TLS_CERT_FILE und TLS_KEY_FILE müssen zusammen gesetzt werden.');
  if (isProd && !tls && trustProxy === false) {
    problems.push(
      'In Produktion braucht lxnEye entweder eigenes TLS (TLS_CERT_FILE/TLS_KEY_FILE) oder einen vertrauenswürdigen Reverse-Proxy (TRUST_PROXY=true oder IP/CIDR des Proxys).',
    );
  }

  const secretKey = e.SECRET_KEY ?? '';
  if (isProd && secretKey.length < 32) {
    problems.push('SECRET_KEY muss mindestens 32 Zeichen lang sein (z. B. `openssl rand -base64 48`).');
  }

  const allowedEmails = list(e.OIDC_ALLOWED_EMAILS).map((s) => s.toLowerCase());
  const allowedDomains = list(e.OIDC_ALLOWED_DOMAINS).map((s) => s.toLowerCase().replace(/^@/, ''));
  const allowedGroups = list(e.OIDC_ALLOWED_GROUPS);
  if (env.NODE_ENV !== 'test' && !devAuth) {
    if (!e.OIDC_ISSUER) problems.push('OIDC_ISSUER fehlt.');
    if (!e.OIDC_CLIENT_ID) problems.push('OIDC_CLIENT_ID fehlt.');
    if (!e.OIDC_CLIENT_SECRET) problems.push('OIDC_CLIENT_SECRET fehlt.');
    if (allowedEmails.length + allowedDomains.length + allowedGroups.length === 0) {
      problems.push(
        'Mindestens eine Zugriffsregel ist Pflicht: OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_DOMAINS oder OIDC_ALLOWED_GROUPS. Sonst könnte jeder Nutzer deines Anbieters hinein.',
      );
    }
  }
  if (isProd && e.OIDC_ISSUER && !e.OIDC_ISSUER.startsWith('https://')) {
    problems.push('OIDC_ISSUER muss in Produktion https:// verwenden.');
  }

  if (problems.length > 0) throw new ConfigError(problems.map((p) => `- ${p}`).join('\n'));

  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST ?? (isProd ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    trustProxy,
    tls,
    secretKey: secretKey || 'dev-only-insecure-secret-key-change-me!!',
    dataDir: e.DATA_DIR,
    oidc: {
      issuer: e.OIDC_ISSUER ?? '',
      clientId: e.OIDC_CLIENT_ID ?? '',
      clientSecret: e.OIDC_CLIENT_SECRET ?? '',
      scopes: e.OIDC_SCOPES,
      groupsClaim: e.OIDC_GROUPS_CLAIM,
      allowedEmails,
      allowedDomains,
      allowedGroups,
      requireEmailVerified: bool(e.OIDC_REQUIRE_EMAIL_VERIFIED, true),
    },
    sessionTtlMs: e.SESSION_TTL_HOURS * 3600_000,
    sessionIdleMs: e.SESSION_IDLE_MINUTES * 60_000,
    scanIntervalMs: e.SCAN_INTERVAL_MINUTES * 60_000,
    githubToken: e.GITHUB_TOKEN || undefined,
    extraHosts: list(e.EXTRA_REGISTRY_HOSTS).map((h) => h.toLowerCase()),
    webDir: e.WEB_DIR,
    devAuth,
  };
}
