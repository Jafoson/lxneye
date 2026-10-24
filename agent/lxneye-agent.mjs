#!/usr/bin/env node
// lxnEye-Agent: meldet, welche Container auf diesem Server (oder Pods im Cluster) laufen.
// Reine Node-Datei ohne Abhängigkeiten (Node 20+). Sendet ausschließlich ausgehend per HTTPS.
//
//   LXNEYE_URL=https://lxneye.example.com LXNEYE_TOKEN=lxe_... node lxneye-agent.mjs
//
// Docker:     liest über den Docker-Socket (nur lesender Zugriff auf /containers/json).
// Kubernetes: läuft als Pod mit ServiceAccount (Rechte: get/list auf pods) und liest die Pods des Clusters.

import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const URL_BASE = process.env.LXNEYE_URL;
const TOKEN = process.env.LXNEYE_TOKEN;
const INTERVAL = Math.max(30, Number(process.env.LXNEYE_INTERVAL_SECONDS ?? 300)) * 1000;
const RUNTIME = process.env.LXNEYE_RUNTIME ?? (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token') ? 'kubernetes' : 'docker');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const HOSTNAME = process.env.LXNEYE_HOSTNAME ?? (await import('node:os')).hostname();

if (!URL_BASE || !TOKEN) {
  console.error('LXNEYE_URL und LXNEYE_TOKEN müssen gesetzt sein.');
  process.exit(1);
}
const base = new URL(URL_BASE);
const localDev = base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname);
if (base.protocol !== 'https:' && !localDev) {
  console.error('LXNEYE_URL muss mit https:// beginnen. Unverschlüsselt wird nichts gesendet.');
  process.exit(1);
}

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: 10_000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`Docker antwortete mit ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker-Timeout')));
    req.end();
  });
}

async function collectDocker() {
  const list = await dockerGet('/containers/json');
  return list.map((c) => ({ name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''), image: c.Image }));
}

async function collectKubernetes() {
  const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
  const token = readFileSync(`${dir}/token`, 'utf8');
  const ca = readFileSync(`${dir}/ca.crt`);
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      { host, port, path: '/api/v1/pods?fieldSelector=status.phase%3DRunning', method: 'GET', ca, headers: { authorization: `Bearer ${token}` }, timeout: 15_000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`Kubernetes antwortete mit ${res.statusCode}`))));
      },
    );
    req.on('error', reject);
    req.end();
  });
  return body.items.flatMap((pod) =>
    (pod.spec?.containers ?? []).map((c) => ({ name: `${pod.metadata.name}/${c.name}`, namespace: pod.metadata.namespace, image: c.image })),
  );
}

async function report() {
  const containers = RUNTIME === 'kubernetes' ? await collectKubernetes() : await collectDocker();
  const res = await fetch(new URL('/api/agent/report', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'lxneye-agent/0.1' },
    body: JSON.stringify({ runtime: RUNTIME, hostname: HOSTNAME, containers }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`lxnEye antwortete mit ${res.status}`);
  console.log(`${new Date().toISOString()} ${containers.length} Container gemeldet (${RUNTIME})`);
}

async function loop() {
  try {
    await report();
  } catch (err) {
    console.error(`${new Date().toISOString()} Fehler: ${err.message}`);
  }
  setTimeout(loop, INTERVAL);
}

if (process.argv.includes('--once')) {
  await report();
} else {
  await loop();
}
