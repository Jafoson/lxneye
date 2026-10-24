import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { configureHttp } from './http.js';
import { scanAll } from './scan/run.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\nlxnEye startet nicht, die Konfiguration ist unvollständig oder unsicher:\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

configureHttp({ extraHosts: cfg.extraHosts });
const { app, ctx, warmAuth } = await buildApp(cfg);

if (cfg.devAuth) app.log.warn('AUTH_DISABLED: Die Anmeldung ist ausgeschaltet. Nur für lokale Entwicklung, der Server lauscht nur auf localhost.');
if (!cfg.isProd) app.log.warn('Entwicklungsmodus: HTTP ist erlaubt. In Produktion (NODE_ENV=production) wird HTTP abgelehnt.');
if (cfg.secretKey.startsWith('dev-only')) app.log.warn('SECRET_KEY nicht gesetzt: es wird ein unsicherer Entwicklungsschlüssel verwendet.');

await app.listen({ host: cfg.host, port: cfg.port });
if (!cfg.devAuth) warmAuth().catch((err) => app.log.error({ err }, 'SSO-Anbieter nicht erreichbar. Die Anmeldung wird beim nächsten Versuch erneut probiert.'));

let timer: NodeJS.Timeout | undefined;
if (cfg.scanIntervalMs > 0) {
  timer = setInterval(() => {
    scanAll(ctx).catch((err) => app.log.error({ err }, 'Geplanter Scan fehlgeschlagen'));
  }, cfg.scanIntervalMs);
  timer.unref();
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal} empfangen, fahre herunter`);
  if (timer) clearInterval(timer);
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
