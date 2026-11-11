import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, navigate, useLocation } from "../router.js";
import { cn } from "../cn.js";
import type { Settings } from "../types.js";
import { shorten } from "../format.js";
import { Button } from "./ui/button.js";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/invoices", label: "Invoices" },
  { to: "/refunds", label: "Refunds" },
  { to: "/webhooks", label: "Webhooks" },
  { to: "/settings", label: "Settings" },
];

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("tilll-theme", dark ? "dark" : "light");
    } catch {
      // the choice just is not remembered
    }
  }, [dark]);
  return [dark, () => setDark((d) => !d)] as const;
}

/** Sidebar (a top bar on phones), the search/export/create bar, and the settlement account card. */
export function Layout({
  settings,
  onCreate,
  onExport,
  onLogout,
  children,
}: {
  settings: Settings | undefined;
  onCreate: () => void;
  onExport: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { path, query } = useLocation();
  const [dark, toggleDark] = useDarkMode();
  const searched = query.get("q") ?? "";
  const [search, setSearch] = useState(searched);

  // Follow the address (back button, a link), but never overwrite what is being typed on an ordinary re-render.
  useEffect(() => setSearch(searched), [searched]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigate(search.trim() ? `/invoices?q=${encodeURIComponent(search.trim())}` : "/invoices");
  };

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-card p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
        <Link to="/" className="flex items-center gap-2" aria-label="Tilll overview">
          <img src="/dashboard/tilll-mark.svg" alt="" className="h-7 w-7 dark:hidden" />
          <img src="/dashboard/tilll-mark-white.svg" alt="" className="hidden h-7 w-7 dark:block" />
          <span className="font-display text-xl font-extrabold tracking-tight">tilll</span>
        </Link>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map((item) => {
            const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden flex-col gap-1 rounded-md border border-border p-3 text-xs md:flex">
          <p className="font-medium">Settlement account</p>
          {settings ? (
            <>
              <code className="font-mono break-all" title={settings.account}>
                {shorten(settings.account, 12, 8)}
              </code>
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-block h-2 w-2 rounded-full",
                    settings.oneclick.reachable ? "bg-brand" : "bg-danger",
                  )}
                />
                1Click {settings.oneclick.reachable ? "connected" : "unreachable"}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">Loading…</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-3">
          <form onSubmit={submit} role="search" className="min-w-40 flex-1 md:max-w-sm">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search invoices by id, description or metadata"
              aria-label="Search invoices"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
          </form>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onExport}>
              Export CSV
            </Button>
            <Button size="sm" onClick={onCreate}>
              Create invoice
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleDark} aria-pressed={dark} aria-label="Dark mode">
              {dark ? "Light" : "Dark"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onLogout}>
              Log out
            </Button>
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4">{children}</main>
      </div>
    </div>
  );
}
