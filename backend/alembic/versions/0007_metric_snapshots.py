"""metric snapshots: daily merchant insight aggregates

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0007'
down_revision: str | None = '0006'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('metric_snapshots',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('period', sa.String(length=16), nullable=False),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
    sa.Column('metrics', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('merchant_id', 'period', 'period_start', name='uq_metric_snapshot_period')
    )
    op.create_index(op.f('ix_metric_snapshots_merchant_id'), 'metric_snapshots', ['merchant_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_metric_snapshots_merchant_id'), table_name='metric_snapshots')
    op.drop_table('metric_snapshots')
