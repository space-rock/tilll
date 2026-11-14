import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { ToastProvider } from "../../dashboard/src/components/ui/toast.js";
import {
  WalletProvider,
  type ConnectorFactory,
  type ConnectorHandle,
  type WalletHandle,
} from "../../dashboard/src/wallet.js";

/** A wallet that signs whatever it is asked to, for dashboard tests. Nothing here talks to a real wallet. */
export function stubWallet(
  over: { account?: string; publicKey?: string; signature?: string; signFails?: string } = {},
) {
  const account = over.account ?? "demo-shop.near";
  const wallet = {
    getAccounts: vi.fn<WalletHandle["getAccounts"]>(async () => [{ accountId: account }]),
    signMessage: vi.fn<WalletHandle["signMessage"]>(async () => {
      if (over.signFails) throw new Error(over.signFails);
      return {
        accountId: account,
        publicKey: over.publicKey ?? "ed25519:WALLETKEY",
        signature: over.signature ?? "WALLETSIGNATURE",
      };
    }),
    signAndSendTransaction: vi.fn<WalletHandle["signAndSendTransaction"]>(async () => ({})),
  } satisfies WalletHandle;
  const connector = {
    connect: vi.fn<ConnectorHandle["connect"]>(async () => wallet),
    getConnectedWallet: vi.fn<ConnectorHandle["getConnectedWallet"]>(async () => ({
      wallet,
      accounts: [{ accountId: account }],
    })),
    disconnect: vi.fn<ConnectorHandle["disconnect"]>(async () => undefined),
    on: vi.fn<NonNullable<ConnectorHandle["on"]>>(),
  } satisfies ConnectorHandle;
  const factory = vi.fn<ConnectorFactory>(async () => connector);
  return { wallet, connector, factory };
}

/** Render with the toasts and a wallet provider, as the dashboard has them. `connected` starts the wallet restored. */
export function renderWithWallet(
  ui: ReactElement,
  stub: ReturnType<typeof stubWallet>,
  options: { connected?: boolean; expectedAccount?: string } = {},
) {
  try {
    if (options.connected === false) localStorage.removeItem("tilll-wallet");
    else localStorage.setItem("tilll-wallet", "1");
  } catch {
    // the wallet just starts disconnected
  }
  return render(
    <ToastProvider>
      <WalletProvider
        network="mainnet"
        expectedAccount={options.expectedAccount ?? "demo-shop.near"}
        intentsContract="intents.near"
        factory={stub.factory}
      >
        {ui}
      </WalletProvider>
    </ToastProvider>,
  );
}
