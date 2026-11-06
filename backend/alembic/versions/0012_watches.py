"""watches: shoppers' standing requests and the bundles they were emailed about

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0012'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'watches',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('user_id', sa.String(length=40), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=True),
        sa.Column('text_redacted', sa.Text(), nullable=False),
        sa.Column('constraints', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('stop_token', sa.String(length=64), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_notified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_scanned_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_watches_user_id', 'watches', ['user_id'])
    op.create_index('ix_watches_status', 'watches', ['status'])
    op.create_table(
        'watch_matches',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('watch_id', sa.String(length=40), sa.ForeignKey('watches.id', ondelete='CASCADE'), nullable=False),
        sa.Column('merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=False),
        sa.Column('signature', sa.String(length=300), nullable=False),
        sa.Column('label', sa.String(length=80), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('summary_source', sa.String(length=20), nullable=False),
        sa.Column('total_minor', sa.Integer(), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('pickup_label', sa.String(length=80), nullable=False),
        sa.Column('agent_run_id', sa.String(length=40), nullable=True),
        sa.Column('email_message_id', sa.String(length=40), nullable=True),
        sa.Column('opened_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('quote_id', sa.String(length=40), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('watch_id', 'merchant_id', 'signature', name='uq_watch_match_bundle'),
    )
    op.create_index('ix_watch_matches_watch_id', 'watch_matches', ['watch_id'])


def downgrade() -> None:
    op.drop_index('ix_watch_matches_watch_id', table_name='watch_matches')
    op.drop_table('watch_matches')
    op.drop_index('ix_watches_status', table_name='watches')
    op.drop_index('ix_watches_user_id', table_name='watches')
    op.drop_table('watches')
