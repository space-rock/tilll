import { useCallback, useEffect, useState } from "react";
import { ApiError, request } from "../api.js";

/** A list fetched in pages with a "next cursor", starting again whenever `basePath` changes. */
export function usePaged<T>(basePath: string, key: "invoices" | "refunds" | "deliveries", pageSize = 25) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [version, setVersion] = useState(0);

  const url = (after: string | null) => {
    const joiner = basePath.includes("?") ? "&" : "?";
    return `${basePath}${joiner}limit=${pageSize}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    request<Record<string, unknown>>("GET", url(null)).then(
      (body) => {
        if (cancelled) return;
        setItems(body[key] as T[]);
        setCursor((body.nextCursor as string | null) ?? null);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `url` only reads basePath and pageSize
  }, [basePath, pageSize, key, version]);

  const more = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const body = await request<Record<string, unknown>>("GET", url(cursor));
      setItems((current) => [...current, ...(body[key] as T[])]);
      setCursor((body.nextCursor as string | null) ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `url` only reads basePath and pageSize
  }, [cursor, basePath, pageSize, key]);

  return { items, hasMore: cursor !== null, loading, error, more, reload: () => setVersion((v) => v + 1) };
}
