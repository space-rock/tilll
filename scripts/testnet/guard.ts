/**
 * Fail-closed guard for the testnet development harness. The harness talks to a community-run, anonymous
 * third-party service (Tidepool), so it must be impossible for it to reach the real 1Click, mainnet NEAR, or
 * to send a real API key anywhere. Allowlists, not patterns: anything not named here is refused.
 */

export const TESTNET_BASE_URL = "https://www.usetidepool.tech";
/** The only API key value the harness may send. Tidepool accepts any value; a real partner key must never leave the machine. */
export const DUMMY_API_KEY = "tidepool-testnet-dummy";

const TESTNET_RPC_HOSTS = new Set([
  "test.rpc.fastnear.com",
  "rpc.testnet.near.org",
  "archival-rpc.testnet.near.org",
  "near-testnet.drpc.org",
  "testnet-rpc.intea.rs",
]);

const TESTNET_ACCOUNT = /^[a-z0-9._-]+\.testnet$/;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export class TestnetGuardError extends Error {
  constructor(readonly violations: string[]) {
    super(
      `Refusing to run: this harness only talks to the Tidepool testnet.\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    );
    this.name = "TestnetGuardError";
  }
}

export interface TestnetTargets {
  oneClickBaseUrl: string;
  nearRpcUrl: string;
  intentsContract: string;
  accountIds: string[];
  /** What would be sent as X-API-Key. Unset, or exactly DUMMY_API_KEY. */
  apiKey?: string | undefined;
}

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** Throws listing every way the configuration points somewhere other than the testnet. */
export function assertTestnetTargets(targets: TestnetTargets): void {
  const problems: string[] = [];

  const base = parse(targets.oneClickBaseUrl);
  const baseOk =
    base !== undefined &&
    base.protocol === "https:" &&
    base.hostname === new URL(TESTNET_BASE_URL).hostname &&
    base.username === "" &&
    base.password === "" &&
    base.port === "" &&
    (base.pathname === "/" || base.pathname === "");
  if (!baseOk) {
    problems.push(`1Click base URL must be ${TESTNET_BASE_URL} (got host "${base?.hostname ?? "(not a URL)"}").`);
  }

  const rpc = parse(targets.nearRpcUrl);
  if (!rpc || rpc.protocol !== "https:" || !TESTNET_RPC_HOSTS.has(rpc.hostname)) {
    problems.push(`NEAR RPC host "${rpc?.hostname ?? "(not a URL)"}" is not a known testnet RPC.`);
  }

  if (!TESTNET_ACCOUNT.test(targets.intentsContract)) {
    problems.push(`verifier contract "${targets.intentsContract}" is not a testnet contract.`);
  }

  for (const id of targets.accountIds) {
    if (!TESTNET_ACCOUNT.test(id) && !IMPLICIT_ACCOUNT.test(id)) {
      problems.push(`account "${id}" is not a .testnet or 64 character lowercase hex account.`);
    }
  }

  if (targets.apiKey !== undefined && targets.apiKey !== DUMMY_API_KEY) {
    problems.push("API key must be unset or the dummy value: a real key must never be sent to the third party.");
  }

  if (problems.length) throw new TestnetGuardError(problems);
}

/** Check Tidepool's own /v0/health answer before trusting it: testnet, healthy, and the verifier we configured. */
export function assertTestnetHealth(health: unknown, expectedVerifier: string): void {
  const h = (typeof health === "object" && health !== null ? health : {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (h.network !== "testnet") problems.push(`/v0/health says network "${String(h.network)}", not "testnet".`);
  if (h.ok !== true) problems.push("/v0/health does not report ok: true.");
  if (h.verifier !== expectedVerifier || typeof h.verifier !== "string" || !h.verifier.endsWith(".testnet")) {
    problems.push(
      `/v0/health reports verifier "${String(h.verifier)}", expected the testnet verifier "${expectedVerifier}".`,
    );
  }
  if (problems.length) throw new TestnetGuardError(problems);
}
