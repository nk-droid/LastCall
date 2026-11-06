"""agent proposals: changes an agent suggests and a person approves (the close-out plan)

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0013'
down_revision: str | None = '0012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'agent_proposals',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('kind', sa.String(length=40), nullable=False),
        sa.Column('merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=False),
        sa.Column('run_id', sa.String(length=40), nullable=True),
        sa.Column('subject_date', sa.String(length=10), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('actions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_by', sa.String(length=120), nullable=False),
        sa.Column('decided_by', sa.String(length=120), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_agent_proposals_kind', 'agent_proposals', ['kind'])
    op.create_index('ix_agent_proposals_merchant_id', 'agent_proposals', ['merchant_id'])


def downgrade() -> None:
    op.drop_index('ix_agent_proposals_merchant_id', table_name='agent_proposals')
    op.drop_index('ix_agent_proposals_kind', table_name='agent_proposals')
    op.drop_table('agent_proposals')
