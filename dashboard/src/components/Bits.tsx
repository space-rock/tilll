import { AlertCircle, Check, Copy, ExternalLink, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../cn.js";
import type { Tone } from "../format.js";
import { shorten } from "../format.js";
import type { TxLink } from "../types.js";
import { Badge } from "./ui/badge.js";

export const StatusBadge = ({ badge }: { badge: { label: string; tone: Tone } }) => (
  <Badge tone={badge.tone}>{badge.label}</Badge>
);

/** An icon button that copies `text`, and says so ("Copied") for a moment, to the eye and to a screen reader. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={doCopy}
      aria-label={copied ? "Copied" : `${label} ${text}`}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", copied && "text-success")} />
    </button>
  );
}

/** An address or id in a monospace font, shortened, with the whole text on hover and a copy button. */
export function Mono({ text, short = true, copy = true }: { text: string; short?: boolean; copy?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code title={text} className="font-mono text-xs break-all">
        {short ? shorten(text) : text}
      </code>
      {copy && <CopyButton text={text} />}
    </span>
  );
}

/** Links to the transactions on the chain's explorer. Only http(s) links are ever rendered as links. */
export function TxLinks({ links }: { links: TxLink[] }) {
  if (links.length === 0) return <span className="text-muted-foreground">None yet</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {links.map((link) => (
        <li key={link.hash}>
          {/^https?:\/\//.test(link.explorerUrl) ? (
            <a
              href={link.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
            >
              {shorten(link.hash)}
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          ) : (
            <code className="font-mono text-xs">{shorten(link.hash)}</code>
          )}
        </li>
      ))}
    </ul>
  );
}

export const ErrorNote = ({ message, action }: { message: string; action?: ReactNode }) => (
  <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-bg px-3.5 py-3 text-sm text-danger">
    <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p>{message}</p>
      {action}
    </div>
  </div>
);

/** What a list or panel shows when there is nothing in it yet: an icon, what it is, what to do, and optionally a button. */
export const EmptyState = ({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
    {Icon && (
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
    )}
    <p className="text-sm font-medium">{title}</p>
    {hint && <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
