export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null | undefined;
  /** The body string exactly as sent, for checking signatures over the raw bytes. */
  rawBody: string | undefined;
  redirect: RequestRedirect | undefined;
}

/** A fetch stand-in that records every call and answers with a canned JSON response. */
export function fakeFetch(respond: (call: RecordedCall) => { status?: number; body?: unknown; text?: string }) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
      rawBody: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    const r = respond(call);
    const status = r.status ?? 200;
    // 204, 205 and 304 may not carry a body.
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : (r.text ?? JSON.stringify(r.body ?? {})), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}
