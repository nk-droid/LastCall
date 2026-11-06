"""concierge: shopper conversations with the shopping agent

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0011'
down_revision: str | None = '0010'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'agent_conversations',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('kind', sa.String(length=40), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('user_id', sa.String(length=40), nullable=True),
        sa.Column('scope_merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=True),
        sa.Column('messages', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('progress', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('last_run_id', sa.String(length=40), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_agent_conversations_session_id', 'agent_conversations', ['session_id'])


def downgrade() -> None:
    op.drop_index('ix_agent_conversations_session_id', table_name='agent_conversations')
    op.drop_table('agent_conversations')
