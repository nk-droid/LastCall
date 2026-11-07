"""agent timing: when each model turn and tool call started within its run, for the Ops trace timeline

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('agent_steps', sa.Column('offset_ms', sa.Integer(), nullable=True))
    op.add_column('ai_invocations', sa.Column('offset_ms', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('ai_invocations', 'offset_ms')
    op.drop_column('agent_steps', 'offset_ms')
