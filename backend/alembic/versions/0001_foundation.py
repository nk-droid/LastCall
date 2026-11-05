"""foundation: audit trail, job queue and system state

Revision ID: 0001
Revises:
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('audit_events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('actor', sa.String(length=80), nullable=False),
    sa.Column('actor_role', sa.String(length=20), nullable=False),
    sa.Column('entity_type', sa.String(length=40), nullable=False),
    sa.Column('entity_id', sa.String(length=64), nullable=False),
    sa.Column('action', sa.String(length=60), nullable=False),
    sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('correlation_id', sa.String(length=64), nullable=True),
    sa.Column('trace_id', sa.String(length=40), nullable=True),
    sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_audit_entity', 'audit_events', ['entity_type', 'entity_id'], unique=False)
    op.create_index(op.f('ix_audit_events_trace_id'), 'audit_events', ['trace_id'], unique=False)
    op.create_table('jobs',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('kind', sa.String(length=60), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('dedupe_key', sa.String(length=160), nullable=True),
    sa.Column('state', sa.String(length=12), nullable=False),
    sa.Column('run_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('max_attempts', sa.Integer(), nullable=False),
    sa.Column('locked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('locked_by', sa.String(length=80), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('dedupe_key')
    )
    op.create_index('ix_jobs_state_run_at', 'jobs', ['state', 'run_at'], unique=False)
    op.create_table('system_state',
    sa.Column('key', sa.String(length=80), nullable=False),
    sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )

    # Audit records are immutable: block UPDATE and DELETE at the database level.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        "CREATE TRIGGER audit_events_no_mutation BEFORE UPDATE OR DELETE ON audit_events "
        "FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_events_no_mutation ON audit_events")
    op.execute("DROP FUNCTION IF EXISTS audit_events_append_only()")
    op.drop_table('system_state')
    op.drop_index('ix_jobs_state_run_at', table_name='jobs')
    op.drop_table('jobs')
    op.drop_index(op.f('ix_audit_events_trace_id'), table_name='audit_events')
    op.drop_index('ix_audit_entity', table_name='audit_events')
    op.drop_table('audit_events')
