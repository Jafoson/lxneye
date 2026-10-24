import { z } from 'zod';
import type { Ctx } from './ctx.js';
import { decrypt, encrypt } from './crypto.js';
import { deleteSetting, getSetting, setSetting } from './db.js';
import { fetchJson, HttpError } from './http.js';

export const aiSettingsSchema = z.object({
  provider: z.enum(['openai', 'gemini']),
  apiKey: z.string().min(8).max(500),
  model: z
    .string()
    .max(80)
    .regex(/^[\w.\-:]*$/, 'Ungültiger Modellname')
    .default(''),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_MODEL = { openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' } as const;

export function loadAi(ctx: Ctx): AiSettings | null {
  const raw = getSetting(ctx.db, 'ai');
  if (!raw) return null;
  try {
    return aiSettingsSchema.parse(JSON.parse(decrypt(ctx.key, raw)));
  } catch {
    return null;
  }
}

export function saveAi(ctx: Ctx, s: AiSettings): void {
  setSetting(ctx.db, 'ai', encrypt(ctx.key, JSON.stringify(s)));
}

export function clearAi(ctx: Ctx): void {
  deleteSetting(ctx.db, 'ai');
}

function parseOne(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Modelle ohne JSON-Modus (z. B. Gemma) schreiben manchmal Text um das JSON herum
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('kein JSON');
  }
}

/** Versucht die Textteile von hinten nach vorn (die Antwort steht nach dem "Nachdenken") und zuletzt zusammengesetzt. */
function parseJsonLoose(texts: string | string[]): unknown {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => t.trim());
  const candidates = [...list].reverse();
  if (list.length > 1) candidates.push(list.join('\n'));
  for (const c of candidates) {
    try {
      const out = parseOne(c);
      if (out && typeof out === 'object') return out;
    } catch {
      /* nächster Kandidat */
    }
  }
  throw new Error('Die KI hat keine auswertbare Antwort geliefert.');
}

/** Gemma-Modelle der Gemini-API kennen weder Systemprompt noch JSON-Modus. */
const isGemma = (model: string): boolean => /^gemma/i.test(model);
/** Ab Gemma 4 gibt es Systemprompts über die Gemini-API (Gemma 3 nicht). */
const gemmaHasSystem = (model: string): boolean => /^gemma-(?:[4-9]|\d{2,})/i.test(model);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

let retryDelays = [1000, 2500, 5000];
/** Nur für Tests: Wartezeiten zwischen den Wiederholungen. */
export const setRetryDelays = (d: number[]): void => {
  retryDelays = d;
};

/** Google und OpenAI melden gelegentlich vorübergehende Serverfehler. Dann wird mit Wartezeit erneut versucht. */
async function retryServerErrors<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof HttpError && [500, 502, 503, 504].includes(err.status);
      if (!retryable || attempt >= retryDelays.length) throw err;
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));
    }
  }
}

/** Schickt Systemprompt + Nutzerprompt an den gewählten Anbieter und erwartet JSON zurück. */
async function aiJsonRaw(s: AiSettings, system: string, user: string): Promise<unknown> {
  const model = s.model || DEFAULT_MODEL[s.provider];
  if (s.provider === 'openai') {
    const res = await retryServerErrors(() => fetchJson<{ choices?: { message?: { content?: string } }[] }>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      timeoutMs: 60_000,
      headers: { authorization: `Bearer ${s.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      }),
    }));
    return parseJsonLoose(res.choices?.[0]?.message?.content ?? '');
  }
  const gemma = isGemma(model);
  const call = (body: unknown) =>
    retryServerErrors(() =>
      fetchJson<GeminiResponse>(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        timeoutMs: 90_000,
        headers: { 'x-goog-api-key': s.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const structured = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const plainSystem = { systemInstruction: structured.systemInstruction, contents: structured.contents };
  const merged = { contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}\n\nAntworte nur mit dem JSON-Objekt, ohne weiteren Text.` }] }] };

  let res: GeminiResponse;
  if (!gemma) res = await call(structured);
  else if (!gemmaHasSystem(model)) res = await call(merged);
  else {
    try {
      res = await call(plainSystem);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      res = await call(merged); // Fallback, falls das Modell Systemprompts doch nicht annimmt
    }
  }

  // Denk-Teile ("thought") der Modelle überspringen, nur die eigentliche Antwort auswerten
  const texts = (res.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text as string);
  if (texts.length === 0) {
    const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason;
    throw new Error(`Die KI hat keine Antwort geliefert${why ? ` (${why})` : ''}.`);
  }
  return parseJsonLoose(texts);
}

export class AiKeyError extends Error {}

/** Schickt Systemprompt + Nutzerprompt an den Anbieter und gibt das geparste JSON zurück. Fehler kommen verständlich auf Deutsch. */
export async function aiJson(s: AiSettings, system: string, user: string): Promise<unknown> {
  try {
    return await aiJsonRaw(s, system, user);
  } catch (err) {
    if (err instanceof HttpError) throw new AiKeyError(describeAiError(err, s.model || DEFAULT_MODEL[s.provider]));
    throw err;
  }
}

const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/i;
const OPENAI_SKIP = /(embed|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|search|instruct|davinci|babbage|codex)/i;

/**
 * Prüft den Key mit einer Anfrage an den Anbieter und liefert die nutzbaren Textmodelle.
 * Wirft AiKeyError mit verständlicher Meldung, wenn der Key nicht funktioniert.
 */
export async function listModels(provider: 'openai' | 'gemini', apiKey: string): Promise<string[]> {
  try {
    if (provider === 'openai') {
      const res = await fetchJson<{ data?: { id: string }[] }>('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      return (res.data ?? [])
        .map((m) => m.id)
        .filter((id) => OPENAI_CHAT.test(id) && !OPENAI_SKIP.test(id))
        .sort((a, b) => a.localeCompare(b));
    }
    const all: { name: string; supportedGenerationMethods?: string[] }[] = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const res = await fetchJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }>(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        { headers: { 'x-goog-api-key': apiKey } },
      );
      all.push(...(res.models ?? []));
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return all
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /(gemini|gemma)/i.test(m.name) && !/(embed|tts|image|live|audio|vision-only)/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 400 || err.status === 401 || err.status === 403) throw new AiKeyError('Der Anbieter hat den API-Key abgelehnt. Prüfe, ob er vollständig und gültig ist.');
      if (err.status === 429) throw new AiKeyError('Der Anbieter meldet ein Limit oder fehlendes Guthaben (429).');
      if (err.status === 0) throw new AiKeyError('Der Anbieter ist nicht erreichbar.');
      throw new AiKeyError(`Der Anbieter antwortete mit einem Fehler (${err.status}).`);
    }
    throw new AiKeyError('Der Anbieter ist nicht erreichbar.');
  }
}

/** Verständliche Meldung zu einem fehlgeschlagenen KI-Aufruf. */
export function describeAiError(err: unknown, model = ''): string {
  if (err instanceof HttpError) {
    let detail = '';
    try {
      const j = JSON.parse(err.body ?? '{}') as { error?: { message?: string } | string };
      detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '');
    } catch {
      // Antwort war zu lang und abgeschnitten: die Meldung trotzdem herauslesen
      detail = /"message"\s*:\s*"([^"]+)"/.exec(err.body ?? '')?.[1] ?? '';
    }
    detail = detail.slice(0, 200);
    if (err.status === 401 || err.status === 403 || (err.status === 400 && /api key/i.test(detail))) return 'Der Anbieter hat den API-Key abgelehnt.';
    if (err.status === 404) return `Das Modell wurde nicht gefunden oder unterstützt diese Anfrage nicht.${detail ? ` (${detail})` : ''}`;
    if (err.status === 429) return 'Der Anbieter meldet ein Limit oder fehlendes Guthaben (429).';
    if (err.status === 0) return 'Der Anbieter ist nicht erreichbar.';
    if (err.status >= 500) {
      return (
        `Der Anbieter meldet einen internen Serverfehler (${err.status}), auch nach mehreren Versuchen. ` +
        (isGemma(model)
          ? 'Das ist ein bekanntes Problem auf Googles Seite: Gemma 4 über die Gemini-API antwortet derzeit zeitweise mit 500, abhängig von der Auslastung. Dein Key und lxnEye sind in Ordnung. Versuche es später erneut oder nimm vorübergehend ein Gemini-Modell.'
          : 'Das liegt auf Seiten des Anbieters. Versuche es später erneut.')
      );
    }
    return `Der Anbieter hat die Anfrage abgelehnt (${err.status})${detail ? `: ${detail}` : ''}.`;
  }
  return err instanceof Error ? err.message : 'Unbekannter Fehler';
}

/** Schickt eine winzige Testanfrage an das gewählte Modell und misst die Antwortzeit. */
export async function pingModel(s: AiSettings): Promise<{ ms: number; model: string }> {
  const started = Date.now();
  try {
    const out = await aiJson(s, 'Du bist ein Verbindungstest. Antworte ausschließlich mit dem JSON {"ok":true}.', 'Test');
    if (!out || typeof out !== 'object') throw new Error('Die KI hat keine auswertbare Antwort geliefert.');
  } catch (err) {
    throw err instanceof AiKeyError ? err : new AiKeyError(describeAiError(err));
  }
  return { ms: Date.now() - started, model: s.model || DEFAULT_MODEL[s.provider] };
}
