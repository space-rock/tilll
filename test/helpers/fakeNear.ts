import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A NEAR node on loopback that answers every view call with `value` (a balance, say) and remembers what it was asked.
 * Enough for Tilll's balance reads; it is not a node.
 */
export async function startFakeNear(value: string, options: { keyRegistered?: boolean } = {}) {
  const asked: { account_id: string; method_name: string; args: unknown }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { params } = JSON.parse(Buffer.concat(chunks).toString()) as {
        params: { account_id: string; method_name: string; args_base64: string };
      };
      asked.push({
        account_id: params.account_id,
        method_name: params.method_name,
        args: JSON.parse(Buffer.from(params.args_base64, "base64").toString()),
      });
      res.writeHead(200, { "content-type": "application/json" });
      // `has_public_key` answers true or false; every other view call (the balance) answers `value`.
      const answer = params.method_name === "has_public_key" ? (options.keyRegistered ?? true) : value;
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: "tilll", result: { result: [...Buffer.from(JSON.stringify(answer))] } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export type FakeNear = Awaited<ReturnType<typeof startFakeNear>>;
