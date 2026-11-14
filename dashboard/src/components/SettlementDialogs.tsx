import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, request } from "../api.js";
import { chainName } from "../format.js";
import { useApi } from "../hooks.js";
import type { Settings } from "../types.js";
import { useWallet } from "../wallet.js";
import { Mono } from "./Bits.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { TextField } from "./ui/field.js";
import { useToast } from "./ui/toast.js";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/** Shown when payments or refunds are open: moving the money now could strand them. */
function Locked({ reason }: { reason: string }) {
  return (
    <p role="note" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
      {reason}
    </p>
  );
}

/**
 * Change the settlement account. Money sent to an account nobody controls is lost, so the connected wallet has to be
 * signed in as the new account and sign a message for it. The server accepts it only from a full-access key.
 */
export function ChangeAccountDialog({
  open,
  settings,
  onClose,
  onChanged,
}: {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState<"connecting" | "saving" | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const next = account.trim();
  const same = next === settings.account;
  const signedInAsNext = wallet.status === "connected" && wallet.accountId === next;

  const connect = async () => {
    setError(undefined);
    setBusy("connecting");
    try {
      if (wallet.status === "connected") await wallet.disconnect();
      await wallet.connect();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    setError(undefined);
    setBusy("saving");
    try {
      const challenge = await request<{ message: string; recipient: string; nonce: string }>(
        "POST",
        "/v1/settings/account-challenge",
        { accountId: next },
      );
      const signed = await wallet.signMessage(
        { message: challenge.message, recipient: challenge.recipient, nonce: challenge.nonce },
        { signerId: next },
      );
      await request("PUT", "/v1/settings/account", {
        accountId: next,
        nonce: challenge.nonce,
        publicKey: signed.publicKey,
        signature: signed.signature,
      });
      toast({
        title: "Settlement account changed",
        description: `New payments go to ${next}.`,
        tone: "success",
      });
      setAccount("");
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Your wallet didn't sign: ${message(e)}`);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change settlement account"
      description="New payments go to this account. Invoices you already made are still paid to the old one."
    >
      <div className="flex flex-col gap-4">
        {settings.settlementLocked && <Locked reason={settings.settlementLocked} />}
        <TextField
          label="New account"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder="shop-pay.near"
          autoComplete="off"
          spellCheck={false}
          hint="Money sent to an account nobody controls is lost, so you confirm it with that account's wallet."
          disabled={settings.settlementLocked !== null}
        />
        {next !== "" && !same && (
          <p className="text-sm break-words text-muted-foreground">
            {signedInAsNext ? (
              <>
                Your wallet is signed in as <Mono text={next} copy={false} />. It will ask you to sign a message.
                Nothing is sent or spent.
              </>
            ) : wallet.status === "connected" ? (
              <>
                Your wallet is signed in as <Mono text={wallet.accountId ?? ""} copy={false} />. Connect a wallet signed
                in as <Mono text={next} copy={false} /> to continue.
              </>
            ) : (
              <>Connect a wallet signed in as {next} to continue.</>
            )}
          </p>
        )}
        {same && next !== "" && (
          <p className="text-sm text-muted-foreground">That is already the settlement account.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {next !== "" && !same && !signedInAsNext ? (
            <Button
              onClick={() => void connect()}
              loading={busy === "connecting"}
              disabled={settings.settlementLocked !== null}
            >
              {wallet.status === "connected" ? "Switch wallet" : "Connect wallet"}
            </Button>
          ) : (
            <Button
              onClick={() => void save()}
              loading={busy === "saving"}
              disabled={next === "" || same || settings.settlementLocked !== null}
            >
              Confirm in wallet
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

interface TokenRow {
  assetId: string;
  symbol: string;
  chain: string;
}

/**
 * Change the settlement asset. The refund limits are in the asset's units, so they are set in the same step, and the
 * dialog says what happens to invoices that already exist.
 */
export function ChangeAssetDialog({
  open,
  settings,
  onClose,
  onChanged,
}: {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const tokens = useApi<{ chains: Record<string, { assetId: string; symbol: string }[]> }>(open ? "/v1/tokens" : null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<TokenRow | undefined>(undefined);
  const [perTx, setPerTx] = useState(settings.limits.maxPerTx);
  const [perDay, setPerDay] = useState(settings.limits.maxPerDay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const rows = useMemo<TokenRow[]>(
    () =>
      Object.entries(tokens.data?.chains ?? {}).flatMap(([chain, list]) =>
        list.map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain })),
      ),
    [tokens.data],
  );
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return rows
      .filter(
        (r) =>
          r.assetId !== settings.asset.id &&
          (r.symbol.toLowerCase().includes(q) ||
            r.chain.toLowerCase().includes(q) ||
            r.assetId.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [rows, query, settings.asset.id]);

  const save = async () => {
    if (!chosen) return;
    setError(undefined);
    setSaving(true);
    try {
      await request("PATCH", "/v1/settings", {
        settlementAssetId: chosen.assetId,
        refundMaxPerTx: perTx.trim(),
        refundMaxPerDay: perDay.trim(),
      });
      toast({
        title: "Settlement asset changed",
        description: `New invoices are priced in ${chosen.symbol}.`,
        tone: "success",
      });
      setChosen(undefined);
      setQuery("");
      onChanged();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  const locked = settings.settlementLocked !== null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change settlement asset"
      description={`You are paid in ${settings.asset.symbol} now. Invoices, refunds and refund limits are all in the asset you choose.`}
    >
      <div className="flex flex-col gap-4">
        {settings.settlementLocked && <Locked reason={settings.settlementLocked} />}
        {!chosen ? (
          <div className="flex flex-col gap-3">
            <TextField
              label="Find an asset"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by symbol or network, like wNEAR"
              autoComplete="off"
              disabled={locked}
            />
            {tokens.error && (
              <p role="alert" className="text-sm text-danger">
                We couldn't load the list of assets: {tokens.error.message}
              </p>
            )}
            {query.trim() !== "" && matches.length === 0 && !tokens.loading && (
              <p className="text-sm text-muted-foreground">No asset matches that.</p>
            )}
            {matches.length > 0 && (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {matches.map((row) => (
                  <li key={row.assetId}>
                    <button
                      type="button"
                      onClick={() => setChosen(row)}
                      className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      <span className="flex items-center gap-2">
                        <Search aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{row.symbol}</span>
                        <span className="text-muted-foreground">on {chainName(row.chain)}</span>
                      </span>
                      <code
                        className="max-w-[40%] truncate font-mono text-xs text-muted-foreground"
                        title={row.assetId}
                      >
                        {row.assetId}
                      </code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              <span className="font-medium">
                {chosen.symbol} on {chainName(chosen.chain)}
              </span>{" "}
              <button
                type="button"
                className="cursor-pointer text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => setChosen(undefined)}
              >
                Choose another
              </button>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Limit per refund"
                inputMode="decimal"
                value={perTx}
                onChange={(event) => setPerTx(event.target.value)}
                suffix={chosen.symbol}
              />
              <TextField
                label="Limit per day"
                inputMode="decimal"
                value={perDay}
                onChange={(event) => setPerDay(event.target.value)}
                suffix={chosen.symbol}
              />
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>New invoices are priced in {chosen.symbol}.</li>
              <li>
                Invoices you already made stay in {settings.asset.symbol} and are still paid to the account they named.
              </li>
              <li>
                Tilll can&apos;t refund those older invoices after the change, because a refund is paid from the new
                balance. Send them from the old balance.
              </li>
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!chosen || locked}>
            Change asset
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
