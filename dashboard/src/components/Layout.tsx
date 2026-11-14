import {
  CircleUserRound,
  Download,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Undo2,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { cn } from "../cn.js";
import { useApi } from "../hooks.js";
import { Link, navigate, useLocation } from "../router.js";
import type { RefundCounts, Settings } from "../types.js";
import { WalletButton } from "./WalletButton.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/menu.js";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: { group?: string; items: NavItem[] }[] = [
  { items: [{ to: "/", label: "Overview", icon: LayoutDashboard }] },
  {
    group: "Payments",
    items: [
      { to: "/invoices", label: "Invoices", icon: FileText },
      { to: "/refunds", label: "Refunds", icon: Undo2 },
    ],
  },
  { group: "Developers", items: [{ to: "/webhooks", label: "Webhooks", icon: Webhook }] },
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

/** Which network the dashboard is looking at, so a test account is never mistaken for the real one. */
function NetworkPill({ settings }: { settings: Settings | undefined }) {
  if (!settings) return null;
  const live = settings.network === "mainnet";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        live ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {live ? "Mainnet" : "Test network"}
    </span>
  );
}

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="Tilll overview">
      <img src="/dashboard/tilll-mark.svg" alt="" className="h-7 w-7 dark:hidden" />
      <img src="/dashboard/tilll-mark-white.svg" alt="" className="hidden h-7 w-7 dark:block" />
      <span className="font-display text-xl font-extrabold tracking-tight">tilll</span>
    </Link>
  );
}

function SideNav({
  path,
  settings,
  waiting,
  onNavigate,
}: {
  path: string;
  settings: Settings | undefined;
  waiting: number;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6">
      <nav aria-label="Main" className="flex flex-col gap-5">
        {NAV.map((section) => (
          <div key={section.group ?? "top"} className="flex flex-col gap-1">
            {section.group && (
              <p className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground">{section.group}</p>
            )}
            {section.items.map((item) => {
              const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {item.label}
                  {item.to === "/refunds" && waiting > 0 && (
                    <span
                      aria-label={`${waiting} waiting for approval`}
                      className="num ml-auto rounded-full bg-warning-bg px-1.5 text-xs text-warning"
                    >
                      {waiting}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1">
        <Link
          to="/settings"
          onClick={onNavigate}
          aria-current={path.startsWith("/settings") ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            path.startsWith("/settings")
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <SettingsIcon aria-hidden="true" className="h-4 w-4" />
          Settings
        </Link>
        <div className="px-3 pt-2">
          <NetworkPill settings={settings} />
        </div>
      </div>
    </div>
  );
}

/** The sidebar (a drawer on phones), the top bar with search, the wallet and the main actions, and the page itself. */
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
  const [drawer, setDrawer] = useState(false);
  const searched = query.get("q") ?? "";
  const [search, setSearch] = useState(searched);
  const counts = useApi<{ counts: RefundCounts }>("/v1/refunds?limit=1", { refreshMs: 15_000 });
  const waiting = counts.data?.counts.awaiting_approval ?? 0;

  // Follow the address (back button, a link), but never overwrite what is being typed on an ordinary re-render.
  useEffect(() => setSearch(searched), [searched]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigate(search.trim() ? `/invoices?q=${encodeURIComponent(search.trim())}` : "/invoices");
  };

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r border-border bg-card px-3 py-4 md:flex">
        <div className="px-3">
          <Wordmark />
        </div>
        <SideNav path={path} settings={settings} waiting={waiting} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card/95 px-4 py-2.5 backdrop-blur md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
          >
            <MenuIcon aria-hidden="true" className="h-5 w-5" />
          </Button>
          <div className="md:hidden">
            <Wordmark />
          </div>
          <form
            onSubmit={submit}
            role="search"
            className="order-last w-full min-w-40 md:order-none md:max-w-md md:flex-1"
          >
            <label className="relative block">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search invoices"
                aria-label="Search invoices"
                title="Search by ID, description or metadata"
                className="h-9 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm placeholder:text-muted-foreground"
              />
            </label>
          </form>
          <div className="ml-auto flex items-center gap-2">
            <WalletButton />
            <Button size="sm" onClick={onCreate}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Create invoice
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleDark}
              aria-pressed={dark}
              aria-label="Dark mode"
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
            >
              {dark ? <Sun aria-hidden="true" className="h-4 w-4" /> : <Moon aria-hidden="true" className="h-4 w-4" />}
            </Button>
            <Menu label="Account" trigger={<CircleUserRound aria-hidden="true" className="h-5 w-5" />}>
              {(close) => (
                <>
                  <MenuLabel>Merchant</MenuLabel>
                  <MenuItem
                    onSelect={() => {
                      close();
                      onExport();
                    }}
                  >
                    <Download aria-hidden="true" /> Export invoices (CSV)
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    onSelect={() => {
                      close();
                      onLogout();
                    }}
                  >
                    <LogOut aria-hidden="true" /> Log out
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>

      <Dialog open={drawer} onClose={() => setDrawer(false)} title="Menu" side="left" hideTitle>
        <SideNav path={path} settings={settings} waiting={waiting} onNavigate={() => setDrawer(false)} />
      </Dialog>
    </div>
  );
}
