"""assets: photos stored in PostgreSQL (WebP, full size and thumbnail)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0008'
down_revision: str | None = '0007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('assets',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=True),
    sa.Column('filename', sa.String(length=200), nullable=False),
    sa.Column('content_type', sa.String(length=40), nullable=False),
    sa.Column('width', sa.Integer(), nullable=False),
    sa.Column('height', sa.Integer(), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('data', sa.LargeBinary(), nullable=True),
    sa.Column('thumb', sa.LargeBinary(), nullable=True),
    sa.Column('attribution', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_by', sa.String(length=80), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_assets_merchant_id'), 'assets', ['merchant_id'], unique=False)
    op.create_index(op.f('ix_assets_sha256'), 'assets', ['sha256'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_assets_sha256'), table_name='assets')
    op.drop_index(op.f('ix_assets_merchant_id'), table_name='assets')
    op.drop_table('assets')
