"use client";

import { BakeryDiningRounded, BreakfastDiningRounded, CakeRounded, CookieRounded, LunchDiningRounded } from "@mui/icons-material";
import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

import type { ImageRef } from "@/lib/types";

import { brand, sxs, type Icon } from "./ui";

const CATEGORY_ICON: Record<string, Icon> = {
  pastry: BakeryDiningRounded,
  bread: BreakfastDiningRounded,
  cookie: CookieRounded,
  cake: CakeRounded,
  savory: LunchDiningRounded,
};

/** A product photo from the shop, or (until one is uploaded) a quiet labelled placeholder. Never a fake photo. */
export function ProductImage({ image, category, sx, size = "md", rounded = true }: {
  image: ImageRef;
  category?: string;
  sx?: SxProps<Theme>;
  size?: "sm" | "md" | "lg";
  rounded?: boolean;
}) {
  const dims = size === "sm" ? { width: 64, height: 56, flexShrink: 0 } : { width: "100%", aspectRatio: "4 / 3" };
  const shape = { borderRadius: rounded ? (size === "sm" ? "10px" : "12px") : 0, overflow: "hidden", display: "block" };
  if (image.url) {
    const src = size === "sm" ? `${image.url}?size=thumb` : image.url;
    return <Box component="img" src={src} alt={image.alt} loading="lazy" decoding="async" sx={sxs(dims, shape, { objectFit: "cover", bgcolor: brand.sand }, sx)} />;
  }
  const Glyph = CATEGORY_ICON[category ?? ""] ?? BakeryDiningRounded;
  return (
    <Box role="img" aria-label={image.alt} sx={sxs(dims, shape, { bgcolor: brand.mint, border: `1px solid ${brand.line}`, display: "grid", placeItems: "center", color: brand.leaf }, sx)}>
      <Glyph aria-hidden sx={{ fontSize: size === "sm" ? 26 : 44, opacity: 0.75 }} />
    </Box>
  );
}
