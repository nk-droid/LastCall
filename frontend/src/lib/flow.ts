// Small client-side memory for the shopping flow. Every read and write is guarded: storage can
// be unavailable (private mode, blocked site data), and the app must still work without it.

import { useMemo, useSyncExternalStore } from "react";

import type { Controls } from "./types";

export type FlowState = {
  /** Shop slug the saved request belongs to; a request is never reused at another shop. */
  merchant?: string;
  text?: string;
  controls?: Controls;
  useAi?: boolean;
  intentId?: string;
};

const FLOW_KEY = "lastcall.flow";
const ORDERS_KEY = "lastcall.orders";
const listeners = new Set<() => void>();

function rawRead(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function read<T>(storage: () => Storage, key: string, fallback: T): T {
  const raw = rawRead(storage, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the flow still works, it just isn't remembered */
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
}

export const flow = {
  get: (): FlowState => read(() => sessionStorage, FLOW_KEY, {}),
  set: (patch: Partial<FlowState>) => write(() => sessionStorage, FLOW_KEY, { ...flow.get(), ...patch }),
  clear: () => write(() => sessionStorage, FLOW_KEY, {}),
};

export type RememberedOrder = { id: string; number: string; token?: string | null; at: string };

export const orderMemory = {
  list: (): RememberedOrder[] => read(() => localStorage, ORDERS_KEY, []),
  remember: (order: RememberedOrder) => {
    const all = orderMemory.list();
    const prior = all.find((o) => o.id === order.id);
    const next = { ...order, token: order.token ?? prior?.token ?? null };
    if (prior && prior.number === next.number && prior.token === next.token) return;
    write(() => localStorage, ORDERS_KEY, [next, ...all.filter((o) => o.id !== order.id)].slice(0, 5));
  },
  token: (id: string): string | null => orderMemory.list().find((o) => o.id === id)?.token ?? null,
  /** Forget this device's order links (switching to another shopper). */
  clear: () => write(() => localStorage, ORDERS_KEY, []),
};

/** The saved flow, or null during server render / hydration. */
export function useFlowSnapshot(): FlowState | null {
  const raw = useSyncExternalStore(subscribe, () => rawRead(() => sessionStorage, FLOW_KEY) ?? "{}", () => null);
  return useMemo(() => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as FlowState;
    } catch {
      return {};
    }
  }, [raw]);
}

/** Orders remembered on this device, or null during server render / hydration. */
export function useRememberedOrders(): RememberedOrder[] | null {
  const raw = useSyncExternalStore(subscribe, () => rawRead(() => localStorage, ORDERS_KEY) ?? "[]", () => null);
  return useMemo(() => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as RememberedOrder[];
    } catch {
      return [];
    }
  }, [raw]);
}
