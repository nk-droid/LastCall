"use client";

import { CloseRounded } from "@mui/icons-material";
import { Box, DialogActions, DialogContent, Drawer, IconButton, Dialog as MuiDialog, Stack, Typography } from "@mui/material";
import { useId, type ReactNode } from "react";

import { brand } from "@/theme/tokens";

/** Modal dialog (or right-hand drawer with `side`). Focus is trapped and restored; Escape closes it. */
export function Dialog({ open, onClose, title, description, children, actions, size = "md", side }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  size?: "md" | "lg";
  side?: boolean;
}) {
  const titleId = useId();
  const descId = useId();
  const header = (
    <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between", px: { xs: 2, sm: 3 }, pt: 2.5, pb: 1 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography id={titleId} variant="h3" component="h2">
          {title}
        </Typography>
        {description ? (
          <Typography id={descId} variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {description}
          </Typography>
        ) : null}
      </Box>
      <IconButton aria-label="Close" onClick={onClose} sx={{ mt: -0.5, mr: -1 }}>
        <CloseRounded />
      </IconButton>
    </Stack>
  );

  if (side) {
    return (
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            role: "dialog",
            "aria-modal": true,
            "aria-labelledby": titleId,
            "aria-describedby": description ? descId : undefined,
            sx: { width: { xs: "100%", sm: 560 }, display: "flex", flexDirection: "column", bgcolor: brand.cream },
          },
        }}
      >
        <Box>{header}</Box>
        <Box sx={{ flex: 1, overflowY: "auto", px: { xs: 2.5, sm: 3 }, py: 3 }}>{children}</Box>
        {actions ? <Box sx={{ px: 3, py: 2 }}>{actions}</Box> : null}
      </Drawer>
    );
  }

  return (
    <MuiDialog open={open} onClose={onClose} fullWidth maxWidth={size === "lg" ? "md" : "sm"} aria-labelledby={titleId} aria-describedby={description ? descId : undefined}>
      {header}
      <DialogContent sx={{ px: { xs: 2, sm: 2.5 }, py: 2.5 }}>{children}</DialogContent>
      {actions ? <DialogActions sx={{ px: 2.5, pb: 2 }}>{actions}</DialogActions> : null}
    </MuiDialog>
  );
}
