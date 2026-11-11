"use client";

import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

import type { ImageRef } from "@/lib/types";

import { brand, sxs } from "./ui";

/** A product photo from the shop. Shoppers only see products that have one; until it's uploaded the shop sees an empty frame. */
export function ProductImage({ image, sx, size = "md", rounded = true }: {
  image: ImageRef;
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
  return (
    <Box
      role="img"
      aria-label={image.alt}
      sx={sxs(dims, shape, {
        display: "grid", placeItems: "center", textAlign: "center", bgcolor: brand.sand, border: `1px dashed ${brand.line}`,
        color: "text.secondary", fontSize: size === "sm" ? 10 : 13, fontWeight: 600, lineHeight: 1.2, p: 0.5,
      }, sx)}
    >
      No photo
    </Box>
  );
}
