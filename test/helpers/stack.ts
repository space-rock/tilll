import { vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { signNep413 } from "../../src/near/nep413.js";
import { createRefundService } from "../../src/refunds/service.js";
import { TEST_SECRET, VERIFIER } from "./refundWorld.js";
import { createWebhookHandler, type ReceivedEvent } from "../../demo-store/webhook-receiver.js";
import { openDb } from "../../src/db/index.js";
import type { SettingDefaults } from "../../src/settings/store.js";
import { createInvoiceService } from "../../src/invoices/service.js";
import { createOneClickClient } from "../../src/oneclick/client.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import { buildServer } from "../../src/server.js";
import { createPoller } from "../../src/watcher/poller.js";
import { createDispatcher } from "../../src/webhooks/dispatcher.js";
import { startFakeOneClick } from "./fakeOneClick.js";
import { createWebhookLog } from "../../src/webhooks/log.js";
import { AUTH, INFO, SECRET, makeAccountProof } from "./app.js";
import { createSettingsStore } from "../../src/settings/store.js";
import { SETTINGS_DEFAULTS } from "./settingsData.js";
import { START } from "./oneclickData.js";

export const WEBHOOK_SECRET = "whsec_stack_test";

export const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

/**
 * The whole server with nothing stubbed except the clock: real client over real HTTP to a fake 1Click, real
 * SQLite, real service, poller and routes (driven through `app.inject`).
 */
export async function makeStack(
  options: {
    apiKey?: string;
    memoChains?: string[];
    fakeMemoChains?: string[];
    startAt?: Date;
    webhookSecret?: string;
    defaults?: Partial<SettingDefaults>;
  } = {},
) {
  let time = (options.startAt ?? START).getTime();
  const clock = {
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
  const fake = await startFakeOneClick({
    ...(options.fakeMemoChains ? { memoChains: options.fakeMemoChains } : {}),
    now: clock.now,
    verifier: VERIFIER,
  });
  const client = createOneClickClient({ baseUrl: fake.url, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
  const tokens = createTokenCache({ client });

  // A merchant endpoint on loopback: the real receiver, with a switch to make it fail like a server that is down.
  const receiverState = {
    failing: false,
    events: [] as ReceivedEvent[],
    deliveries: [] as { headers: Headers; rawBody: string }[],
  };
  const handler = createWebhookHandler({
    secret: WEBHOOK_SECRET,
    // The test clock jumps minutes ahead of the real one; a real deployment keeps the 5 minute default.
    toleranceSeconds: 24 * 3600,
    onEvent: (event) => {
      if (receiverState.failing) throw new Error("merchant server is down");
      receiverState.events.push(event);
    },
  });
  const receiverServer = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => receiverServer.listen(0, "127.0.0.1", resolve));
  const receiverUrl = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/hooks/tilll`;
  const recordingFetch: typeof fetch = (input, init) => {
    receiverState.deliveries.push({ headers: new Headers(init?.headers), rawBody: String(init?.body) });
    return fetch(input, init);
  };
  const db = openDb(":memory:");
  // The real store, over the real token list from the fake 1Click.
  const settings = await createSettingsStore({
    db,
    tokens,
    defaults: { ...SETTINGS_DEFAULTS, webhookUrl: receiverUrl, ...options.defaults },
    now: clock.now,
  });
  const service = createInvoiceService({
    db,
    client,
    tokens,
    settings,
    config: { memoChains: options.memoChains ?? ["stellar"] },
    now: clock.now,
  });
  const balance = { value: 1_000_000_000n };
  const refunds = createRefundService({
    db,
    client,
    settings,
    config: { intentsContract: VERIFIER },
    readBalance: async () => balance.value,
    keyRegistered: async () => true,
    now: clock.now,
  });
  const dispatcher = createDispatcher({
    db,
    url: () => settings.current().webhookUrl,
    secret: options.webhookSecret ?? WEBHOOK_SECRET,
    fetch: recordingFetch,
    now: clock.now,
    log: { error: () => undefined },
  });

  const proof = makeAccountProof();
  const log = { error: vi.fn<(message: string, error: unknown) => void>() };
  const poller = createPoller({ service, refunds, client, log, now: clock.now });
  const app = await buildServer({
    merchantSecret: SECRET,
    allowedOrigins: ["*"],
    service,
    refunds,
    client,
    tokens,
    settings,
    accountProof: proof.accountProof,
    webhooks: dispatcher,
    webhookLog: createWebhookLog(db),
    info: INFO,
  });

  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    headers?: Record<string, string>,
  ) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(headers ? { headers } : {}) });

  return {
    db,
    clock,
    fake,
    poller,
    log,
    dispatcher,
    receiver: receiverState,
    service,
    refunds,
    settings,
    accessKeys: proof.accessKeys,
    /** The settlement balance the refund service sees. */
    balance,
    app,
    /** Merchant API call, authenticated. */
    merchant: (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
      call(method, url, payload, AUTH),
    /** Public pay API call, no auth. */
    pay: (method: "GET" | "POST", url: string, payload?: object) => call(method, url, payload),
    /**
     * The merchant's wallet, over HTTP like the dashboard: prepare a refund, sign what the server prepared with a test
     * key, and send the signature back. Returns the answer to the last call.
     */
    approve: async (refundId: string) => {
      const prepared = await call("POST", `/v1/refunds/${refundId}/prepare`, {}, AUTH);
      if (prepared.statusCode !== 200) return prepared;
      const signed = signNep413(TEST_SECRET, prepared.json().payload);
      return call(
        "POST",
        `/v1/refunds/${refundId}/submit`,
        { publicKey: signed.public_key, signature: signed.signature },
        AUTH,
      );
    },
    events: () =>
      (
        db.prepare("SELECT payload_json FROM webhook_deliveries ORDER BY rowid").all() as { payload_json: string }[]
      ).map(
        (r) =>
          JSON.parse(r.payload_json) as {
            type: string;
            data: Record<string, any>;
            proof?: Record<string, string>;
            proofVerified?: boolean;
          },
      ),
    close: async () => {
      await app.close();
      await fake.close();
      receiverServer.closeAllConnections();
      await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    },
  };
}

export type Stack = Awaited<ReturnType<typeof makeStack>>;
