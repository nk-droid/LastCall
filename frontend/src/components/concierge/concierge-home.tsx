"use client";

// The home page leads with Ask LastCall. Before the first message it's one question and a big input. After it, the
// answer reads top to bottom: the request as a sentence (tap a part to change it), the bundle beside "How it fits",
// any other bundles, why the other shops had nothing, and an offer to watch for more. The chat itself folds away
// behind "Conversation" once there's an answer; until then (a question back, say) it stays open.

import {
  AddRounded, AutoAwesomeRounded, ChatBubbleOutlineRounded, ExpandLessRounded, ExpandMoreRounded, LockRounded, StorefrontRounded, VerifiedUserRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Card, Chip, Collapse, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

import { ProductImage } from "@/components/product-image";
import { brand, surface } from "@/components/ui";
import { WatchThis } from "@/components/watches";
import { money, plural } from "@/lib/format";
import type { ConciergeCard, ConciergeDetails } from "@/lib/types";

import { AskSentence } from "./ask-sentence";
import { AssistantText, Composer, EXAMPLES, Progress, UserBubble } from "./concierge";
import { FitCard, bundleSummary, bundleTitle } from "./fit-card";
import { useConversation } from "./use-conversation";

export function ConciergeHome({ shopsOpen }: { shopsOpen?: number }) {
  const chat = useConversation(undefined);
  const { conv, messages, working, latest, latestWithDetails } = chat;
  const [text, setText] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [picked, setPicked] = useState<{ at?: string; index: number }>({ index: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conv?.progress.length, showLog]);

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
  // The bundle in the big card: the top pick, or another one the shopper chose to view (until the next answer).
  const index = picked.at === latestWithDetails?.at && picked.index < cards.length ? picked.index : 0;
  const card = cards[index];
  const shopFacts = card && details?.shops.find((s) => s.slug === card.shop.slug);
  const strict = !!details?.understood.some((u) => u.strict);
  const logOpen = showLog || !details;

  return (
    <Box component="section" aria-labelledby="ask-heading" sx={{ mb: { xs: 5, sm: 6 }, maxWidth: 1000, mx: "auto" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", mb: 2.5 }}>
        <Typography id="ask-heading" variant="h1" sx={{ fontSize: { xs: "1.5rem", sm: "1.75rem" }, display: "flex", alignItems: "center", gap: 1 }}>
          <AutoAwesomeRounded aria-hidden sx={{ color: brand.leaf }} /> Ask LastCall
        </Typography>
        <Stack direction="row" spacing={0.5}>
          {details ? (
            <Button color="inherit" startIcon={<ChatBubbleOutlineRounded />} onClick={() => setShowLog((v) => !v)} aria-expanded={showLog} aria-controls="ask-conversation">
              {showLog ? "Hide conversation" : `Conversation (${messages.length})`}
            </Button>
          ) : null}
          <Button variant="outlined" color="inherit" startIcon={<AddRounded />} onClick={chat.reset} disabled={working} sx={{ bgcolor: "#fff", borderColor: brand.lineStrong }}>
            New chat
          </Button>
        </Stack>
      </Stack>

      <Collapse in={logOpen} id="ask-conversation" unmountOnExit>
        <Card component="section" aria-label="Conversation" sx={{ p: 2.5, mb: 3 }}>
          <Box ref={listRef} role="log" aria-live="polite" aria-label="Messages" sx={{ maxHeight: 420, overflowY: "auto", pr: 0.5 }}>
            <Stack spacing={2}>
              {messages.map((m, i) => (m.role === "user" ? <UserBubble key={i} text={m.text} /> : <AssistantText key={i} message={m} />))}
              {working && !details ? <Progress steps={conv?.progress ?? []} /> : null}
              {answered && conv && !details ? <WatchThis conversationId={conv.id} hasCards={!!latest?.cards?.length} /> : null}
            </Stack>
          </Box>
        </Card>
      </Collapse>

      {details ? (
        <Stack spacing={3}>
          <AskSentence details={details} onSend={send} disabled={working} />
          <Box aria-live="polite">
            {working ? <Progress steps={conv?.progress ?? []} /> : latest ? <AssistantText message={latest} /> : null}
          </Box>
          <Stack spacing={2.5} aria-busy={working} sx={{ opacity: working ? 0.55 : 1, transition: "opacity 160ms" }}>
            {card ? <FitCard card={card} leftOut={strict && shopFacts ? { names: shopFacts.left_out, count: shopFacts.left_out_count } : undefined} /> : null}
            {cards.length > 1 ? (
              <AlsoFits cards={cards} current={index} onView={(i) => setPicked({ at: latestWithDetails?.at, index: i })} />
            ) : null}
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <OtherShops key={latestWithDetails?.at} details={details} shown={new Set(cards.map((c) => c.shop.slug))} onSend={send} disabled={working} />
              {answered && conv ? (
                <Box sx={{ flex: { xs: "1 1 100%", sm: "0 0 auto" }, alignSelf: "center" }}>
                  <WatchThis conversationId={conv.id} hasCards={cards.length > 0} variant="button" />
                </Box>
              ) : null}
            </Stack>
          </Stack>
        </Stack>
      ) : null}

      <Box sx={{ mt: 3 }}>
        {chat.error ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{chat.error}</Alert> : null}
        <Composer size="large" value={text} onChange={setText} onSubmit={() => send(text)} working={working}
          placeholder={details ? "Or just say it: “for 8 instead”, “something sweet too”…" : "Reply or change anything…"} />
      </Box>
    </Box>
  );
}

/** The other bundles in the answer, one line each; View puts one in the big card. */
function AlsoFits({ cards, current, onView }: { cards: ConciergeCard[]; current: number; onView: (index: number) => void }) {
  return (
    <Box component="section" aria-labelledby="also-fits">
      <Typography id="also-fits" variant="subtitle1" component="h3" sx={{ fontWeight: 750, mb: 1 }}>Also fits</Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, border: 1, borderColor: brand.line, borderRadius: "16px", bgcolor: "#fff", overflow: "hidden" }}>
        {cards.map((c, i) => i === current ? null : (
          <Box component="li" key={c.option_id} sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.5, flexWrap: "wrap", "& + li": { borderTop: `1px solid ${brand.line}` } }}>
            <ProductImage image={c.lines[0]?.image ?? { url: null, alt: c.lines[0]?.name ?? c.label }} size="sm" sx={{ width: 48, height: 48 }} />
            <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 650, color: brand.muted }}>{c.shop.name}</Typography>
              <Typography variant="body2" sx={{ color: brand.forest }}>
                <Box component="strong" sx={{ fontWeight: 700 }}>{plural(c.units, "item")}</Box>{" · "}{bundleSummary(c)}
              </Typography>
            </Box>
            <Typography className="tabular" sx={{ fontWeight: 800 }}>{money(c.total_minor, c.currency)}</Typography>
            <Button variant="outlined" color="inherit" size="small" onClick={() => onView(i)} aria-label={`View ${c.shop.name}: ${bundleTitle(c)}`}>View</Button>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** Every other shop checked: why nothing fit, or what it had that isn't shown. */
function OtherShops({ details, shown, onSend, disabled }: { details: ConciergeDetails; shown: Set<string>; onSend: (text: string) => void; disabled?: boolean }) {
  const others = details.shops.filter((s) => !shown.has(s.slug));
  const [open, setOpen] = useState(shown.size === 0);
  if (!others.length) return null;
  const nothing = others.every((s) => !s.options);
  const title = !shown.size ? `Checked ${plural(others.length, "shop")}` : nothing
    ? `${plural(others.length, "other shop")} had nothing that fits` : `${plural(others.length, "other shop")} checked`;
  return (
    <Box sx={{ flex: "1 1 420px", minWidth: 0, border: 1, borderColor: brand.line, borderRadius: "14px", bgcolor: "#fff" }}>
      <Button fullWidth color="inherit" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="other-shops"
        endIcon={open ? <ExpandLessRounded /> : <ExpandMoreRounded />} sx={{ justifyContent: "space-between", minHeight: 52, px: 2, fontWeight: 650, borderRadius: "14px" }}>
        {title}
      </Button>
      <Collapse in={open} id="other-shops">
        <Box component="ul" sx={{ listStyle: "none", m: 0, px: 2, pb: 1.75, pt: 0.25, display: "grid", gap: 1.25 }}>
          {others.map((s) => (
            <Box component="li" key={s.slug} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", typography: "body2" }}>
              <Box component="span" sx={{ flex: "1 1 240px" }}>
                <Box component="strong" sx={{ fontWeight: 650 }}>{s.name}</Box>
                <Box component="span" sx={{ color: brand.muted }}>
                  {" · "}{s.options ? `${plural(s.options, "bundle")} fit${s.from_minor !== null ? `, from ${money(s.from_minor, s.currency)}` : ""}` : s.reason}
                </Box>
              </Box>
              {s.options ? (
                <Button size="small" variant="outlined" color="inherit" disabled={disabled} onClick={() => onSend(`Show me bundles from ${s.name}`)}>Show these</Button>
              ) : null}
            </Box>
          ))}
        </Box>
      </Collapse>
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
