let csrf = '';
export const setCsrf = (t: string): void => {
  csrf = t;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* kein JSON */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}
