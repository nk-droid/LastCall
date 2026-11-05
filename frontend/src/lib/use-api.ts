"use client";

import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { ApiError } from "./api";

export type Resource<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** True once a request has been pending for a while; drives "slow connection" messaging. */
  slow: boolean;
  reload: () => void;
  setData: (value: T | null) => void;
};

/** Fetch on mount and whenever `deps` change, optionally polling. Keeps showing the last good
 *  data while revalidating and never spins indefinitely: slow requests surface a message.
 *  `pollMs` may depend on the latest data (e.g. poll faster while a payment is pending). */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number | ((data: T | null) => number | undefined); enabled?: boolean } = {},
): Resource<T> {
  const enabled = opts.enabled !== false;
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [slowKey, setSlowKey] = useState<string | null>(null);
  const key = `${JSON.stringify(deps)}#${tick}`;
  const run = useEffectEvent((signal: AbortSignal) => fetcher(signal));

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlowKey(key), 4000);
    run(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        clearTimeout(slowTimer);
        if (!controller.signal.aborted) setDoneKey(key);
      });
    return () => {
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [key, enabled]);

  const pollMs = typeof opts.pollMs === "function" ? opts.pollMs(data) : opts.pollMs;
  useEffect(() => {
    if (!enabled || !pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, pollMs);
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const loading = enabled && doneKey !== key;
  return { data, error, loading, slow: loading && slowKey === key, reload, setData };
}

/** Seconds remaining until an ISO timestamp, ticking once per second. */
export function useSecondsUntil(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  if (!iso) return null;
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

const noopSubscribe = () => () => {};

/** False during server render and hydration, true afterwards (safe gate for browser-only reads). */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
