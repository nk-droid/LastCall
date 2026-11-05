"""daily listings: per-product repeat-daily listing templates

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0009'
down_revision: str | None = '0008'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('products', sa.Column('relist_daily', sa.Boolean(), server_default=sa.false(), nullable=False))
    op.add_column('products', sa.Column('relist_qty', sa.Integer(), server_default='0', nullable=False))
    op.add_column('products', sa.Column('relist_cutoff_local', sa.String(length=5), nullable=True))


def downgrade() -> None:
    op.drop_column('products', 'relist_cutoff_local')
    op.drop_column('products', 'relist_qty')
    op.drop_column('products', 'relist_daily')
