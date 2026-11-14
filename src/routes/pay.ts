import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { IconService } from "../icons.js";
import type { InvoiceService } from "../invoices/service.js";
import { serializePublicAttempt, serializePublicInvoice } from "../invoices/serialize.js";
import { isTerminalAttempt } from "../invoices/states.js";
import { OneClickError, type OneClickClient } from "../oneclick/client.js";
import type { TokenCache } from "../oneclick/tokens.js";
import type { SettingsReader } from "../settings/store.js";
import { chainsPayload, parse } from "./http.js";
import { registerHostedPage } from "./pages.js";

export interface PayRouteOptions {
  allowedOrigins: string[];
  rateLimit: { max: number; timeWindow: string };
  service: InvoiceService;
  client: Pick<OneClickClient, "depositSubmit">;
  tokens: TokenCache;
  /** The payer sees an invoice in the asset it was made in. */
  settings: SettingsReader;
  extraChains: string[];
  /** When set, `/pay/tokens` names each token's image. */
  icons?: IconService;
}

const attemptBody = z.object({
  originAsset: z.string().min(1).max(300),
  refundTo: z.string().min(1).max(200),
});
const txBody = z.object({ txHash: z.string().min(1).max(200) });

function mapDepositError(e: unknown): unknown {
  if (!(e instanceof OneClickError)) return e;
  if (e.status === 0) return new ApiError(503, "upstream_unavailable", e.message);
  if (e.status === 400 || e.status === 404) return new ApiError(422, "tx_rejected", e.message);
  return new ApiError(502, "upstream_error", e.message);
}

/** `/pay/*`: what the checkout widget calls. No auth; CORS-enabled and rate limited per IP. */
export const payRoutes: FastifyPluginAsync<PayRouteOptions> = async (app, opts) => {
  const { service } = opts;

  await app.register(cors, {
    origin: opts.allowedOrigins.includes("*") ? "*" : opts.allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
  });
  await app.register(rateLimit, opts.rateLimit);

  const view = (attemptId: string) => {
    const attempt = service.getAttempt(attemptId);
    return serializePublicAttempt(attempt, service.getInvoice(attempt.invoiceId).status);
  };

  app.get<{ Params: { id: string } }>("/invoices/:id", async (request) =>
    serializePublicInvoice(
      service.getInvoice(request.params.id),
      opts.settings.tokenFor(service.getInvoice(request.params.id).assetId),
    ),
  );

  app.get("/tokens", async () => chainsPayload(opts.tokens, opts.extraChains, opts.icons));

  registerHostedPage(app);

  app.post<{ Params: { id: string } }>("/invoices/:id/attempts", async (request, reply) => {
    const body = parse(attemptBody, request.body);
    const attempt = await service.createAttempt(request.params.id, body);
    return reply.code(201).send(view(attempt.id));
  });

  app.get<{ Params: { id: string } }>("/attempts/:id", async (request) => view(request.params.id));

  // Optional: a wallet that knows the tx hash can tell 1Click early so it verifies the deposit sooner.
  app.post<{ Params: { id: string } }>("/attempts/:id/tx", async (request) => {
    const { txHash } = parse(txBody, request.body);
    const attempt = service.getAttempt(request.params.id);
    if (isTerminalAttempt(attempt.status)) {
      throw new ApiError(409, "attempt_closed", `Attempt ${attempt.id} is ${attempt.status}.`);
    }
    let response;
    try {
      response = await opts.client.depositSubmit({
        txHash,
        depositAddress: attempt.depositAddress,
        ...(attempt.depositMemo ? { memo: attempt.depositMemo } : {}),
      });
    } catch (e) {
      throw mapDepositError(e);
    }
    service.applyStatus(attempt.id, response);
    return view(attempt.id);
  });
};
