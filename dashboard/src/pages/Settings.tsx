import { Pencil, RotateCcw, Send, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError, request } from "../api.js";
import { CopyButton, ErrorNote } from "../components/Bits.js";
import { ChangeAccountDialog, ChangeAssetDialog } from "../components/SettlementDialogs.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { TextField } from "../components/ui/field.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useToast } from "../components/ui/toast.js";
import { formatDateTime, formatRelative } from "../format.js";
import type { SettingKey, Settings, WebhookTest } from "../types.js";
import { useWallet } from "../wallet.js";

const LABELS: Record<SettingKey, string> = {
  settlementAccount: "Settlement account",
  settlementAsset: "Settlement asset",
  slippageBps: "Slippage",
  attemptDeadlineMinutes: "Payment window",
  webhookUrl: "Webhook URL",
  publicBaseUrl: "Public URL",
  refundMaxPerTx: "Limit per refund",
  refundMaxPerDay: "Limit per day",
};

/** A value from the history as the merchant reads it: slippage in percent, the payment window in minutes. */
export function showChange(setting: SettingKey, value: string | null): string {
  if (value === null) return "—";
  if (setting === "slippageBps" && Number.isFinite(Number(value))) return `${Number(value) / 100}%`;
  if (setting === "attemptDeadlineMinutes") return `${value} min`;
  return value;
}

const errorText = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.";

/** Where a value comes from, and a way back to the `.env` value when it was changed here. */
function Source({ setting, settings, onChanged }: { setting: SettingKey; settings: Settings; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const source = settings.sources[setting];
  if (source.source === "env") return <span className="text-xs text-muted-foreground">From .env</span>;

  const reset = async () => {
    setBusy(true);
    try {
      await request("DELETE", `/v1/settings/${setting}`);
      toast({
        title: `${LABELS[setting]} reset`,
        description: "It now uses the value from your .env file.",
        tone: "success",
      });
      onChanged();
    } catch (e) {
      toast({ title: "We couldn't reset it", description: errorText(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span title={source.updatedAt ? formatDateTime(source.updatedAt) : undefined}>
        Changed in dashboard{source.updatedAt ? ` · ${formatRelative(source.updatedAt)}` : ""}
      </span>
      <button
        type="button"
        onClick={() => void reset()}
        disabled={busy}
        aria-label={`Reset ${LABELS[setting]} to its .env value`}
        className="inline-flex cursor-pointer items-center gap-1 underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RotateCcw aria-hidden="true" className="h-3 w-3" />
        Reset to .env value
      </button>
    </span>
  );
}

const Row = ({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
    <dt className="flex flex-col gap-0.5 text-sm text-muted-foreground">
      {label}
      {note}
    </dt>
    <dd className="flex flex-wrap items-center gap-1 text-sm break-all sm:justify-end sm:text-right">{children}</dd>
  </div>
);

const Code = ({ children, copy }: { children: string; copy?: boolean }) => (
  <>
    <code className="font-mono text-xs">{children}</code>
    {copy && <CopyButton text={children} />}
  </>
);

/** A card whose rows can be edited: Edit swaps them for inputs, Save sends only what changed. */
interface EditField {
  key: SettingKey;
  label: string;
  /** What the input starts with. */
  initial: string;
  suffix?: string;
  hint?: string;
  inputMode?: "decimal" | "numeric" | "url" | "text";
}

type Parsed = { patch: Record<string, unknown> } | { error: string };

function EditableCard({
  title,
  description,
  fields,
  toPatch,
  onSaved,
  actions,
  children,
}: {
  title: string;
  description?: string;
  fields: EditField[];
  /** Turn the typed texts (only the changed ones) into the request body, or say what is wrong. */
  toPatch: (changed: Partial<Record<SettingKey, string>>) => Parsed;
  onSaved: () => void;
  /** Extra buttons next to Edit. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const start = () => {
    setDrafts(Object.fromEntries(fields.map((f) => [f.key, f.initial])));
    setError(undefined);
    setEditing(true);
  };

  const save = async () => {
    const changed: Partial<Record<SettingKey, string>> = {};
    for (const f of fields) {
      const text = (drafts[f.key] ?? "").trim();
      if (text !== f.initial) changed[f.key] = text;
    }
    if (Object.keys(changed).length === 0) {
      setEditing(false);
      return;
    }
    const parsed = toPatch(changed);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await request("PATCH", "/v1/settings", parsed.patch);
      toast({ title: `${title} saved`, description: "The change applies now.", tone: "success" });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-2">
            {actions}
            <Button variant="outline" size="sm" onClick={start} aria-label={`Edit ${title.toLowerCase()}`}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => (
                <TextField
                  key={f.key}
                  label={f.label}
                  value={drafts[f.key] ?? ""}
                  onChange={(event) => setDrafts((d) => ({ ...d, [f.key]: event.target.value }))}
                  inputMode={f.inputMode ?? "text"}
                  autoComplete="off"
                  spellCheck={false}
                  {...(f.suffix ? { suffix: f.suffix } : {})}
                  {...(f.hint ? { hint: f.hint } : {})}
                  className={f.inputMode === "url" ? "sm:col-span-2" : undefined}
                />
              ))}
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={saving}>
                Save
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <dl>{children}</dl>
        )}
      </CardContent>
    </Card>
  );
}

function SettlementCard({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [dialog, setDialog] = useState<"account" | "asset" | undefined>(undefined);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Settlement</CardTitle>
          <CardDescription>Where you are paid, and in what. Changing either affects new invoices only.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <Row
              label="Settlement account"
              note={<Source setting="settlementAccount" settings={settings} onChanged={onChanged} />}
            >
              <Code copy>{settings.account}</Code>
              <Button variant="outline" size="sm" className="ml-2" onClick={() => setDialog("account")}>
                Change account
              </Button>
            </Row>
            <Row
              label="Settlement asset"
              note={<Source setting="settlementAsset" settings={settings} onChanged={onChanged} />}
            >
              {settings.asset.symbol} <Code copy>{settings.asset.id}</Code>
              <Button variant="outline" size="sm" className="ml-2" onClick={() => setDialog("asset")}>
                Change asset
              </Button>
            </Row>
            <Row label="Verifier contract">
              <Code copy>{settings.intentsContract}</Code>
            </Row>
            <Row label="Network">{settings.network === "mainnet" ? "Mainnet" : "Test network"}</Row>
          </dl>
        </CardContent>
      </Card>
      <ChangeAccountDialog
        open={dialog === "account"}
        settings={settings}
        onClose={() => setDialog(undefined)}
        onChanged={onChanged}
      />
      <ChangeAssetDialog
        open={dialog === "asset"}
        settings={settings}
        onClose={() => setDialog(undefined)}
        onChanged={onChanged}
      />
    </>
  );
}

function WalletCard({ settings }: { settings: Settings }) {
  const wallet = useWallet();
  const toast = useToast();
  const connect = () =>
    void wallet.connect().catch((e: unknown) => {
      toast({ title: "Wallet not connected", description: errorText(e), tone: "danger" });
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Wallet</CardTitle>
        <CardDescription>
          Tilll holds no key that can spend your money. A refund is prepared here and approved by your wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl>
          <Row label="Connected wallet">
            {wallet.status === "connected" && wallet.accountId ? (
              <>
                <Code>{wallet.accountId}</Code>
                <span className={wallet.matches ? "text-success" : "text-warning"}>
                  {wallet.matches ? "· can approve refunds" : "· wrong account"}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {wallet.status === "restoring" ? "Reconnecting…" : "Not connected"}
              </span>
            )}
          </Row>
        </dl>
        <p className="text-sm break-words text-muted-foreground">
          The wallet has to be signed in as the settlement account ({settings.account}). A named account registers its
          key with NEAR Intents once, the first time it approves a refund.
        </p>
        <div className="flex flex-wrap gap-2">
          {wallet.status === "connected" ? (
            <Button variant="outline" size="sm" onClick={() => void wallet.disconnect().catch(() => undefined)}>
              Disconnect wallet
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={connect}
              loading={wallet.status === "connecting" || wallet.status === "restoring"}
            >
              <Wallet aria-hidden="true" className="h-4 w-4" />
              Connect wallet
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Slippage is typed as a percent and sent as basis points. */
const percentToBps = (text: string): number | undefined => {
  const value = Number(text);
  return text !== "" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
};

function WebhookTestResult({ result }: { result: WebhookTest | { failure: string } }) {
  if ("failure" in result) return <p className="text-sm text-danger">Test failed: {result.failure}</p>;
  if (result.delivered)
    return (
      <p className="text-sm text-success">
        Delivered · HTTP {result.status} in {result.durationMs} ms
      </p>
    );
  return (
    <p className="text-sm text-danger">
      Not delivered · {result.status ? `HTTP ${result.status}` : (result.error ?? "no answer")}
      {result.status && result.error && result.error !== `HTTP ${result.status}` ? ` · ${result.error}` : ""} after{" "}
      {result.durationMs} ms
    </p>
  );
}

/** How this installation is set up. Most of it comes from .env; the rest can be changed here. Secrets are never shown. */
export function SettingsPage({
  settings,
  error,
  reload,
}: {
  settings: Settings | undefined;
  error: string | undefined;
  /** Load the settings again after a change, so the whole dashboard sees them. */
  reload: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<WebhookTest | { failure: string } | undefined>(undefined);

  if (error) return <ErrorNote message={error} />;
  if (!settings)
    return (
      <>
        <PageHeader title="Settings" />
        <Skeleton className="h-64" />
      </>
    );
  const symbol = settings.asset.symbol;

  const sendTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      setTest(await request<WebhookTest>("POST", "/v1/webhooks/test"));
    } catch (e) {
      setTest({ failure: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Changes apply right away. Anything you haven't changed comes from your .env file. Secrets are never shown here."
      />
      <SettlementCard settings={settings} onChanged={reload} />
      <WalletCard settings={settings} />
      <EditableCard
        title="Payments"
        description="How long a customer has to pay, and how much the price may move."
        fields={[
          {
            key: "attemptDeadlineMinutes",
            label: "Payment window",
            initial: String(settings.attemptDeadlineMinutes),
            suffix: "minutes",
            inputMode: "numeric",
            hint: "Bitcoin and similar networks always use at least 120 minutes.",
          },
          {
            key: "slippageBps",
            label: "Slippage",
            initial: String(settings.slippageBps / 100),
            suffix: "%",
            inputMode: "decimal",
          },
        ]}
        toPatch={(changed) => {
          const patch: Record<string, unknown> = {};
          if (changed.attemptDeadlineMinutes !== undefined) {
            const minutes = Number(changed.attemptDeadlineMinutes);
            if (!Number.isInteger(minutes)) return { error: "Payment window: enter a whole number of minutes." };
            patch.attemptDeadlineMinutes = minutes;
          }
          if (changed.slippageBps !== undefined) {
            const bps = percentToBps(changed.slippageBps);
            if (bps === undefined) return { error: "Slippage: enter a number, like 1 or 0.5." };
            patch.slippageBps = bps;
          }
          return { patch };
        }}
        onSaved={reload}
      >
        <Row
          label="Payment window"
          note={<Source setting="attemptDeadlineMinutes" settings={settings} onChanged={reload} />}
        >
          {settings.attemptDeadlineMinutes} minutes
        </Row>
        <Row label="Slippage" note={<Source setting="slippageBps" settings={settings} onChanged={reload} />}>
          {(settings.slippageBps / 100).toFixed(2)}%
        </Row>
      </EditableCard>
      <EditableCard
        title="Refund limits"
        description="Limits on what the dashboard and API can refund."
        fields={[
          {
            key: "refundMaxPerTx",
            label: "Limit per refund",
            initial: settings.limits.maxPerTx,
            suffix: symbol,
            inputMode: "decimal",
          },
          {
            key: "refundMaxPerDay",
            label: "Limit per day",
            initial: settings.limits.maxPerDay,
            suffix: symbol,
            inputMode: "decimal",
            hint: "Counted per UTC day.",
          },
        ]}
        toPatch={(changed) => ({ patch: { ...changed } })}
        onSaved={reload}
      >
        <Row label="Limit per refund" note={<Source setting="refundMaxPerTx" settings={settings} onChanged={reload} />}>
          {settings.limits.maxPerTx} {symbol}
        </Row>
        <Row label="Limit per day" note={<Source setting="refundMaxPerDay" settings={settings} onChanged={reload} />}>
          {settings.limits.maxPerDay} {symbol}
        </Row>
      </EditableCard>
      <EditableCard
        title="Webhooks"
        description="Where Tilll sends events such as invoice.paid."
        fields={[
          {
            key: "webhookUrl",
            label: "Webhook URL",
            initial: settings.webhookUrl,
            inputMode: "url",
            hint: "Must be an http or https address. The secret that signs events stays in .env.",
          },
        ]}
        toPatch={(changed) => ({ patch: { ...changed } })}
        onSaved={reload}
        actions={
          <Button variant="outline" size="sm" onClick={() => void sendTest()} loading={testing}>
            <Send aria-hidden="true" className="h-3.5 w-3.5" />
            Send test event
          </Button>
        }
      >
        <Row label="Webhook URL" note={<Source setting="webhookUrl" settings={settings} onChanged={reload} />}>
          <Code copy>{settings.webhookUrl}</Code>
        </Row>
        {test && (
          <div className="pt-3" role="status">
            <WebhookTestResult result={test} />
          </div>
        )}
      </EditableCard>
      <EditableCard
        title="Public URL"
        description="Where customers reach Tilll. Payment links are made from it."
        fields={[
          {
            key: "publicBaseUrl",
            label: "Public URL",
            initial: settings.publicBaseUrl,
            inputMode: "url",
            hint: "An http or https address with no path. Use https in production so sign-in stays secure.",
          },
        ]}
        toPatch={(changed) => ({ patch: { ...changed } })}
        onSaved={reload}
      >
        <Row label="Public URL" note={<Source setting="publicBaseUrl" settings={settings} onChanged={reload} />}>
          <Code copy>{settings.publicBaseUrl}</Code>
        </Row>
      </EditableCard>
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>Set in .env. Change them there and restart Tilll.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <Row label="NEAR Intents">
              <Code>{settings.oneclick.baseUrl}</Code>
              <span className={settings.oneclick.reachable ? "text-success" : "text-danger"}>
                · {settings.oneclick.reachable ? "reachable" : "unreachable"}
              </span>
              <span className="text-muted-foreground">· API key {settings.oneclick.apiKeySet ? "set" : "not set"}</span>
            </Row>
          </dl>
        </CardContent>
      </Card>
      {settings.history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent changes</CardTitle>
            <CardDescription>Changes made here. Passwords in URLs are never shown.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-border">
              {settings.history.map((change, index) => (
                <li
                  key={`${change.changedAt}-${change.setting}-${index}`}
                  className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0"
                >
                  <span>
                    <span className="font-medium">{LABELS[change.setting]}</span>{" "}
                    <span className="text-muted-foreground">
                      <code className="font-mono text-xs break-all">{showChange(change.setting, change.from)}</code> →{" "}
                      <code className="font-mono text-xs break-all">{showChange(change.setting, change.to)}</code>
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground" title={formatDateTime(change.changedAt)}>
                    {formatRelative(change.changedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
