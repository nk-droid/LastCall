"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import type { ConfigResponse } from "@/lib/types";

const ConfigContext = createContext<ConfigResponse | null>(null);

/** Loads public runtime config once (PayPal mode/client id, AI provider). Also creates the guest session cookie. */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (attempt: number) =>
      api<ConfigResponse>("/api/config")
        .then((value) => !cancelled && setConfig(value))
        .catch(() => {
          if (!cancelled && attempt < 5) window.setTimeout(() => load(attempt + 1), 1500 * (attempt + 1));
        });
    load(0);
    return () => {
      cancelled = true;
    };
  }, []);
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigResponse | null {
  return useContext(ConfigContext);
}
