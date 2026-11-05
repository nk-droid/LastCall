"use client";

import { Box } from "@mui/material";

import { LoadingBlock } from "./ui";

/** Suspense fallback for route segments: skeleton lines with a polite status label. */
export function RouteFallback({ label }: { label: string }) {
  return (
    <Box sx={{ p: { xs: 2, sm: 4 }, maxWidth: 1200, mx: "auto", width: "100%" }}>
      <LoadingBlock label={label} lines={4} />
    </Box>
  );
}
