"use client";

// Ask LastCall: the shopping concierge as a chat (the sheet that opens from any page, and a shop's own page).
// The agent compares bundles and answers with cards; each answer can show how it was picked. Holding stock and
// paying stay the shopper's click (Hold & pay → review → PayPal).

import { ArrowUpwardRounded, AutoAwesomeRounded, CheckRounded, RestartAltRounded } from "@mui/icons-material";
import { Alert, Box, Chip, CircularProgress, IconButton, InputAdornment, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { brand, surface } from "@/components/ui";
import { WatchThis } from "@/components/watches";
import type { ConciergeMessage } from "@/lib/types";

import { BundleCard } from "./bundle-card";
import { HowWePicked } from "./reasoning";
import { useConversation, type Scope } from "./use-conversation";

export const EXAMPLES = ["Treats for 6 under $25, nut allergy, after 5 PM", "Breakfast for 4 people tomorrow", "Something savory for 2, under $12"];
export const QUICK_REPLIES = ["Make it cheaper", "More savory", "Later pickup"];

export function ConciergePanel({ shop, autoFocus }: { shop?: Scope; autoFocus?: boolean }) {
  const chat = useConversation(shop);
  const { conv, messages, working } = chat;
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conv?.progress.length]);

  async function send(message: string) {
    if (await chat.send(message)) setText("");
  }

  return (
    <Box>
      {messages.length ? (
        <Box ref={listRef} role="log" aria-live="polite" aria-label="Conversation" sx={{ maxHeight: { xs: 520, md: 620 }, overflowY: "auto", pr: 0.5, mb: 2 }}>
          <Stack spacing={2}>
            {messages.map((m, i) => {
              if (m.role === "user") return <UserBubble key={i} text={m.text} />;
              const last = i === messages.length - 1;
              // Offer a watch under the latest answer (bundles found, or nothing fits), not under a question.
              const answer = conv && !working && last && m.source !== "system" && (m.cards?.length || !m.questions?.length);
              return (
                <AssistantMessage key={i} message={m} footer={answer ? (
                  <Stack spacing={1.25}>
                    <QuickReplies onSend={send} />
                    <WatchThis conversationId={conv.id} hasCards={!!m.cards?.length} />
                  </Stack>
                ) : null} />
              );
            })}
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
      {chat.error ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{chat.error}</Alert> : null}
      <Composer value={text} onChange={setText} onSubmit={() => send(text)} working={working} autoFocus={autoFocus}
        placeholder={messages.length ? "Reply, or change anything (budget, pickup time, allergies)…" : shop ? `What would you like from ${shop.name}?` : "Who's it for, your budget, allergies, pickup time…"}
        onReset={messages.length ? chat.reset : undefined} />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        It checks live surplus with the same stock, allergen and pickup checks as building a bundle yourself. You choose, hold and pay.
      </Typography>
    </Box>
  );
}

export function Composer({ value, onChange, onSubmit, working, placeholder, autoFocus, onReset, size = "medium" }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; working: boolean; placeholder: string; autoFocus?: boolean;
  onReset?: () => void; size?: "medium" | "large";
}) {
  return (
    <Stack component="form" direction="row" spacing={1} sx={{ alignItems: "center" }} onSubmit={(e: React.FormEvent) => { e.preventDefault(); onSubmit(); }}>
      <TextField
        fullWidth
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        placeholder={placeholder}
        sx={size === "large" ? { "& .MuiInputBase-root": { minHeight: 60, fontSize: 17, borderRadius: "16px", bgcolor: "#fff" } } : undefined}
        slotProps={{
          htmlInput: { maxLength: 600, "aria-label": "Message the shopping assistant" },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton type="submit" aria-label="Send" disabled={!value.trim() || working} edge="end"
                  sx={{ bgcolor: brand.leaf, color: "#fff", "&:hover": { bgcolor: brand.leafDark }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}>
                  {working ? <CircularProgress size={18} sx={{ color: "inherit" }} /> : <ArrowUpwardRounded fontSize="small" />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      {onReset ? (
        <IconButton aria-label="Start a new chat" onClick={onReset} disabled={working}>
          <RestartAltRounded />
        </IconButton>
      ) : null}
    </Stack>
  );
}

export function QuickReplies({ onSend }: { onSend: (text: string) => void }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Quick replies" sx={{ flexWrap: "wrap", pl: 4.5 }}>
      {QUICK_REPLIES.map((q) => (
        <Chip key={q} component="button" type="button" clickable label={q} onClick={() => onSend(q)}
          sx={{ ...surface.raisedSm, color: brand.forest, fontWeight: 550, height: 30 }} />
      ))}
    </Stack>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <Box sx={{ alignSelf: "flex-end", maxWidth: "80%", bgcolor: brand.mint, color: brand.forest, px: 1.75, py: 1.1, borderRadius: "16px 16px 4px 16px" }}>
      <Typography variant="body2" sx={{ fontWeight: 550 }}>{text}</Typography>
    </Box>
  );
}

export function AssistantText({ message }: { message: ConciergeMessage }) {
  return (
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
  );
}

function AssistantMessage({ message, footer }: { message: ConciergeMessage; footer?: ReactNode }) {
  const cards = message.cards ?? [];
  return (
    <Stack spacing={1.25} sx={{ alignSelf: "stretch" }}>
      <AssistantText message={message} />
      {cards.length ? (
        <Stack spacing={1.5}>
          {cards.map((card) => <BundleCard key={card.option_id} card={card} />)}
        </Stack>
      ) : null}
      {message.details ? <HowWePicked details={message.details} /> : null}
      {footer}
    </Stack>
  );
}

export function Progress({ steps }: { steps: string[] }) {
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
