"use client";

// The home page leads with Ask LastCall. Before the first message it's one question and a big input; after it,
// the chat sits on the left and a live board on the right: what was understood (tap to change), every shop
// checked with its bundle or why nothing fit, how the pick was made, and an offer to watch for more.

import { AutoAwesomeRounded, LockRounded, RestartAltRounded, StorefrontRounded, VerifiedUserRounded } from "@mui/icons-material";
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

import { brand, surface } from "@/components/ui";
import { WatchThis } from "@/components/watches";
import { plural } from "@/lib/format";

import { AssistantText, Composer, EXAMPLES, Progress, QuickReplies, UserBubble } from "./concierge";
import { HowWePicked, ShopBoard, Understood } from "./reasoning";
import { useConversation } from "./use-conversation";

export function ConciergeHome({ shopsOpen }: { shopsOpen?: number }) {
  const chat = useConversation(undefined);
  const { conv, messages, working, latest, latestWithDetails } = chat;
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conv?.progress.length]);

  async function send(message: string) {
    if (await chat.send(message)) setText("");
  }

  if (!messages.length) {
    return (
      <Box component="section" aria-labelledby="ask-heading" sx={{
        mb: { xs: 5, sm: 6 }, borderRadius: "24px", px: { xs: 2.5, sm: 5 }, py: { xs: 4, sm: 6 },
        background: `linear-gradient(160deg, ${brand.mint} 0%, ${brand.cream} 70%)`, border: 1, borderColor: brand.line,
      }}>
        <Box sx={{ maxWidth: 760 }}>
          <Typography variant="overline" sx={{ color: brand.leafDark, display: "flex", alignItems: "center", gap: 0.75 }}>
            <AutoAwesomeRounded aria-hidden sx={{ fontSize: 16 }} /> Ask LastCall
          </Typography>
          <Typography id="ask-heading" variant="h1" sx={{ mt: 0.5 }}>Who are you feeding, and when?</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1.25, mb: 3, maxWidth: 620 }}>
            Say who it&apos;s for, your budget, allergies and pickup time. It checks {shopsOpen ? `${plural(shopsOpen, "shop")} open now` : "every shop's surplus"} and brings back bundles that fit.
          </Typography>
          {chat.error ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{chat.error}</Alert> : null}
          <Composer size="large" value={text} onChange={setText} onSubmit={() => send(text)} working={working}
            placeholder="e.g. treats for 6 under $25, my son has a nut allergy, after 5 PM" />
          <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Example requests" sx={{ flexWrap: "wrap", mt: 1.75 }}>
            {EXAMPLES.map((example) => (
              <Chip key={example} component="button" type="button" clickable label={example} onClick={() => send(example)} disabled={working}
                sx={{ ...surface.raisedSm, color: brand.forest, fontWeight: 550, height: 32 }} />
            ))}
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.75, sm: 2.5 }} sx={{ mt: 3, color: brand.muted }}>
            <Trust icon={<StorefrontRounded />} text="Live stock from every shop" />
            <Trust icon={<VerifiedUserRounded />} text="Allergens verified by each shop" />
            <Trust icon={<LockRounded />} text="You choose, hold and pay" />
          </Stack>
        </Box>
      </Box>
    );
  }

  const details = latestWithDetails?.details;
  const cards = latestWithDetails?.cards ?? [];
  const answered = conv && !working && latest && latest.source !== "system" && (latest.cards?.length || !latest.questions?.length);

  return (
    <Box component="section" aria-labelledby="ask-heading" sx={{ mb: { xs: 5, sm: 6 } }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Typography id="ask-heading" variant="h1" sx={{ fontSize: { xs: "1.6rem", sm: "2rem" }, display: "flex", alignItems: "center", gap: 1 }}>
          <AutoAwesomeRounded aria-hidden sx={{ color: brand.leaf }} /> Ask LastCall
        </Typography>
        <Button color="inherit" startIcon={<RestartAltRounded />} onClick={chat.reset} disabled={working}>New chat</Button>
      </Stack>
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(300px, 400px) minmax(0, 1fr)" }, alignItems: "start" }}>
        <Card component="section" aria-label="Conversation" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 2, position: { md: "sticky" }, top: { md: 88 } }}>
          <Box ref={listRef} role="log" aria-live="polite" aria-label="Messages" sx={{ maxHeight: { xs: 360, md: 520 }, overflowY: "auto", pr: 0.5 }}>
            <Stack spacing={2}>
              {messages.map((m, i) => m.role === "user" ? <UserBubble key={i} text={m.text} /> : (
                <Stack key={i} spacing={0.75}>
                  <AssistantText message={m} />
                  {m.cards?.length ? (
                    <Typography variant="caption" color="text.secondary" sx={{ pl: 4.5 }}>
                      {m === latestWithDetails ? `${plural(m.cards.length, "bundle")} on the board` : `${plural(m.cards.length, "bundle")} shown earlier`}
                    </Typography>
                  ) : null}
                </Stack>
              ))}
              {working ? <Progress steps={conv?.progress ?? []} /> : null}
              {answered ? <QuickReplies onSend={send} /> : null}
              {answered && conv && !details ? <WatchThis conversationId={conv.id} hasCards={!!latest?.cards?.length} /> : null}
            </Stack>
          </Box>
          {chat.error ? <Alert severity="error" role="alert">{chat.error}</Alert> : null}
          <Composer value={text} onChange={setText} onSubmit={() => send(text)} working={working} placeholder="Reply or change anything…" />
        </Card>

        <Box component="section" aria-label="Shop board" aria-busy={working} sx={{ minWidth: 0, opacity: working && details ? 0.6 : 1, transition: "opacity 160ms" }}>
          {details ? (
            <Stack spacing={2.5}>
              <Understood details={details} onSend={send} disabled={working} />
              <ShopBoard details={details} cards={cards} onSend={send} disabled={working} />
              <HowWePicked details={details} />
              {answered && conv ? (
                <Box sx={{ border: 1, borderColor: brand.line, borderRadius: "14px", bgcolor: "#fff", px: 2, py: 1.5 }}>
                  <WatchThis conversationId={conv.id} hasCards={!!latest?.cards?.length} variant="bar" />
                </Box>
              ) : null}
            </Stack>
          ) : (
            <Box sx={{ border: 1, borderStyle: "dashed", borderColor: brand.lineStrong, borderRadius: "16px", p: 4, textAlign: "center", color: brand.muted }}>
              {working ? (
                <Stack spacing={1.25} sx={{ alignItems: "center" }} role="status">
                  <CircularProgress size={22} />
                  <Typography variant="body2">Checking today&apos;s shops…</Typography>
                </Stack>
              ) : <Typography variant="body2">Answer on the left and every shop it checks shows up here.</Typography>}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function Trust({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", "& svg": { fontSize: 18, color: brand.leaf } }}>
      {icon}
      <Typography variant="body2">{text}</Typography>
    </Stack>
  );
}
