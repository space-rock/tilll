import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * The merchant's wallet. This is the only file that knows about near-connect, and it loads that library only when it is
 * needed: when the merchant presses Connect wallet, or when a wallet was connected before and this page is being opened
 * again. A dashboard that has never been connected never downloads it.
 *
 * Tilll holds no key. A refund is prepared by the server, signed here by the wallet, and sent back.
 */

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

export interface SignedMessage {
  accountId?: string;
  publicKey: string;
  signature: string;
}

/** The part of a near-connect wallet the dashboard uses. */
export interface WalletHandle {
  getAccounts(): Promise<WalletAccount[]>;
  signMessage(params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
    signerId?: string;
    network?: string;
  }): Promise<SignedMessage>;
  signAndSendTransaction(params: {
    receiverId: string;
    signerId?: string;
    network?: string;
    actions: {
      type: "FunctionCall";
      params: { methodName: string; args: object; gas: string; deposit: string };
    }[];
  }): Promise<unknown>;
}

/** The part of the near-connect connector the dashboard uses. */
export interface ConnectorHandle {
  connect(): Promise<WalletHandle>;
  getConnectedWallet(): Promise<{ wallet: WalletHandle; accounts: WalletAccount[] }>;
  disconnect(): Promise<void>;
  on?(event: "wallet:signOut", callback: () => void): void;
}

export type ConnectorFactory = (options: {
  network: "mainnet" | "testnet";
  cspNonce?: string;
}) => Promise<ConnectorHandle>;

/** The real thing: near-connect, loaded now. */
export const nearConnectFactory: ConnectorFactory = async ({ network, cspNonce }) => {
  const { NearConnector } = await import("@hot-labs/near-connect");
  return new NearConnector({
    network,
    // Only wallets that can sign a message are offered: that is how a refund is approved.
    features: { signMessage: true },
    ...(cspNonce ? { cspNonce } : {}),
  }) as unknown as ConnectorHandle;
};

/** Where the server put this response's script nonce. The wallet code runs as inline script under it. */
const pageNonce = (): string | undefined =>
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;

const HINT = "tilll-wallet";
const remember = (connected: boolean) => {
  try {
    if (connected) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    // It just is not restored the next time.
  }
};
const remembered = (): boolean => {
  try {
    return localStorage.getItem(HINT) === "1";
  } catch {
    return false;
  }
};

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** NEAR's gas for a plain function call, and the 1 yoctoNEAR the verifier asks for when a key is added. */
const ADD_KEY_GAS = "30000000000000";
const ONE_YOCTO = "1";

export type WalletStatus = "disconnected" | "restoring" | "connecting" | "connected";

export interface WalletApi {
  status: WalletStatus;
  /** The connected account, once there is one. */
  accountId: string | undefined;
  /** The account that has to sign refunds: the settlement account. Undefined until the settings are loaded. */
  expectedAccount: string | undefined;
  /** Connected, and to the settlement account (the only one whose signature can approve a refund). */
  matches: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Sign a payload. `nonce` is the payload's base64. The account that signs is the settlement account, unless
   * `signerId` names another (the account being proved when the settlement account is changed).
   */
  signMessage(
    payload: { message: string; recipient: string; nonce: string },
    options?: { signerId?: string },
  ): Promise<SignedMessage>;
  /** Register a key on the NEAR Intents verifier for the connected account (a named account does this once). */
  registerKey(publicKey: string): Promise<void>;
}

const none = async (): Promise<never> => {
  throw new Error("Wallet connections aren't available here.");
};

const WalletContext = createContext<WalletApi>({
  status: "disconnected",
  accountId: undefined,
  expectedAccount: undefined,
  matches: false,
  connect: none,
  disconnect: none,
  signMessage: none,
  registerKey: none,
});

export const useWallet = () => useContext(WalletContext);

export function WalletProvider({
  network,
  expectedAccount,
  intentsContract,
  factory = nearConnectFactory,
  children,
}: {
  /** From the server's settings. Until they arrive the wallet is not restored. */
  network: "mainnet" | "testnet" | undefined;
  expectedAccount: string | undefined;
  intentsContract: string | undefined;
  /** Replaced in tests. */
  factory?: ConnectorFactory;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const connector = useRef<Promise<ConnectorHandle> | undefined>(undefined);

  const getConnector = useCallback((): Promise<ConnectorHandle> => {
    if (!network) return Promise.reject(new Error("Settings haven't loaded yet. Try again in a moment."));
    connector.current ??= factory({ network, ...(pageNonce() ? { cspNonce: pageNonce()! } : {}) }).then((c) => {
      c.on?.("wallet:signOut", () => {
        setAccountId(undefined);
        setStatus("disconnected");
        remember(false);
      });
      return c;
    });
    // A connector that failed to load is tried again next time.
    connector.current.catch(() => (connector.current = undefined));
    return connector.current;
  }, [factory, network]);

  // A wallet that was connected before is restored when the page opens, without asking again.
  useEffect(() => {
    if (!network || !remembered()) return;
    let cancelled = false;
    setStatus("restoring");
    getConnector()
      .then((c) => c.getConnectedWallet())
      .then(
        ({ accounts }) => {
          if (cancelled) return;
          const account = accounts[0]?.accountId;
          setAccountId(account);
          setStatus(account ? "connected" : "disconnected");
          if (!account) remember(false);
        },
        () => {
          if (cancelled) return;
          setStatus("disconnected");
          remember(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [network, getConnector]);

  const connect = useCallback(async () => {
    setStatus("connecting");
    try {
      const wallet = await (await getConnector()).connect();
      const account = (await wallet.getAccounts())[0]?.accountId;
      if (!account) throw new Error("Your wallet didn't share an account. Try connecting again.");
      setAccountId(account);
      setStatus("connected");
      remember(true);
    } catch (e) {
      setStatus(accountId ? "connected" : "disconnected");
      throw e;
    }
  }, [getConnector, accountId]);

  const disconnect = useCallback(async () => {
    try {
      await (await getConnector()).disconnect();
    } finally {
      setAccountId(undefined);
      setStatus("disconnected");
      remember(false);
    }
  }, [getConnector]);

  const walletForSigning = useCallback(async () => {
    const { wallet } = await (await getConnector()).getConnectedWallet();
    return wallet;
  }, [getConnector]);

  const signMessage = useCallback<WalletApi["signMessage"]>(
    async (payload, options) => {
      const wallet = await walletForSigning();
      const signerId = options?.signerId ?? expectedAccount;
      return wallet.signMessage({
        message: payload.message,
        recipient: payload.recipient,
        nonce: decodeBase64(payload.nonce),
        ...(signerId ? { signerId } : {}),
        ...(network ? { network } : {}),
      });
    },
    [walletForSigning, expectedAccount, network],
  );

  const registerKey = useCallback<WalletApi["registerKey"]>(
    async (publicKey) => {
      if (!intentsContract) throw new Error("Settings haven't loaded yet. Try again in a moment.");
      const wallet = await walletForSigning();
      await wallet.signAndSendTransaction({
        receiverId: intentsContract,
        ...(expectedAccount ? { signerId: expectedAccount } : {}),
        ...(network ? { network } : {}),
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "add_public_key",
              args: { public_key: publicKey },
              gas: ADD_KEY_GAS,
              deposit: ONE_YOCTO,
            },
          },
        ],
      });
    },
    [walletForSigning, intentsContract, expectedAccount, network],
  );

  const value = useMemo<WalletApi>(
    () => ({
      status,
      accountId,
      expectedAccount,
      matches: status === "connected" && accountId !== undefined && accountId === expectedAccount,
      connect,
      disconnect,
      signMessage,
      registerKey,
    }),
    [status, accountId, expectedAccount, connect, disconnect, signMessage, registerKey],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
