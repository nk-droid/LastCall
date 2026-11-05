"""accounts: merchants, users, sessions, memberships, invites, password resets and the email outbox

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('email_outbox',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('to_email', sa.String(length=254), nullable=False),
    sa.Column('template', sa.String(length=40), nullable=False),
    sa.Column('subject', sa.String(length=200), nullable=False),
    sa.Column('text_body', sa.Text(), nullable=False),
    sa.Column('html_body', sa.Text(), nullable=False),
    sa.Column('context', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_email_outbox_status'), 'email_outbox', ['status'], unique=False)
    op.create_index(op.f('ix_email_outbox_template'), 'email_outbox', ['template'], unique=False)
    op.create_table('merchants',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('slug', sa.String(length=80), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('tagline', sa.String(length=200), nullable=False),
    sa.Column('category', sa.String(length=40), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('address', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('phone', sa.String(length=40), nullable=False),
    sa.Column('support_email', sa.String(length=160), nullable=False),
    sa.Column('timezone', sa.String(length=64), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('hours', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('pickup_config', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('policies', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('policy_version', sa.Integer(), nullable=False),
    sa.Column('paypal', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('verification', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('pickup_paused', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('is_showcase', sa.Boolean(), nullable=False),
    sa.Column('review_note', sa.Text(), nullable=True),
    sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('slug')
    )
    op.create_index(op.f('ix_merchants_status'), 'merchants', ['status'], unique=False)
    op.create_table('users',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('display_name', sa.String(length=120), nullable=False),
    sa.Column('phone', sa.String(length=40), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=True),
    sa.Column('is_platform_admin', sa.Boolean(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('failed_logins', sa.Integer(), nullable=False),
    sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email')
    )
    op.create_table('invites',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('role', sa.String(length=12), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('invited_by', sa.String(length=40), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['invited_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index(op.f('ix_invites_merchant_id'), 'invites', ['merchant_id'], unique=False)
    op.create_table('memberships',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('user_id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('role', sa.String(length=12), nullable=False),
    sa.Column('invited_by', sa.String(length=40), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'merchant_id', name='uq_membership_user_merchant')
    )
    op.create_index(op.f('ix_memberships_merchant_id'), 'memberships', ['merchant_id'], unique=False)
    op.create_index(op.f('ix_memberships_user_id'), 'memberships', ['user_id'], unique=False)
    op.create_table('password_resets',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('user_id', sa.String(length=40), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index(op.f('ix_password_resets_user_id'), 'password_resets', ['user_id'], unique=False)
    op.create_table('user_sessions',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('user_id', sa.String(length=40), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('active_merchant_id', sa.String(length=40), nullable=True),
    sa.Column('user_agent', sa.String(length=200), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['active_merchant_id'], ['merchants.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index(op.f('ix_user_sessions_user_id'), 'user_sessions', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_user_sessions_user_id'), table_name='user_sessions')
    op.drop_table('user_sessions')
    op.drop_index(op.f('ix_password_resets_user_id'), table_name='password_resets')
    op.drop_table('password_resets')
    op.drop_index(op.f('ix_memberships_user_id'), table_name='memberships')
    op.drop_index(op.f('ix_memberships_merchant_id'), table_name='memberships')
    op.drop_table('memberships')
    op.drop_index(op.f('ix_invites_merchant_id'), table_name='invites')
    op.drop_table('invites')
    op.drop_table('users')
    op.drop_index(op.f('ix_merchants_status'), table_name='merchants')
    op.drop_table('merchants')
    op.drop_index(op.f('ix_email_outbox_template'), table_name='email_outbox')
    op.drop_index(op.f('ix_email_outbox_status'), table_name='email_outbox')
    op.drop_table('email_outbox')
