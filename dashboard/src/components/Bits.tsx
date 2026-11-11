import { useState } from "react";
import { Badge } from "./ui/badge.js";
import type { Tone } from "../format.js";
import { shorten } from "../format.js";
import type { TxLink } from "../types.js";

export const StatusBadge = ({ badge }: { badge: { label: string; tone: Tone } }) => (
  <Badge tone={badge.tone}>{badge.label}</Badge>
);

/** An address or id in a monospace font, shortened, with the whole text on hover and a copy button. */
export function Mono({ text, short = true, copy = true }: { text: string; short?: boolean; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <code title={text} className="font-mono text-xs break-all">
        {short ? shorten(text) : text}
      </code>
      {copy && (
        <button
          type="button"
          onClick={doCopy}
          aria-label={`Copy ${text}`}
          className="cursor-pointer rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
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
              className="font-mono text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
            >
              {shorten(link.hash)}
            </a>
          ) : (
            <code className="font-mono text-xs">{shorten(link.hash)}</code>
          )}
        </li>
      ))}
    </ul>
  );
}

export const ErrorNote = ({ message }: { message: string }) => (
  <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
    {message}
  </p>
);

export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
    <p className="text-sm font-medium">{title}</p>
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);
