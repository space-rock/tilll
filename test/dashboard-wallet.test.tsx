// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../dashboard/src/components/ui/toast.js";
import { WalletButton } from "../dashboard/src/components/WalletButton.js";
import { WalletProvider, useWallet, type ConnectorFactory } from "../dashboard/src/wallet.js";
import { stubWallet } from "./helpers/dashboardWallet.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.head.querySelectorAll('meta[name="csp-nonce"]').forEach((m) => m.remove());
});
beforeEach(() => localStorage.clear());

/** Shows what the wallet hook says, and gives buttons for what it can do. */
function Probe({ actions }: { actions?: (w: ReturnType<typeof useWallet>) => void }) {
  const wallet = useWallet();
  actions?.(wallet);
  return (
    <div>
      <p data-testid="status">{wallet.status}</p>
      <p data-testid="account">{wallet.accountId ?? "none"}</p>
      <p data-testid="matches">{String(wallet.matches)}</p>
      <button onClick={() => void wallet.connect().catch(() => undefined)}>connect</button>
      <button onClick={() => void wallet.disconnect().catch(() => undefined)}>disconnect</button>
    </div>
  );
}

function mount(
  stub: ReturnType<typeof stubWallet> | { factory: ConnectorFactory },
  props: { network?: "mainnet" | "testnet" | undefined; expectedAccount?: string | undefined } = {},
  ui: React.ReactNode = <Probe />,
) {
  return render(
    <ToastProvider>
      <WalletProvider
        network={"network" in props ? props.network : "mainnet"}
        expectedAccount={"expectedAccount" in props ? props.expectedAccount : "demo-shop.near"}
        intentsContract="intents.near"
        factory={stub.factory}
      >
        {ui}
      </WalletProvider>
    </ToastProvider>,
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("the wallet", () => {
  it("is not loaded until it is needed: a dashboard that was never connected never downloads the library", async () => {
    const stub = stubWallet();
    mount(stub);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.factory).not.toHaveBeenCalled();
    expect(text("status")).toBe("disconnected");
  });

  it("connects when asked, remembers it, and says whether it is the settlement account", async () => {
    const stub = stubWallet();
    mount(stub);

    fireEvent.click(screen.getByText("connect"));

    await waitFor(() => expect(text("status")).toBe("connected"));
    expect(text("account")).toBe("demo-shop.near");
    expect(text("matches")).toBe("true");
    expect(stub.factory).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tilll-wallet")).toBe("1");
  });

  it("knows when it is signed in as some other account, which cannot approve refunds", async () => {
    mount(stubWallet({ account: "someone-else.near" }));
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(text("status")).toBe("connected"));
    expect(text("matches")).toBe("false");
  });

  it("is restored when the page opens again, without asking, because it stays connected", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    mount(stub);
    await waitFor(() => expect(text("status")).toBe("connected"));
    expect(text("account")).toBe("demo-shop.near");
    expect(stub.connector.getConnectedWallet).toHaveBeenCalled();
    expect(stub.connector.connect).not.toHaveBeenCalled(); // no popup
  });

  it("waits for the settings before it restores, because the network comes from them", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    const view = mount(stub, { network: undefined });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.factory).not.toHaveBeenCalled();
    view.unmount();
  });

  it("forgets a wallet that cannot be restored, and starts disconnected", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    stub.connector.getConnectedWallet.mockRejectedValueOnce(new Error("no session"));
    mount(stub);
    await waitFor(() => expect(localStorage.getItem("tilll-wallet")).toBeNull());
    expect(text("status")).toBe("disconnected");
  });

  it("disconnects, and forgets", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    mount(stub);
    await waitFor(() => expect(text("status")).toBe("connected"));

    fireEvent.click(screen.getByText("disconnect"));

    await waitFor(() => expect(text("status")).toBe("disconnected"));
    expect(stub.connector.disconnect).toHaveBeenCalled();
    expect(localStorage.getItem("tilll-wallet")).toBeNull();
  });

  it("follows the wallet when it signs itself out", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    mount(stub);
    await waitFor(() => expect(text("status")).toBe("connected"));
    const signOut = stub.connector.on.mock.calls.find((c) => c[0] === "wallet:signOut")![1] as () => void;

    act(() => signOut());

    expect(text("status")).toBe("disconnected");
    expect(localStorage.getItem("tilll-wallet")).toBeNull();
  });

  it("hands the connector the network and the page's script nonce, which the wallet code runs under", async () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "NONCE123==";
    document.head.append(meta);
    const stub = stubWallet();
    mount(stub, { network: "testnet" });

    fireEvent.click(screen.getByText("connect"));

    await waitFor(() => expect(stub.factory).toHaveBeenCalledWith({ network: "testnet", cspNonce: "NONCE123==" }));
  });

  it("tries again after the library failed to load, instead of staying broken", async () => {
    const stub = stubWallet();
    const factory = vi
      .fn<ConnectorFactory>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(stub.factory);
    mount({ factory });

    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(text("status")).toBe("disconnected"));
    fireEvent.click(screen.getByText("connect"));

    await waitFor(() => expect(text("status")).toBe("connected"));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("signs a payload with the nonce decoded to bytes, as the settlement account, on the right network", async () => {
    const stub = stubWallet();
    let sign: ReturnType<typeof useWallet>["signMessage"] | undefined;
    mount(stub, {}, <Probe actions={(w) => (sign = w.signMessage)} />);
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(text("status")).toBe("connected"));

    const nonce = Buffer.alloc(32, 9).toString("base64");
    const result = await sign!({ message: "{}", recipient: "intents.near", nonce });

    expect(result).toEqual({
      accountId: "demo-shop.near",
      publicKey: "ed25519:WALLETKEY",
      signature: "WALLETSIGNATURE",
    });
    const params = stub.wallet.signMessage.mock.calls[0]![0];
    expect(params).toMatchObject({
      message: "{}",
      recipient: "intents.near",
      signerId: "demo-shop.near",
      network: "mainnet",
    });
    expect(Array.from(params.nonce)).toEqual(Array.from({ length: 32 }, () => 9));
  });

  it("registers a key on the verifier with a one yoctoNEAR function call from the settlement account", async () => {
    const stub = stubWallet();
    let register: ReturnType<typeof useWallet>["registerKey"] | undefined;
    mount(stub, {}, <Probe actions={(w) => (register = w.registerKey)} />);
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(text("status")).toBe("connected"));

    await register!("ed25519:ABC");

    expect(stub.wallet.signAndSendTransaction).toHaveBeenCalledWith({
      receiverId: "intents.near",
      signerId: "demo-shop.near",
      network: "mainnet",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "add_public_key",
            args: { public_key: "ed25519:ABC" },
            gas: "30000000000000",
            deposit: "1",
          },
        },
      ],
    });
  });

  it("refuses to do anything outside a provider", async () => {
    render(
      <Probe actions={(w) => void w.signMessage({ message: "", recipient: "", nonce: "" }).catch(() => undefined)} />,
    );
    expect(text("status")).toBe("disconnected");
  });
});

const button = (stub: ReturnType<typeof stubWallet>, props: Parameters<typeof mount>[1] = {}) =>
  mount(stub, props, <WalletButton />);

describe("the wallet button in the top bar", () => {
  it("says Connect wallet until there is one, then shows the account", async () => {
    const stub = stubWallet();
    button(stub);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: /Wallet demo-shop.near, connected/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("is already connected after a reload", async () => {
    localStorage.setItem("tilll-wallet", "1");
    button(stubWallet());
    expect(await screen.findByRole("button", { name: /Wallet demo-shop.near, connected/ })).toBeTruthy();
  });

  it("warns when the wallet is the wrong account, and says which account approves refunds", async () => {
    localStorage.setItem("tilll-wallet", "1");
    button(stubWallet({ account: "someone-else.near" }));
    const chip = await screen.findByRole("button", { name: /Wallet someone-else.near, wrong account/ });
    fireEvent.click(chip);
    expect(screen.getByText(/Refunds are approved by demo-shop.near/)).toBeTruthy();
  });

  it("offers to switch wallet or disconnect from the menu", async () => {
    localStorage.setItem("tilll-wallet", "1");
    const stub = stubWallet();
    button(stub);
    fireEvent.click(await screen.findByRole("button", { name: /Wallet demo-shop.near, connected/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect/ }));
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(stub.connector.disconnect).toHaveBeenCalled();
  });

  it("tells the merchant when the wallet could not connect, and stays on Connect wallet", async () => {
    const stub = stubWallet();
    stub.connector.connect.mockRejectedValueOnce(new Error("The popup was closed."));
    button(stub);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText("Wallet not connected")).toBeTruthy();
    expect(screen.getByText("The popup was closed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});
