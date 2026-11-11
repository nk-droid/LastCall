"""support replies: the agent run that drafted a reply and what it checked with PayPal

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-11
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0016'
down_revision: str | None = '0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('support_requests', sa.Column('ai_run_id', sa.String(length=40), nullable=True))
    op.add_column('support_requests', sa.Column('ai_checks', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('support_requests', 'ai_checks')
    op.drop_column('support_requests', 'ai_run_id')
