// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, login, logout, request, restoreSession, setUnauthorizedHandler } from "../dashboard/src/api.js";
import { failureOf } from "./helpers/failure.js";
import { mockApi } from "./helpers/dashboardApi.js";

afterEach(() => {
  setUnauthorizedHandler(undefined);
  vi.unstubAllGlobals();
});

describe("the dashboard's API client", () => {
  it("sends reads with the cookie only, and writes with the CSRF token it got at login", async () => {
    const api = mockApi({
      "POST /dashboard/api/login": { body: { csrfToken: "csrf-1" } },
      "GET /v1/invoices": { body: { invoices: [] } },
      "POST /v1/invoices": { status: 201, body: { id: "inv_1" } },
    });
    await login("secret");
    await request("GET", "/v1/invoices");
    await request("POST", "/v1/invoices", { amount: "5" });

    expect(api.calls[1]!.headers["x-csrf-token"]).toBeUndefined();
    expect(api.calls[2]!.headers["x-csrf-token"]).toBe("csrf-1");
    expect(api.calls[2]!.headers["content-type"]).toBe("application/json");
    expect(api.calls[2]!.body).toEqual({ amount: "5" });
  });

  it("never puts the secret anywhere but the login request", async () => {
    const api = mockApi({
      "POST /dashboard/api/login": { body: { csrfToken: "c" } },
      "GET /v1/invoices": { body: {} },
    });
    await login("hunter2-secret");
    await request("GET", "/v1/invoices");
    expect(JSON.stringify(api.calls.slice(1))).not.toContain("hunter2-secret");
  });

  it("learns the CSRF token again after a reload, and says whether there is a session", async () => {
    const live = mockApi({
      "GET /dashboard/api/session": { body: { csrfToken: "csrf-2" } },
      "POST /v1/invoices": { body: {} },
    });
    expect(await restoreSession()).toBe(true);
    await request("POST", "/v1/invoices", {});
    expect(live.calls.at(-1)!.headers["x-csrf-token"]).toBe("csrf-2");
    const api = mockApi({
      "GET /dashboard/api/session": { status: 401, body: { error: { code: "unauthorized", message: "no" } } },
    });
    expect(await restoreSession()).toBe(false);
    expect(api.calls).toHaveLength(1);
  });

  it("turns an error answer into an ApiError with the server's code and message", async () => {
    mockApi({
      "POST /v1/invoices/inv_1/refunds": {
        status: 409,
        body: { error: { code: "insufficient_balance", message: "Too little." } },
      },
    });
    const error = await failureOf(ApiError, () => request("POST", "/v1/invoices/inv_1/refunds", {}));
    expect(error).toMatchObject({ status: 409, code: "insufficient_balance", message: "Too little." });
  });

  it("copes with an error that is not JSON, and with no network", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await failureOf(ApiError, () => request("GET", "/v1/x"))).toMatchObject({ status: 502, code: "error" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("failed to fetch");
    });
    expect(await failureOf(ApiError, () => request("GET", "/v1/x"))).toMatchObject({ status: 0, code: "network" });
  });

  it("tells the app when the session is over, but not for a wrong secret at login", async () => {
    const handler = vi.fn<() => void>();
    setUnauthorizedHandler(handler);
    mockApi({
      "GET /v1/invoices": { status: 401, body: { error: { code: "unauthorized", message: "x" } } },
      "POST /dashboard/api/login": { status: 401, body: { error: { code: "unauthorized", message: "Wrong." } } },
    });

    await failureOf(ApiError, () => login("wrong"));
    expect(handler).not.toHaveBeenCalled();

    await failureOf(ApiError, () => request("GET", "/v1/invoices"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops sending the CSRF token after logout", async () => {
    const api = mockApi({
      "POST /dashboard/api/login": { body: { csrfToken: "csrf-3" } },
      "POST /dashboard/api/logout": { status: 204 },
      "POST /v1/invoices": { body: {} },
    });
    await login("s");
    await logout();
    await request("POST", "/v1/invoices", {});
    expect(api.calls.at(-1)!.headers["x-csrf-token"]).toBeUndefined();
  });

  it("returns nothing for 204", async () => {
    mockApi({ "POST /dashboard/api/logout": { status: 204 } });
    expect(await request("POST", "/dashboard/api/logout")).toBeUndefined();
  });
});
