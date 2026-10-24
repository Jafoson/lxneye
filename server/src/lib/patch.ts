import { parseAllDocuments, isScalar } from 'yaml';
import { minVersion, validRange } from 'semver';

export type Locator =
  | { type: 'npm'; section: string; name: string }
  | { type: 'dockerfile'; image: string }
  | { type: 'yaml'; doc?: number; path: (string | number)[]; mode: 'ref' | 'tag' | 'urltag'; image: string };

export class PatchError extends Error {}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ändert in `content` genau die Version, auf die der Locator zeigt, von `from` auf `to`.
 * Prüft vorher, dass dort wirklich `from` steht. Dadurch funktioniert dieselbe Funktion für Update und Rollback.
 */
export function applyPatch(content: string, loc: Locator, from: string, to: string): string {
  switch (loc.type) {
    case 'npm':
      return patchNpm(content, loc, from, to);
    case 'dockerfile':
      return patchDockerfile(content, loc, from, to);
    case 'yaml':
      return patchYaml(content, loc, from, to);
  }
}

function patchNpm(content: string, loc: Extract<Locator, { type: 'npm' }>, from: string, to: string): string {
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(content);
  } catch {
    throw new PatchError('package.json ist kein gültiges JSON.');
  }
  const range = pkg[loc.section]?.[loc.name];
  if (typeof range !== 'string') throw new PatchError(`${loc.name} steht nicht mehr in ${loc.section}.`);
  const prefix = /^[\^~]/.exec(range)?.[0] ?? '';
  if (!validRange(range) || !/^[\^~]?\d+\.\d+\.\d+$/.test(range)) {
    throw new PatchError(`Der Versionsbereich "${range}" lässt sich nicht automatisch ändern.`);
  }
  if (minVersion(range)?.version !== from) {
    throw new PatchError(`Die Datei enthält ${range} statt der erwarteten Version ${from}. Sie wurde zwischenzeitlich geändert.`);
  }
  const secIdx = content.search(new RegExp(`"${esc(loc.section)}"\\s*:\\s*\\{`));
  if (secIdx < 0) throw new PatchError('Abschnitt nicht gefunden.');
  const re = new RegExp(`("${esc(loc.name)}"\\s*:\\s*")${esc(range)}(")`);
  const head = content.slice(0, secIdx);
  const tail = content.slice(secIdx);
  if (!re.test(tail)) throw new PatchError('Zeile nicht gefunden.');
  return head + tail.replace(re, `$1${prefix}${to}$2`);
}

function patchDockerfile(content: string, loc: Extract<Locator, { type: 'dockerfile' }>, from: string, to: string): string {
  const re = new RegExp(`^(\\s*FROM\\s+(?:--\\S+\\s+)?)${esc(loc.image)}:${esc(from)}(?=\\s|$)`, 'gim');
  let n = 0;
  const out = content.replace(re, (_m, pre: string) => {
    n++;
    return `${pre}${loc.image}:${to}`;
  });
  if (n === 0) throw new PatchError(`FROM ${loc.image}:${from} nicht gefunden. Die Datei wurde zwischenzeitlich geändert.`);
  return out;
}

/**
 * Ändert nur die Zeichen der Version direkt im Text. Die YAML-Bibliothek wird nur benutzt, um die Stelle zu finden.
 * Dadurch bleibt alles andere (Einrückung, Kommentare, Anführungszeichen, Leerzeilen) Byte für Byte unverändert,
 * und ein Pull Request enthält genau eine geänderte Zeile.
 */
function patchYaml(content: string, loc: Extract<Locator, { type: 'yaml' }>, from: string, to: string): string {
  const docs = parseAllDocuments(content, { schema: 'failsafe' });
  if (!Array.isArray(docs) || docs.some((d) => d.errors.length > 0)) throw new PatchError('YAML konnte nicht gelesen werden.');
  const doc = docs[loc.doc ?? 0];
  if (!doc) throw new PatchError('Dokument in der YAML-Datei nicht gefunden.');
  const node = doc.getIn(loc.path, true);
  if (!isScalar(node) || typeof node.value !== 'string' || !node.range) throw new PatchError('Stelle in der YAML-Datei nicht gefunden.');
  const value = node.value;
  const [start, end] = node.range;
  const text = content.slice(start, end); // so, wie es in der Datei steht (ggf. mit Anführungszeichen)

  let search: string;
  let replace: string;
  if (loc.mode === 'urltag') {
    // z. B. https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.6/manifests/install.yaml oder ...?ref=v3.5.6
    if (value.includes(`/${loc.image}/${from}/`)) [search, replace] = [`/${loc.image}/${from}/`, `/${loc.image}/${to}/`];
    else if (value.includes(`ref=${from}`)) [search, replace] = [`ref=${from}`, `ref=${to}`];
    else throw new PatchError(`Die Datei enthält nicht mehr ${loc.image} in Version ${from}. Sie wurde zwischenzeitlich geändert.`);
  } else {
    const expected = loc.mode === 'ref' ? `${loc.image}:${from}` : from;
    if (value !== expected) throw new PatchError(`Die Datei enthält "${value}" statt "${expected}". Sie wurde zwischenzeitlich geändert.`);
    [search, replace] = loc.mode === 'ref' ? [`${loc.image}:${from}`, `${loc.image}:${to}`] : [from, to];
  }
  const at = text.indexOf(search);
  if (at < 0) throw new PatchError('Die Stelle in der Datei hat ein unerwartetes Format und wird nicht automatisch geändert.');
  return content.slice(0, start) + text.slice(0, at) + replace + text.slice(at + search.length) + content.slice(end);
}
