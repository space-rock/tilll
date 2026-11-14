import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ApiError } from "../errors.js";
import type { Icon, IconService } from "../icons.js";
import type { TokenCache } from "../oneclick/tokens.js";
import { chainsPayload } from "./http.js";

export interface IconRouteOptions {
  icons: IconService;
  tokens: TokenCache;
  extraChains: string[];
}

/** One checkout page asks for a few dozen images at once, so these routes have a limit of their own. */
const LIMIT = { max: 1200, timeWindow: "1 minute" };

const send = (reply: FastifyReply, icon: Icon) =>
  reply
    .header("content-type", icon.type)
    .header("cache-control", "public, max-age=86400")
    // Opened on its own, it is still only a picture: no sniffing, no script, and an <img> on any page may load it.
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cross-origin-resource-policy", "cross-origin")
    .send(icon.bytes);

const missing = () => new ApiError(404, "not_found", "No such image.");

/** `/pay/icons/*`: token and network images, kept by this server so the payer's browser only talks to it. */
export const iconRoutes: FastifyPluginAsync<IconRouteOptions> = async (app, opts) => {
  await app.register(rateLimit, LIMIT);

  app.get<{ Params: { id: string } }>("/token/:id", async (request, reply) => {
    const icon = await opts.icons.tokenIcon(request.params.id);
    if (!icon) throw missing();
    return send(reply, icon);
  });

  app.get<{ Params: { code: string } }>("/chain/:code", async (request, reply) => {
    const { enabledChains } = await chainsPayload(opts.tokens, opts.extraChains);
    const { code } = request.params;
    const icon = enabledChains.includes(code) ? await opts.icons.chainIcon(code) : undefined;
    if (!icon) throw missing();
    return send(reply, icon);
  });
};
