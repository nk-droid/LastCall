"""watch alerts: when a shopper saw a match in their alerts inbox, and matches they turned down

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0015'
down_revision: str | None = '0014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('watch_matches', sa.Column('seen_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('watch_matches', sa.Column('dismissed_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('watch_matches', 'dismissed_at')
    op.drop_column('watch_matches', 'seen_at')
