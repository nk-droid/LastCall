"use client";

import { Alert, AlertTitle, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

type PayPalButtonsInstance = { render: (el: HTMLElement) => Promise<void>; close?: () => Promise<void>; isEligible?: () => boolean };
type PayPalNamespace = {
  Buttons: (options: {
    style?: Record<string, unknown>;
    onClick?: (data: unknown, actions: { resolve: () => Promise<void>; reject: () => Promise<void> }) => Promise<void> | void;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }, actions: { restart: () => Promise<void> }) => Promise<void>;
    onCancel?: (data: { orderID?: string }) => void;
    onError?: (err: unknown) => void;
  }) => PayPalButtonsInstance;
};

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

let sdkPromise: Promise<PayPalNamespace> | null = null;

function loadSdk(clientId: string, currency: string): Promise<PayPalNamespace> {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const params = new URLSearchParams({ "client-id": clientId, currency, intent: "capture", components: "buttons", commit: "true" });
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK loaded without the paypal global")));
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Couldn't load PayPal. Check your connection or disable content blockers, then try again."));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export type PayHandlers = {
  /** Return false to keep the PayPal window from opening (e.g. the form is invalid). */
  validate: () => boolean;
  /** Creates the order on our server from the held quote; resolves to the PayPal order id. */
  createOrder: () => Promise<string>;
  /** Captures on our server. Return "restart" to let the buyer choose another funding source. */
  onApprove: (paypalOrderId: string) => Promise<"done" | "restart">;
  onCancel: () => void;
  onError: (message: string) => void;
};

/** Official PayPal Smart Buttons (Sandbox). Only the public client id reaches the browser. */
export function PayPalSmartButtons({ clientId, currency, handlers, disabled }: { clientId: string; currency: string; handlers: PayHandlers; disabled: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const handlersRef = useRef(handlers);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let cancelled = false;
    let instance: PayPalButtonsInstance | null = null;
    loadSdk(clientId, currency)
      .then((paypal) => {
        if (cancelled || !container.current) return;
        instance = paypal.Buttons({
          style: { layout: "vertical", shape: "rect", label: "paypal", height: 48, tagline: false },
          onClick: (_data, actions) => (handlersRef.current.validate() ? actions.resolve() : actions.reject()),
          createOrder: () => handlersRef.current.createOrder(),
          onApprove: async (data, actions) => {
            const result = await handlersRef.current.onApprove(data.orderID);
            if (result === "restart") await actions.restart();
          },
          onCancel: () => handlersRef.current.onCancel(),
          onError: (err) => handlersRef.current.onError(err instanceof Error ? err.message : "PayPal reported an error. You have not been charged."),
        });
        container.current.innerHTML = "";
        return instance.render(container.current).then(() => !cancelled && setState("ready"));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message);
        setState("failed");
      });
    return () => {
      cancelled = true;
      instance?.close?.().catch(() => {});
    };
  }, [clientId, currency, attempt]);

  return (
    <Box>
      {state === "loading" ? (
        <Stack role="status" direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary", py: 1 }}>
          <CircularProgress size={16} aria-hidden />
          <Typography variant="body2">Loading PayPal…</Typography>
        </Stack>
      ) : null}
      {state === "failed" ? (
        <Alert
          severity="error"
          role="alert"
          action={
            <Button size="small" color="inherit" onClick={() => { setState("loading"); setAttempt((a) => a + 1); }}>
              Try again
            </Button>
          }
        >
          <AlertTitle>PayPal didn&apos;t load</AlertTitle>
          {loadError}
        </Alert>
      ) : null}
      <Box ref={container} aria-hidden={disabled || undefined} sx={disabled ? { pointerEvents: "none", opacity: 0.5 } : undefined} />
    </Box>
  );
}

/** Shown instead of PayPal's buttons when the server has no PayPal Sandbox credentials. */
export function PayPalUnavailable() {
  return (
    <Alert severity="warning" role="status">
      <AlertTitle>PayPal isn&apos;t connected</AlertTitle>
      This server has no PayPal credentials yet, so checkout is unavailable. Your items stay held until the timer runs out.
    </Alert>
  );
}
