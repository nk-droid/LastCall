"use client";

// Where PayPal sends the owner after "Connect with PayPal". The code and state go to the server, which reads
// which PayPal account signed in, checks it can receive payments, and saves it as the shop's payout account.

import { Box, Button, Stack } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { ErrorState, LoadingBlock, PageHeader } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ShopSettings } from "@/lib/types";

export function PayPalReturn() {
  const params = useSearchParams();
  const router = useRouter();
  const announce = useAnnounce();
  const code = params.get("code");
  const state = params.get("state");
  const denied = params.get("error");
  const missing = denied || !code || !state
    ? denied === "access_denied" ? "You cancelled the PayPal sign-in. Nothing changed." : "PayPal didn't send the sign-in back. Try again from Payouts."
    : null;
  const [failed, setFailed] = useState<string | null>(null);
  const sent = useRef(false); // a code works once, so never send it twice
  const error = missing ?? failed;

  useEffect(() => {
    if (missing || sent.current) return;
    sent.current = true;
    api<ShopSettings>("/api/merchant/shop/payouts/paypal/finish", { method: "POST", body: { code, state } })
      .then((settings) => {
        announce("PayPal account connected");
        router.replace(settings.shop.status === "live" ? "/merchant/settings?tab=payouts" : "/merchant/setup");
      })
      .catch((err) => setFailed(errorMessage(err)));
  }, [missing, code, state, router, announce]);

  return (
    <Box sx={{ maxWidth: 640 }}>
      <PageHeader title="Connecting PayPal" subtitle="Checking the account you signed in with." />
      {error ? (
        <Stack spacing={2}>
          <ErrorState title="PayPal isn't connected" message={error} />
          <Box>
            <Button variant="contained" onClick={() => router.replace("/merchant/settings?tab=payouts")}>Back to payouts</Button>
          </Box>
        </Stack>
      ) : (
        <LoadingBlock label="Connecting your PayPal account" lines={2} />
      )}
    </Box>
  );
}
