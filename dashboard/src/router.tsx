import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const BASE = "/dashboard";
const EVENT = "tilll:navigate";

const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(EVENT, callback);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

/** Where the dashboard is: the path below /dashboard (always starting with "/") and the query string. */
export function useLocation(): { path: string; query: URLSearchParams } {
  const full = useSyncExternalStore(subscribe, snapshot);
  const [pathname = "/", search = ""] = full.split("?");
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : "/";
  return { path: path.length > 1 ? path.replace(/\/+$/, "") : path, query: new URLSearchParams(search) };
}

/** Go to a dashboard path such as "/invoices?q=coffee" without reloading. */
export function navigate(to: string) {
  window.history.pushState({}, "", `${BASE}${to === "/" ? "" : to}`);
  window.dispatchEvent(new Event(EVENT));
}

export function Link({ to, onClick, children, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={`${BASE}${to === "/" ? "" : to}`} onClick={click} {...rest}>
      {children}
    </a>
  );
}
