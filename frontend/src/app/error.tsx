"use client";

import { ArrowBackRounded } from "@mui/icons-material";
import { Box, Button, Container, Typography } from "@mui/material";
import { useEffect } from "react";

import { Wordmark } from "@/components/site";
import { ErrorState } from "@/components/ui";

export default function GlobalSegmentError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Container component="main" id="main" maxWidth="sm" sx={{ py: 8 }}>
      <Wordmark />
      <Typography variant="h2" component="h1" sx={{ mt: 4 }}>
        This page hit a problem
      </Typography>
      <ErrorState
        sx={{ mt: 3 }}
        title="Nothing was charged twice"
        message="Orders are only marked paid after PayPal confirms them. Try again, or go back to the bakery."
        onRetry={retry}
      />
      <Box sx={{ mt: 3 }}>
        <Button href="/" variant="outlined" color="inherit" startIcon={<ArrowBackRounded />}>
          Back to the bakery
        </Button>
      </Box>
    </Container>
  );
}
