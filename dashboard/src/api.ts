/** Calls to Tilll. The session cookie travels by itself; writes also carry the session's CSRF token. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | undefined;
let onUnauthorized: (() => void) | undefined;

/** Called when the server says the session is over (a 401 from anything but login). */
export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  onUnauthorized = handler;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  try {
    return await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, "network", "We couldn't reach your Tilll server. Check that it's running.");
  }
}

async function failure(response: Response): Promise<ApiError> {
  let code = "error";
  let message = `Something went wrong (error ${response.status}). Try again.`;
  try {
    const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code ?? code;
    message = parsed.error?.message ?? message;
  } catch {
    // keep the generic message
  }
  return new ApiError(response.status, code, message);
}

/** A call to `/v1/*` (or `/dashboard/api/*`). Throws ApiError; a 401 also tells the app to show the login page. */
export async function request<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await send(method, path, body);
  if (!response.ok) {
    const error = await failure(response);
    if (response.status === 401) onUnauthorized?.();
    throw error;
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Log in with the merchant secret. Throws ApiError if it is wrong. */
export async function login(secret: string): Promise<void> {
  const response = await send("POST", "/dashboard/api/login", { secret });
  if (!response.ok) throw await failure(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
}

/** Is there a live session already (a reload)? Learns its CSRF token if so. */
export async function restoreSession(): Promise<boolean> {
  const response = await send("GET", "/dashboard/api/session");
  if (!response.ok) return false;
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  return true;
}

export async function logout(): Promise<void> {
  csrfToken = undefined;
  await send("POST", "/dashboard/api/logout");
}
