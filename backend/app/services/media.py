"""Image intake: validate, normalize and store photos in the asset table.

Every upload is decoded and re-encoded with Pillow, so only real images get through and
metadata (EXIF, GPS) is stripped. Photos are resized to at most 1600px (and a 480px thumbnail)
and stored as WebP.
"""

from __future__ import annotations

import hashlib
import io
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import NotFound, Unprocessable
from app.ids import new_id
from app.models import Asset, Merchant, Product

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 40_000_000
FULL_EDGE = 1600
THUMB_EDGE = 480
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "HEIC", "MPO"}
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def _encode(image: Image.Image, edge: int, quality: int) -> bytes:
    copy = image.copy()
    copy.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    copy.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


def process(raw: bytes) -> tuple[bytes, bytes, int, int]:
    if not raw:
        raise Unprocessable("The file is empty", code="image_empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise Unprocessable("Photos must be 8 MB or smaller", code="image_too_large")
    try:
        probe = Image.open(io.BytesIO(raw))
        probe.verify()  # structural check; the image must be reopened afterwards
        image = Image.open(io.BytesIO(raw))
        if image.format not in ALLOWED_FORMATS:
            raise Unprocessable("Upload a JPEG, PNG or WebP photo", code="image_type")
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise Unprocessable("That file isn't a photo we can read", code="image_invalid") from exc
    full = _encode(image, FULL_EDGE, 82)
    thumb = _encode(image, THUMB_EDGE, 78)
    width, height = Image.open(io.BytesIO(full)).size
    return full, thumb, width, height


def store(db: Session, raw: bytes, *, filename: str, merchant_id: str | None, actor: str,
          attribution: dict[str, Any] | None = None) -> Asset:
    full, thumb, width, height = process(raw)
    digest = hashlib.sha256(full).hexdigest()
    owner = Asset.merchant_id.is_(None) if merchant_id is None else Asset.merchant_id == merchant_id
    existing = db.scalar(select(Asset).where(Asset.sha256 == digest, owner))
    if existing is not None:
        return existing  # identical photo already stored for this owner
    asset = Asset(id=new_id("img"), merchant_id=merchant_id, filename=filename[:200] or "photo", content_type="image/webp", width=width,
                  height=height, size_bytes=len(full), sha256=digest, data=full, thumb=thumb, attribution=attribution or {}, created_by=actor)
    db.add(asset)
    db.flush()
    return asset


def url(asset_id: str) -> str:
    return f"/api/assets/{asset_id}"


def credits(db: Session) -> list[dict[str, Any]]:
    """Credits for the licensed photos live shops show (openly licensed photos must name their author and licence)."""
    prefix = url("")
    rows = db.execute(
        select(Product.name, Product.image_url, Merchant.name, Merchant.slug)
        .join(Merchant, Merchant.id == Product.merchant_id)
        .where(Merchant.status == "live", Product.image_url.startswith(prefix))
        .order_by(Merchant.name, Product.name)
    ).all()
    ids = {image.removeprefix(prefix) for _, image, _, _ in rows}
    found = dict(db.execute(select(Asset.id, Asset.attribution).where(Asset.id.in_(ids))).tuples().all()) if ids else {}
    out = []
    for product, image, shop, slug in rows:
        credit = found.get(image.removeprefix(prefix)) or {}
        if credit.get("license"):
            out.append({"product": product, "shop": {"name": shop, "slug": slug}, "image_url": image,
                        **{k: credit.get(k) for k in ("title", "author", "source", "url", "license", "license_url")}})
    return out


def load(db: Session, asset_id: str, size: str) -> tuple[bytes, str, str]:
    column = Asset.thumb if size == "thumb" else Asset.data
    row = db.execute(select(column, Asset.content_type, Asset.sha256).where(Asset.id == asset_id)).first()
    if row is None:
        raise NotFound("Image not found")
    data, content_type, digest = row
    return data, content_type, f'"{digest[:32]}-{size}"'
