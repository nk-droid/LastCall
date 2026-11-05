"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Announce = (message: string, politeness?: "polite" | "assertive") => void;

const AnnounceContext = createContext<Announce>(() => {});

/** One polite and one assertive live region for the whole app (status changes, saves, errors). */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announce = useCallback<Announce>((message, politeness = "polite") => {
    const set = politeness === "assertive" ? setAssertive : setPolite;
    set("");
    window.setTimeout(() => set(message), 60);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div aria-live="polite" role="status" className="sr-only">{polite}</div>
      <div aria-live="assertive" role="alert" className="sr-only">{assertive}</div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
