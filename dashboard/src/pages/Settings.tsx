import { ErrorNote } from "../components/Bits.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import type { Settings } from "../types.js";

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 border-b border-border py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="text-sm break-all sm:text-right">{children}</dd>
  </div>
);

const Code = ({ children }: { children: React.ReactNode }) => <code className="font-mono text-xs">{children}</code>;

/** How this installation is set up. Read-only: it is changed in .env, and secrets are never shown. */
export function SettingsPage({ settings, error }: { settings: Settings | undefined; error: string | undefined }) {
  if (error) return <ErrorNote message={error} />;
  if (!settings) return <Skeleton className="h-64" />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          Read-only. Change these in your .env file and restart Tilll. Secrets are never shown here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl>
          <Row label="Settlement account">
            <Code>{settings.account}</Code>
          </Row>
          <Row label="Settlement asset">
            {settings.asset.symbol} <Code>{settings.asset.id}</Code>
          </Row>
          <Row label="Intents contract">
            <Code>{settings.intentsContract}</Code>
          </Row>
          <Row label="Public URL">
            <Code>{settings.publicBaseUrl}</Code>
          </Row>
          <Row label="Webhook URL">
            <Code>{settings.webhookUrl}</Code>
          </Row>
          <Row label="1Click">
            <Code>{settings.oneclick.baseUrl}</Code> · {settings.oneclick.reachable ? "connected" : "unreachable"} · API
            key {settings.oneclick.apiKeySet ? "set" : "not set"}
          </Row>
          <Row label="Refund limits">
            {settings.limits.maxPerTx} {settings.asset.symbol} each, {settings.limits.maxPerDay} {settings.asset.symbol}{" "}
            per day
          </Row>
          <Row label="Payment window">{settings.attemptDeadlineMinutes} minutes</Row>
          <Row label="Slippage">{(settings.slippageBps / 100).toFixed(2)}%</Row>
        </dl>
      </CardContent>
    </Card>
  );
}
