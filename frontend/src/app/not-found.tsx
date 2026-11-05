import { SearchOffRounded } from "@mui/icons-material";
import { Button } from "@mui/material";

import { PageShell } from "@/components/site";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <PageShell width="narrow">
      <EmptyState icon={SearchOffRounded} headingComponent="h1" title="We couldn't find that page" action={<Button href="/" variant="contained">Back to the bakery</Button>}>
        The link may be out of date, or the bundle or order has expired.
      </EmptyState>
    </PageShell>
  );
}
