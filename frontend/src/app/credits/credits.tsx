"use client";

import { BakeryDiningRounded, PhotoCameraRounded } from "@mui/icons-material";
import { Box, Divider, Link, Stack, Typography } from "@mui/material";
import { Fragment, type ReactNode } from "react";

import { ProductImage } from "@/components/product-image";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, LoadingBlock, MetaRow, PageHeader, SectionCard } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { PhotoCredit } from "@/lib/types";
import { useResource } from "@/lib/use-api";

/** Author, source and licence for every openly licensed product photo, grouped by shop. */
export function Credits() {
  const credits = useResource((signal) => api<{ photos: PhotoCredit[] }>("/api/credits", { signal }), []);
  const shops = new Map<string, { name: string; photos: PhotoCredit[] }>();
  for (const photo of credits.data?.photos ?? []) {
    const shop = shops.get(photo.shop.slug) ?? { name: photo.shop.name, photos: [] };
    shop.photos.push(photo);
    shops.set(photo.shop.slug, shop);
  }

  return (
    <PageShell width="narrow">
      <PageHeader title="Photo credits" subtitle="Product photos on the showcase shops are openly licensed. Each one's author, source and licence." />
      {credits.error && !credits.data ? (
        <ErrorState title="Couldn't load photo credits" message={errorMessage(credits.error)} onRetry={credits.reload} />
      ) : !credits.data ? (
        <LoadingBlock label="Loading photo credits" slow={credits.slow} />
      ) : !shops.size ? (
        <EmptyState icon={PhotoCameraRounded} title="No licensed photos yet">
          Photos that shops upload themselves need no credit here.
        </EmptyState>
      ) : (
        <Stack spacing={3}>
          {[...shops.entries()].map(([slug, shop]) => (
            <SectionCard key={slug} title={shop.name} subtitle={`${shop.photos.length} photos`} icon={<BakeryDiningRounded />}>
              <Stack component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
                {shop.photos.map((photo, i) => (
                  <Fragment key={photo.image_url}>
                    {i ? <Divider component="li" aria-hidden /> : null}
                    <Stack component="li" direction="row" spacing={2} sx={{ alignItems: "center", py: 1.25 }}>
                      <ProductImage image={{ url: photo.image_url, alt: "" }} size="sm" />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 650 }}>
                          {photo.product}
                        </Typography>
                        <MetaRow
                          sx={{ overflowWrap: "anywhere" }}
                          items={[
                            photo.author ? `Photo by ${photo.author}` : "Photo",
                            photo.license_url ? <ExternalLink href={photo.license_url}>{photo.license}</ExternalLink> : photo.license,
                            photo.url ? <ExternalLink href={photo.url}>{photo.source ?? "Source"}</ExternalLink> : null,
                          ]}
                        />
                      </Box>
                    </Stack>
                  </Fragment>
                ))}
              </Stack>
            </SectionCard>
          ))}
        </Stack>
      )}
    </PageShell>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}
