"""agents: tool-calling runs and their steps; AI invocations can point at a run

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0010'
down_revision: str | None = '0009'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'agent_runs',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('kind', sa.String(length=40), nullable=False),
        sa.Column('prompt_version', sa.String(length=60), nullable=False),
        sa.Column('model', sa.String(length=80), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=True),
        sa.Column('user_id', sa.String(length=40), nullable=True),
        sa.Column('subject_type', sa.String(length=40), nullable=True),
        sa.Column('subject_id', sa.String(length=40), nullable=True),
        sa.Column('steps', sa.Integer(), nullable=False),
        sa.Column('latency_ms', sa.Integer(), nullable=False),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_agent_runs_kind', 'agent_runs', ['kind'])
    op.create_index('ix_agent_runs_session_id', 'agent_runs', ['session_id'])
    op.create_index('ix_agent_runs_subject_id', 'agent_runs', ['subject_id'])
    op.create_table(
        'agent_steps',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('run_id', sa.String(length=40), sa.ForeignKey('agent_runs.id', ondelete='CASCADE'), nullable=False),
        sa.Column('idx', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('tool', sa.String(length=60), nullable=True),
        sa.Column('args', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('ok', sa.Boolean(), nullable=False),
        sa.Column('latency_ms', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_agent_steps_run_id', 'agent_steps', ['run_id'])
    op.add_column('ai_invocations', sa.Column('agent_run_id', sa.String(length=40), nullable=True))
    op.create_index('ix_ai_invocations_agent_run_id', 'ai_invocations', ['agent_run_id'])


def downgrade() -> None:
    op.drop_index('ix_ai_invocations_agent_run_id', table_name='ai_invocations')
    op.drop_column('ai_invocations', 'agent_run_id')
    op.drop_index('ix_agent_steps_run_id', table_name='agent_steps')
    op.drop_table('agent_steps')
    op.drop_index('ix_agent_runs_subject_id', table_name='agent_runs')
    op.drop_index('ix_agent_runs_session_id', table_name='agent_runs')
    op.drop_index('ix_agent_runs_kind', table_name='agent_runs')
    op.drop_table('agent_runs')
