"use client";

import { AddRounded, DeleteOutlineRounded, UploadRounded } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Grid,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useRef, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { Dialog } from "@/components/dialog";
import { ProductImage } from "@/components/product-image";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ALLERGEN_LABEL } from "@/lib/format";
import type { InventoryRow } from "@/lib/types";

const CATEGORIES = [
  { value: "pastry", label: "Pastry" }, { value: "bread", label: "Bread" }, { value: "cookie", label: "Cookie" },
  { value: "cake", label: "Cake" }, { value: "savory", label: "Savory" },
];
const ALLERGENS = Object.keys(ALLERGEN_LABEL);

function skuFrom(name: string, taken: Set<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 3).padEnd(2, "X");
  for (let n = 1; n < 100; n++) {
    const sku = `${letters}-${String(n).padStart(2, "0")}`;
    if (!taken.has(sku)) return sku;
  }
  return `${letters}-${Date.now() % 10000}`;
}

export function AddProductButton({ rows, onCreated }: { rows: InventoryRow[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="contained" startIcon={<AddRounded />} onClick={() => setOpen(true)}>
        Add product
      </Button>
      {open ? <AddProductDialog rows={rows} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); onCreated(); }} /> : null}
    </>
  );
}

function AddProductDialog({ rows, onClose, onCreated }: { rows: InventoryRow[]; onClose: () => void; onCreated: () => void }) {
  const announce = useAnnounce();
  const taken = new Set(rows.map((r) => r.sku));
  const [f, setF] = useState({
    name: "", sku: "", category: "pastry", flavor: "sweet", servings: 1, surplus: 6, reference: "", sale: "", reference_source: "Regular menu price for the same item",
    cutoff: "19:00", ingredients: "", description: "", tags: "", vegetarian: true, vegan: false, repeat: true,
  });
  const [contains, setContains] = useState<string[]>([]);
  const [cross, setCross] = useState<string[]>([]);
  const [verified, setVerified] = useState(true);
  const [photo, setPhoto] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [key]: e.target.value }));
  const toggle = (list: string[], setList: (v: string[]) => void, code: string) => setList(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);
  const sku = f.sku || skuFrom(f.name || "Item", taken);
  const reference = Math.round(Number(f.reference) * 100);
  const sale = Math.round(Number(f.sale) * 100);

  async function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    setUploading(true);
    setError(null);
    try {
      setPhoto((await api<{ url: string }>("/api/merchant/assets", { body: form })).url);
      announce("Photo added");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = ""; // picking the same file again still uploads
    }
  }

  async function submit() {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      await api<{ row: InventoryRow }>("/api/merchant/products", {
        body: {
          sku, name: f.name.trim(), description: f.description.trim(), category: f.category, flavor: f.flavor, servings_per_unit: Number(f.servings),
          tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), ingredients: f.ingredients.trim(),
          dietary: { vegetarian: f.vegetarian, vegan: f.vegan },
          allergens: { contains, cross_contact: cross, status: verified ? "verified" : "needs_review", notes: "" },
          per_order_limit: 6, surplus_priority: 1, surplus: Number(f.surplus), reference_minor: reference, sale_minor: sale, image_url: photo,
          reference_source: f.reference_source.trim(), cutoff_local: f.cutoff,
          relist: { enabled: f.repeat, qty: Number(f.surplus), cutoff_local: f.cutoff },
        },
      });
      announce(`${f.name} listed`);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") {
        const fields = err.fieldErrors();
        setErrors(fields);
        if (!Object.keys(fields).length) setError(err.message);
      } else setError(errorMessage(err));
      setBusy(false);
    }
  }

  const valid = f.name.trim().length >= 2 && reference > 0 && sale > 0 && sale <= reference && f.reference_source.trim().length >= 4;
  return (
    <Dialog open onClose={onClose} side title="Add a product" description="Prices, allergens and stock come only from what you enter here."
      actions={
        <>
          <Button onClick={onClose} color="inherit">Cancel</Button>
          <Button variant="contained" loading={busy} disabled={!valid || uploading} onClick={submit}>List product</Button>
        </>
      }>
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      <Stack spacing={2.5}>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 8 }}>
            <TextField label="Name" fullWidth required value={f.name} onChange={set("name")} error={!!errors.name} helperText={errors.name} autoFocus />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField label="SKU" fullWidth value={f.sku} placeholder={sku} onChange={(e) => setF((x) => ({ ...x, sku: e.target.value.toUpperCase() }))}
              error={!!errors.sku} helperText={errors.sku ?? `Auto: ${sku}`} />
          </Grid>
          <Grid size={{ xs: 6, sm: 4 }}>
            <TextField select label="Category" fullWidth value={f.category} onChange={set("category")}>
              {CATEGORIES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid size={{ xs: 6, sm: 4 }}>
            <TextField select label="Taste" fullWidth value={f.flavor} onChange={set("flavor")}>
              <MenuItem value="sweet">Sweet</MenuItem>
              <MenuItem value="savory">Savory</MenuItem>
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField type="number" label="Serves" fullWidth value={f.servings} onChange={set("servings")} slotProps={{ htmlInput: { min: 0.5, max: 12, step: 0.5 } }} />
          </Grid>
        </Grid>

        <Box>
          <Typography variant="subtitle2" component="p">Photo</Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            Optional. Use a real photo of this product; without one, shoppers see a plain placeholder.
          </Typography>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mt: 1.25 }}>
            <ProductImage image={{ url: photo, alt: photo ? `Photo of ${f.name || "the new product"}` : "" }} category={f.category} size="sm" />
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-label="Product photo file"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <Button size="small" variant="outlined" color="inherit" startIcon={<UploadRounded />} loading={uploading} disabled={busy} onClick={() => fileRef.current?.click()}>
              {photo ? "Replace photo" : "Upload photo"}
            </Button>
            {photo ? (
              <Button size="small" color="inherit" startIcon={<DeleteOutlineRounded />} disabled={busy || uploading} onClick={() => setPhoto(null)}>
                Remove
              </Button>
            ) : null}
            <Typography variant="caption" color="text.secondary">JPEG, PNG or WebP · up to 8 MB</Typography>
          </Stack>
        </Box>

        <Grid container spacing={2}>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField type="number" label="Regular price" fullWidth required value={f.reference} onChange={set("reference")}
              slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, htmlInput: { min: 0, step: 0.25 } }} />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField type="number" label="Surplus price" fullWidth required value={f.sale} onChange={set("sale")}
              error={sale > reference && reference > 0} helperText={sale > reference && reference > 0 ? "Can't exceed the regular price" : " "}
              slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, htmlInput: { min: 0, step: 0.25 } }} />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField type="number" label="Today's surplus" fullWidth value={f.surplus} onChange={set("surplus")} slotProps={{ htmlInput: { min: 0, max: 500 } }} />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField type="time" label="Pickup cutoff" fullWidth value={f.cutoff} onChange={set("cutoff")} slotProps={{ inputLabel: { shrink: true } }} />
          </Grid>
          <Grid size={12}>
            <TextField label="Where the regular price comes from" fullWidth required value={f.reference_source} onChange={set("reference_source")}
              helperText="Shown with every saving, e.g. “In-store menu board”. We never invent savings." />
          </Grid>
        </Grid>

        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ fontWeight: 650, color: "text.primary", mb: 0.5 }}>Contains</FormLabel>
          <FormGroup row>
            {ALLERGENS.map((code) => (
              <FormControlLabel key={code} label={ALLERGEN_LABEL[code]} control={<Checkbox checked={contains.includes(code)} onChange={() => toggle(contains, setContains, code)} />} />
            ))}
          </FormGroup>
        </FormControl>
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ fontWeight: 650, color: "text.primary", mb: 0.5 }}>May contain (cross-contact)</FormLabel>
          <FormGroup row>
            {ALLERGENS.map((code) => (
              <FormControlLabel key={code} label={ALLERGEN_LABEL[code]} control={<Checkbox checked={cross.includes(code)} onChange={() => toggle(cross, setCross, code)} />} />
            ))}
          </FormGroup>
        </FormControl>
        <FormControlLabel control={<Checkbox checked={verified} onChange={(e) => setVerified(e.target.checked)} />}
          label={<><Typography component="span" sx={{ fontWeight: 650 }}>I&apos;ve checked this allergen record</Typography>
            <Typography component="span" variant="body2" color="text.secondary"> · unchecked items are never offered to shoppers with a strict allergy</Typography></>} />

        <TextField label="Ingredients" fullWidth multiline minRows={2} value={f.ingredients} onChange={set("ingredients")} />
        <TextField label="Short description" fullWidth multiline minRows={2} value={f.description} onChange={set("description")} slotProps={{ htmlInput: { maxLength: 600 } }} />
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
          <FormControlLabel control={<Checkbox checked={f.vegetarian} onChange={(e) => setF((x) => ({ ...x, vegetarian: e.target.checked }))} />} label="Vegetarian" />
          <FormControlLabel control={<Checkbox checked={f.vegan} onChange={(e) => setF((x) => ({ ...x, vegan: e.target.checked }))} />} label="Vegan" />
          <FormControlLabel control={<Checkbox checked={f.repeat} onChange={(e) => setF((x) => ({ ...x, repeat: e.target.checked }))} />} label="Repeat this listing daily" />
        </Stack>
      </Stack>
    </Dialog>
  );
}
