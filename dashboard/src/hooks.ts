import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api.js";

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True only until the first answer; a reload keeps showing the old data. */
  loading: boolean;
  reload: () => void;
}

/** GET `path` (null means "not yet"), again whenever `path` changes or `reload` is called. */
export function useApi<T>(path: string | null, options: { refreshMs?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [version, setVersion] = useState(0);
  const refreshMs = options.refreshMs;
  const loadedPath = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = () =>
      request<T>("GET", path).then(
        (value) => {
          if (cancelled) return;
          setData(value);
          setError(undefined);
          setLoading(false);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
          setLoading(false);
        },
      );
    // A new path starts from nothing; a reload of the same path keeps what is on screen (and anything open over it).
    if (loadedPath.current !== path) {
      loadedPath.current = path;
      setData(undefined);
      setLoading(true);
    }
    void load();
    const timer = refreshMs ? setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, version, refreshMs]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}

/** Is a CSS media query true right now? */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
