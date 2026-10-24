import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiKeyError, aiJson, listModels, pingModel, setRetryDelays } from './ai.js';

const respond = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

setRetryDelays([0, 0, 0]);
afterEach(() => vi.restoreAllMocks());

describe('KI-Verbindung prüfen', () => {
  it('liefert bei OpenAI nur Textmodelle', async () => {
    respond(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'o3-mini' }, { id: 'dall-e-3' }, { id: 'gpt-4o-audio-preview' }, { id: 'gpt-4.1' }] });
    expect(await listModels('openai', 'sk-test-key-123')).toEqual(['gpt-4.1', 'gpt-4o-mini', 'o3-mini']);
  });

  it('liefert bei Gemini nur Modelle mit generateContent', async () => {
    respond(200, {
      models: [
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      ],
    });
    expect(await listModels('gemini', 'AIza-test-key-123')).toEqual(['gemini-2.0-flash', 'gemini-2.5-pro']);
  });

  it('übersetzt Fehler in verständliche Meldungen und sendet den Key im Header', async () => {
    const spy = respond(401, { error: 'x' });
    await expect(listModels('openai', 'sk-falsch-123456')).rejects.toThrow(/abgelehnt/);
    expect(((spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer sk-falsch-123456');
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('sk-falsch');
    respond(429, {});
    await expect(listModels('gemini', 'AIza-123456789')).rejects.toBeInstanceOf(AiKeyError);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(listModels('openai', 'sk-test-key-123')).rejects.toThrow(/nicht erreichbar/);
  });

  it('listet bei Gemini auch Gemma-Modelle', async () => {
    respond(200, {
      models: [
        { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });
    expect(await listModels('gemini', 'AIza-test-key-123')).toEqual(['gemini-2.0-flash', 'gemma-3-27b-it']);
  });
});

describe('Gemma 4', () => {
  const gemini = (parts: object[]) => ({ candidates: [{ content: { parts } }] });
  const KEY = 'AIza-test-key-123';

  it('überspringt Denk-Teile und liest die Antwort dahinter', async () => {
    respond(200, gemini([{ text: 'Ich überlege {kurz} ...', thought: true }, { text: '{"ok":true}' }]));
    expect(await aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' }, 'S', 'U')).toEqual({ ok: true });
  });

  it('findet das JSON auch, wenn der Denk-Teil nicht markiert ist', async () => {
    respond(200, gemini([{ text: 'Plan: erst {nachdenken}.' }, { text: '```json\n{"sections":[{"title":"a","text":"b"}]}\n```' }]));
    const out = (await aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-26b-a4b-it' }, 'S', 'U')) as { sections: unknown[] };
    expect(out.sections).toHaveLength(1);
  });

  it('nutzt bei Gemma 4 den Systemprompt ohne JSON-Modus', async () => {
    const spy = respond(200, gemini([{ text: '{"ok":true}' }]));
    await aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' }, 'SYSTEM', 'USER');
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.systemInstruction.parts[0].text).toBe('SYSTEM');
    expect(body.generationConfig).toBeUndefined();
  });

  it('fällt bei einem 400 auf den zusammengesetzten Prompt zurück', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Developer instruction is not enabled' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(gemini([{ text: '{"ok":true}' }])), { status: 200 }));
    expect(await aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' }, 'SYSTEM', 'USER')).toEqual({ ok: true });
    const second = JSON.parse((spy.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(second.systemInstruction).toBeUndefined();
    expect(second.contents[0].parts[0].text).toContain('SYSTEM');
  });

  it('meldet blockierte oder leere Antworten verständlich', async () => {
    respond(200, { candidates: [{ finishReason: 'SAFETY' }] });
    await expect(aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' }, 'S', 'U')).rejects.toThrow(/SAFETY/);
  });

  it('liest alle Seiten der Modellliste', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'p2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 }));
    expect(await listModels('gemini', KEY)).toEqual(['gemini-2.0-flash', 'gemma-4-31b-it']);
  });
});

describe('Serverfehler beim Anbieter', () => {
  const KEY = 'AIza-test-key-123';
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  const err500 = () => new Response(JSON.stringify({ error: { message: 'Internal error encountered.' } }), { status: 500 });

  it('wiederholt bei 500 und liefert dann die Antwort', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(err500()).mockResolvedValueOnce(err500()).mockResolvedValueOnce(ok());
    expect(await aiJson({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' }, 'S', 'U')).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('erklärt anhaltende 500er bei Gemma als Problem auf Googles Seite', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => err500());
    await expect(pingModel({ provider: 'gemini', apiKey: KEY, model: 'gemma-4-31b-it' })).rejects.toThrow(/Googles Seite.*Gemma 4/);
    expect(spy).toHaveBeenCalledTimes(4); // 1 Versuch + 3 Wiederholungen
  });

  it('wiederholt nicht bei Key-Fehlern', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 401 }));
    await expect(aiJson({ provider: 'openai', apiKey: 'sk-xxxxxxxx', model: '' }, 'S', 'U')).rejects.toThrow(/API-Key/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('Gemma-Besonderheiten', () => {
  const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

  it('sendet für Gemma weder Systemprompt noch JSON-Modus und liest umrahmtes JSON', async () => {
    const spy = respond(200, gemini('Klar! ```json\n{"ok":true}\n``` Gern geschehen.'));
    const out = await aiJson({ provider: 'gemini', apiKey: 'AIza-test-key-123', model: 'gemma-3-27b-it' }, 'SYSTEM', 'USER');
    expect(out).toEqual({ ok: true });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.generationConfig).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain('SYSTEM');
  });

  it('nutzt für Gemini weiter Systemprompt und JSON-Modus', async () => {
    const spy = respond(200, gemini('{"ok":true}'));
    await aiJson({ provider: 'gemini', apiKey: 'AIza-test-key-123', model: 'gemini-2.0-flash' }, 'SYSTEM', 'USER');
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.systemInstruction.parts[0].text).toBe('SYSTEM');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('meldet bei einem Verbindungstest die Antwortzeit oder einen klaren Fehler', async () => {
    respond(200, gemini('{"ok":true}'));
    const r = await pingModel({ provider: 'gemini', apiKey: 'AIza-test-key-123', model: '' });
    expect(r.model).toBe('gemini-2.0-flash');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    respond(400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ pad: 'x'.repeat(700) }] } });
    await expect(pingModel({ provider: 'gemini', apiKey: 'AIza-test-key-123', model: '' })).rejects.toThrow(/API-Key abgelehnt/);
    respond(404, { error: { message: 'models/x is not found' } });
    await expect(pingModel({ provider: 'gemini', apiKey: 'AIza-test-key-123', model: 'x' })).rejects.toThrow(/Modell wurde nicht gefunden/);
  });
});
