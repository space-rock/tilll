import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { SECRET, makeApp } from "./helpers/app.js";

/** The server's own log lines, captured: what an operator's log file or log service would hold. */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => lines.join("") };
}

describe("what the server writes to its log", () => {
  it("never holds a secret, a session, a CSRF token or a request body, whatever the request", async () => {
    const log = capture();
    const { app } = await makeApp({
      logger: { level: "info", stream: log.stream, redact: ["req.headers.authorization"] },
    });

    // a login (the secret is in the body), a bearer call, a cookie call with a CSRF token, a wrong secret, and a failure
    const login = await app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret: SECRET } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const csrf = login.json().csrfToken as string;
    await app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret: "wrong-secret-value" } });
    await app.inject({ method: "GET", url: "/v1/invoices", headers: { authorization: `Bearer ${SECRET}` } });
    await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { amount: "5.00", description: "a private description" },
    });
    // an unexpected error: the stub refund service throws, which is a 500 that is logged with its error
    await app.inject({ method: "GET", url: "/v1/balance", headers: { authorization: `Bearer ${SECRET}` } });

    const logged = log.text();
    expect(logged.length).toBeGreaterThan(100); // it did log requests, so the checks below mean something
    expect(logged).toMatch(/"url":"\/v1\/invoices"/);
    for (const secret of [
      SECRET,
      "wrong-secret-value",
      csrf,
      cookie.slice(`${SESSION_COOKIE}=`.length),
      "a private description",
    ]) {
      expect(logged, `the log holds ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
    expect(logged).not.toMatch(/authorization|cookie|x-csrf-token/i);
  });
});
