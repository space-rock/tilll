import { AlertTriangle, LogOut, Repeat, Wallet } from "lucide-react";
import { shorten } from "../format.js";
import { useWallet } from "../wallet.js";
import { CopyButton } from "./Bits.js";
import { Button } from "./ui/button.js";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/menu.js";
import { useToast } from "./ui/toast.js";
import { ApiError } from "../api.js";

const problem = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.";

/**
 * The wallet, always in the top bar: Connect wallet when there is none, and the connected account when there is. Once
 * connected it stays connected across pages and reloads. If the wallet is signed in as some other account it says so,
 * because only the settlement account can approve a refund.
 */
export function WalletButton() {
  const wallet = useWallet();
  const toast = useToast();

  const connect = async () => {
    try {
      await wallet.connect();
    } catch (e) {
      toast({ title: "Wallet not connected", description: problem(e), tone: "danger" });
    }
  };

  if (wallet.status === "disconnected" || wallet.status === "connecting" || !wallet.accountId) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void connect()}
        loading={wallet.status === "connecting"}
        disabled={wallet.status === "restoring"}
      >
        {wallet.status !== "connecting" && <Wallet aria-hidden="true" className="h-4 w-4" />}
        {wallet.status === "restoring" ? "Reconnecting…" : "Connect wallet"}
      </Button>
    );
  }

  const ok = wallet.matches;
  const account = wallet.accountId;
  return (
    <Menu
      label={`Wallet ${account}, ${ok ? "connected" : "wrong account"}`}
      className="border border-border bg-card shadow-card"
      trigger={
        <>
          {ok ? (
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-brand" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
          )}
          <span className="font-mono text-xs">{shorten(account, 10, 6)}</span>
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{ok ? "Wallet connected" : "Wrong account"}</MenuLabel>
          <div className="flex items-center gap-1 px-2.5 pb-2">
            <code className="font-mono text-xs break-all">{account}</code>
            <CopyButton text={account} label="Copy account" />
          </div>
          {!ok && (
            <p className="px-2.5 pb-2 text-xs text-warning">
              Refunds are approved by {wallet.expectedAccount}. Switch to that account in your wallet.
            </p>
          )}
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              close();
              void wallet
                .disconnect()
                .then(connect)
                .catch(() => undefined);
            }}
          >
            <Repeat aria-hidden="true" /> Switch wallet
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              void wallet.disconnect().catch(() => undefined);
            }}
          >
            <LogOut aria-hidden="true" /> Disconnect wallet
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
