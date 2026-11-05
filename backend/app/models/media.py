"""Images stored in PostgreSQL (product photos, shop photos).

Render's filesystem is ephemeral, so uploads live in the database: each image is re-encoded
to WebP at a display size plus a thumbnail. Assets are immutable; a new photo is a new asset.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Integer, LargeBinary, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, deferred, mapped_column

from app.models.base import Base, created_col


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    # Owning shop; null for platform-curated images.
    merchant_id: Mapped[str | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(40))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    data: Mapped[bytes] = deferred(mapped_column(LargeBinary))
    thumb: Mapped[bytes] = deferred(mapped_column(LargeBinary))
    # Where a curated photo came from ({"source", "author", "url", "license"}); empty for uploads.
    attribution: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_by: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = created_col()
