"use client";

import { useEffect, useEffectEvent } from "react";

/** Follow server-sent change notices for `topics` (e.g. "order:ord_1", "shop:mer_1:stock") and call
 *  `onChange` (debounced) when one arrives. The stream only says *that* something changed; callers
 *  re-fetch through their normal endpoints. Polling elsewhere stays as the fallback. */
export function useLive(topics: (string | null | undefined)[], onChange: () => void, token?: string | null): void {
  const wanted = topics.filter(Boolean).join(",");
  const fire = useEffectEvent(onChange);
  useEffect(() => {
    if (!wanted || typeof EventSource === "undefined") return;
    const params = new URLSearchParams({ topics: wanted });
    if (token) params.set("t", token);
    const source = new EventSource(`/api/live?${params.toString()}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(() => fire(), 250);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [wanted, token]);
}
