"use client";

// Ask LastCall: the shopping concierge. The agent compares bundles (all shops, or one shop's page) and
// answers with cards; holding stock and paying stay the shopper's click (Hold & pay → review → PayPal).

import {
  AccountBalanceWalletRounded,
  ArrowUpwardRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  CheckRounded,
  GroupsRounded,
  RestartAltRounded,
  ScheduleRounded,
  StorefrontRounded,
  VerifiedUserRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Chip, CircularProgress, IconButton, InputAdornment, Link, Stack, TextField, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { PriceTag } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { brand, surface, tones, type Icon } from "@/components/ui";
import { WatchThis } from "@/components/watches";
import { api, errorMessage } from "@/lib/api";
import type { ConciergeCard, ConciergeMessage, Conversation } from "@/lib/types";

const EXAMPLES = ["Treats for 6 under $25, nut allergy, after 5 PM", "Breakfast for 4 people tomorrow", "Something savory for 2, under $12"];
const FIT_ICON: Record<string, Icon> = { party: GroupsRounded, budget: AccountBalanceWalletRounded, exclusions: VerifiedUserRounded, pickup: ScheduleRounded };

export function ConciergePanel({ shop, autoFocus }: { shop?: { slug: string; name: string }; autoFocus?: boolean }) {
  const storageKey = `lastcall.concierge.${shop?.slug ?? "all"}`;
  const announce = useAnnounce();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const working = sending || conv?.status === "working";
  const messages = conv?.messages ?? [];

  // Pick up this tab's conversation after a reload.
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

  // While the agent works, poll for its progress and reply.
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

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conv?.progress.length]);

  async function send(message: string) {
    const body = message.trim();
    if (!body || working) return;
    setSending(true);
    setError(null);
    try {
      const next = await api<Conversation>("/api/concierge/messages", { body: { text: body, conversation_id: conv?.id, shop: conv ? undefined : shop?.slug } });
      setConv(next);
      setText("");
      try {
        window.sessionStorage.setItem(storageKey, next.id);
      } catch {
        // Storage blocked: the chat still works, it just won't survive a reload.
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setConv(null);
    setError(null);
    forget(storageKey);
  }

  return (
    <Box>
      {messages.length ? (
        <Box ref={listRef} role="log" aria-live="polite" aria-label="Conversation" sx={{ maxHeight: { xs: 520, md: 620 }, overflowY: "auto", pr: 0.5, mb: 2 }}>
          <Stack spacing={2}>
            {messages.map((m, i) => (m.role === "user" ? <UserBubble key={i} text={m.text} /> : (
              <AssistantMessage key={i} message={m} wide={!shop} footer={
                // Offer a watch under the latest answer (bundles found, or nothing fits), not under a question.
                conv && !working && i === messages.length - 1 && m.source !== "system" && (m.cards?.length || !m.questions?.length)
                  ? <WatchThis conversationId={conv.id} hasCards={!!m.cards?.length} /> : null
              } />
            )))}
            {working ? <Progress steps={conv?.progress ?? []} /> : null}
          </Stack>
        </Box>
      ) : (
        <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Example requests" sx={{ flexWrap: "wrap", mb: 2 }}>
          {EXAMPLES.map((example) => (
            <Chip key={example} component="button" type="button" clickable label={example} onClick={() => send(example)} disabled={working}
              sx={{ ...surface.raisedSm, color: brand.forest, fontWeight: 550, height: 32 }} />
          ))}
        </Stack>
      )}
      {error ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      <Stack component="form" direction="row" spacing={1} sx={{ alignItems: "center" }} onSubmit={(e: React.FormEvent) => { e.preventDefault(); send(text); }}>
        <TextField
          fullWidth
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus={autoFocus}
          placeholder={messages.length ? "Reply, or change anything (budget, pickup time, allergies)…" : shop ? `What would you like from ${shop.name}?` : "Who's it for, your budget, allergies, pickup time…"}
          slotProps={{
            htmlInput: { maxLength: 600, "aria-label": "Message the shopping assistant" },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton type="submit" aria-label="Send" disabled={!text.trim() || working} edge="end"
                    sx={{ bgcolor: brand.leaf, color: "#fff", "&:hover": { bgcolor: brand.leafDark }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}>
                    {working ? <CircularProgress size={18} sx={{ color: "inherit" }} /> : <ArrowUpwardRounded fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
        {messages.length ? (
          <IconButton aria-label="Start a new chat" onClick={reset} disabled={working}>
            <RestartAltRounded />
          </IconButton>
        ) : null}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        It checks live surplus with the same stock, allergen and pickup checks as building a bundle yourself. You choose, hold and pay.
      </Typography>
    </Box>
  );
}

function forget(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // nothing to forget
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <Box sx={{ alignSelf: "flex-end", maxWidth: "80%", bgcolor: brand.mint, color: brand.forest, px: 1.75, py: 1.1, borderRadius: "16px 16px 4px 16px" }}>
      <Typography variant="body2" sx={{ fontWeight: 550 }}>{text}</Typography>
    </Box>
  );
}

function AssistantMessage({ message, wide, footer }: { message: ConciergeMessage; wide: boolean; footer?: ReactNode }) {
  const cards = message.cards ?? [];
  return (
    <Stack spacing={1.25} sx={{ alignSelf: "stretch" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Box aria-hidden sx={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: "50%", bgcolor: brand.mint, color: brand.leafDark, flexShrink: 0, mt: 0.25 }}>
          <AutoAwesomeRounded sx={{ fontSize: 16 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {message.text ? <Typography variant="body2" sx={{ color: brand.forest, lineHeight: 1.55 }}>{message.text}</Typography> : null}
          {message.questions?.map((q) => (
            <Typography key={q} variant="body2" sx={{ fontWeight: 650, color: brand.forest, mt: message.text ? 0.5 : 0 }}>{q}</Typography>
          ))}
        </Box>
      </Stack>
      {cards.length ? (
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: wide ? `repeat(${Math.min(cards.length, 3)}, minmax(0, 1fr))` : "1fr" } }}>
          {cards.map((card) => <BundleCard key={card.option_id} card={card} />)}
        </Box>
      ) : null}
      {footer}
    </Stack>
  );
}

function Progress({ steps }: { steps: string[] }) {
  const shown = steps.length ? steps : ["Reading your request"];
  return (
    <Stack component="ul" spacing={0.75} aria-label="What the assistant is doing" sx={{ listStyle: "none", m: 0, pl: 4.5 }}>
      {shown.map((step, i) => {
        const current = i === shown.length - 1;
        return (
          <Stack component="li" key={step} direction="row" spacing={1} sx={{ alignItems: "center", color: current ? brand.forest : "text.secondary" }}>
            {current ? <CircularProgress size={14} thickness={5} /> : <CheckRounded aria-hidden sx={{ fontSize: 16, color: brand.leaf }} />}
            <Typography variant="body2" sx={{ fontWeight: current ? 600 : 500 }}>{step}{current ? "…" : ""}</Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}

function BundleCard({ card }: { card: ConciergeCard }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fits = card.fits.filter((f) => f.key !== "savings");
  async function hold() {
    setBusy(true);
    setError(null);
    try {
      const quote = await api<{ id: string }>("/api/quotes", { body: { proposal_id: card.proposal_id, option_id: card.option_key, pickup_slot_id: card.default_slot_id } });
      router.push(`/review/${quote.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Box component="article" aria-label={`${card.shop.name}: ${card.label}`}
      sx={{ ...surface.raisedSm, borderRadius: "16px", p: 2, display: "flex", flexDirection: "column", gap: 1.25, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Link href={`/shops/${card.shop.slug}`} underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 700, color: brand.forest, minWidth: 0 }}>
          <StorefrontRounded aria-hidden sx={{ fontSize: 16, color: brand.leaf }} />
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.shop.name}</Box>
        </Link>
        <Chip size="small" label={card.label} sx={{ bgcolor: tones.success.bg, color: tones.success.fg, fontWeight: 650, flexShrink: 0 }} />
      </Stack>
      <Stack direction="row" spacing={0.75} aria-hidden>
        {card.lines.slice(0, 4).map((line) => <ProductImage key={line.name} image={line.image ?? { url: null, alt: line.name }} size="sm" sx={{ width: 44, height: 44 }} />)}
      </Stack>
      <Typography variant="body2" sx={{ color: brand.forest }}>
        {card.lines.map((line) => `${line.qty} × ${line.name}`).join(" · ")}
      </Typography>
      <Stack component="ul" spacing={0.5} aria-label="Why it fits" sx={{ listStyle: "none", m: 0, p: 0 }}>
        {fits.map((fit) => {
          const FitIcon = FIT_ICON[fit.key] ?? CheckCircleRounded;
          return (
            <Stack component="li" key={fit.key} direction="row" spacing={0.75} sx={{ alignItems: "flex-start" }}>
              <FitIcon aria-hidden sx={{ fontSize: 16, color: brand.leaf, mt: "2px" }} />
              <Typography variant="caption" sx={{ color: brand.forest, lineHeight: 1.45 }}>{fit.label}</Typography>
            </Stack>
          );
        })}
      </Stack>
      <Box sx={{ mt: "auto", pt: 0.5 }}>
        <PriceTag price={card.total_minor} reference={card.reference_minor} currency={card.currency} size="sm" />
        {error ? <Typography variant="caption" color="error" role="alert" component="p" sx={{ mt: 0.5 }}>{error}</Typography> : null}
        <Button fullWidth variant="contained" sx={{ mt: 1 }} loading={busy} disabled={!card.default_slot_id} onClick={hold}>
          Hold &amp; pay
        </Button>
      </Box>
    </Box>
  );
}
