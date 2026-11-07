"use client";

// One Ask LastCall conversation (all shops, or one shop's), kept for the tab so the home page, the floating
// sheet and a shop page all continue the same chat. While the agent works, its progress is polled.

import { useEffect, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { api, errorMessage } from "@/lib/api";
import type { ConciergeMessage, Conversation } from "@/lib/types";

export type Scope = { slug: string; name: string } | undefined;

export function useConversation(shop: Scope) {
  const storageKey = `lastcall.concierge.${shop?.slug ?? "all"}`;
  const announce = useAnnounce();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const working = sending || conv?.status === "working";
  const messages = conv?.messages ?? [];

  // Pick up this tab's conversation after a reload or on another page.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(storageKey);
    } catch {
      return;
    }
    if (!saved) return;
    api<Conversation>(`/api/concierge/${saved}`).then(setConv).catch(() => forget(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!conv || conv.status !== "working") return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<Conversation>(`/api/concierge/${conv.id}`);
        setConv(next);
        if (next.status === "idle") {
          const last = next.messages[next.messages.length - 1];
          announce(last?.cards?.length ? `${last.cards.length} options found. ${last.text}` : last?.text || "Reply ready");
        }
      } catch (err) {
        setError(errorMessage(err));
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [conv, announce]);

  async function send(message: string): Promise<boolean> {
    const body = message.trim();
    if (!body || working) return false;
    setSending(true);
    setError(null);
    try {
      const next = await api<Conversation>("/api/concierge/messages", { body: { text: body, conversation_id: conv?.id, shop: conv ? undefined : shop?.slug } });
      setConv(next);
      try {
        window.sessionStorage.setItem(storageKey, next.id);
      } catch {
        // Storage blocked: the chat still works, it just won't survive a reload.
      }
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setConv(null);
    setError(null);
    forget(storageKey);
  }

  const latest: ConciergeMessage | undefined = [...messages].reverse().find((m) => m.role === "assistant");
  const latestWithDetails = [...messages].reverse().find((m) => m.role === "assistant" && m.details);
  return { conv, messages, working, error, send, reset, latest, latestWithDetails };
}

function forget(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // nothing to forget
  }
}
