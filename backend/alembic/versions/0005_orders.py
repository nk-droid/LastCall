"""orders: orders, payment attempts, refunds, webhook events, support requests and fault injection

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Human-friendly order numbers (LC-1042, LC-1043, ...).
    op.execute("CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 1042")
    op.create_table('fault_injections',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('remaining', sa.Integer(), nullable=False),
    sa.Column('created_by', sa.String(length=80), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_fault_injections_kind'), 'fault_injections', ['kind'], unique=False)
    op.create_table('webhook_events',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('provider_event_id', sa.String(length=120), nullable=False),
    sa.Column('event_type', sa.String(length=80), nullable=False),
    sa.Column('resource_type', sa.String(length=40), nullable=True),
    sa.Column('resource_id', sa.String(length=80), nullable=True),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('verification', sa.String(length=30), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('raw_body', sa.Text(), nullable=False),
    sa.Column('transmission', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('duplicate_count', sa.Integer(), nullable=False),
    sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('processing_result', sa.Text(), nullable=True),
    sa.Column('received_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('provider_event_id')
    )
    op.create_table('orders',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('order_number', sa.String(length=20), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('quote_id', sa.String(length=40), nullable=False),
    sa.Column('reservation_id', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('customer_user_id', sa.String(length=40), nullable=True),
    sa.Column('customer_contact', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('payment_status', sa.String(length=24), nullable=False),
    sa.Column('fulfillment_status', sa.String(length=16), nullable=False),
    sa.Column('refund_status', sa.String(length=16), nullable=False),
    sa.Column('amount_minor', sa.Integer(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('pickup_slot_id', sa.String(length=40), nullable=False),
    sa.Column('pickup_starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('pickup_ends_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('pickup_code_hash', sa.String(length=64), nullable=False),
    sa.Column('pickup_code_salt', sa.String(length=40), nullable=False),
    sa.Column('pickup_attempts', sa.Integer(), nullable=False),
    sa.Column('access_token_hash', sa.String(length=64), nullable=False),
    sa.Column('cancel_request', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('packed_skus', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('exception_flags', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('ready_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('picked_up_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('pickup_expired_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('contact_purged_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('trace_id', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['customer_user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.ForeignKeyConstraint(['pickup_slot_id'], ['pickup_slots.id'], ),
    sa.ForeignKeyConstraint(['quote_id'], ['bundle_quotes.id'], ),
    sa.ForeignKeyConstraint(['reservation_id'], ['reservations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('order_number'),
    sa.UniqueConstraint('quote_id')
    )
    op.create_index(op.f('ix_orders_customer_user_id'), 'orders', ['customer_user_id'], unique=False)
    op.create_index(op.f('ix_orders_fulfillment_status'), 'orders', ['fulfillment_status'], unique=False)
    op.create_index(op.f('ix_orders_merchant_id'), 'orders', ['merchant_id'], unique=False)
    op.create_index(op.f('ix_orders_payment_status'), 'orders', ['payment_status'], unique=False)
    op.create_index(op.f('ix_orders_session_id'), 'orders', ['session_id'], unique=False)
    op.create_table('payment_attempts',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('order_id', sa.String(length=40), nullable=False),
    sa.Column('quote_id', sa.String(length=40), nullable=False),
    sa.Column('provider', sa.String(length=20), nullable=False),
    sa.Column('environment', sa.String(length=20), nullable=False),
    sa.Column('paypal_order_id', sa.String(length=64), nullable=True),
    sa.Column('capture_id', sa.String(length=64), nullable=True),
    sa.Column('request_id', sa.String(length=64), nullable=False),
    sa.Column('capture_request_id', sa.String(length=64), nullable=True),
    sa.Column('state', sa.String(length=24), nullable=False),
    sa.Column('provider_state', sa.String(length=40), nullable=True),
    sa.Column('amount_minor', sa.Integer(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('captured_amount_minor', sa.Integer(), nullable=True),
    sa.Column('last_error', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('provider_debug_id', sa.String(length=80), nullable=True),
    sa.Column('create_response', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('capture_response', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('reconcile_count', sa.Integer(), nullable=False),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('capture_requested_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('captured_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ),
    sa.ForeignKeyConstraint(['quote_id'], ['bundle_quotes.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('capture_id'),
    sa.UniqueConstraint('capture_request_id'),
    sa.UniqueConstraint('paypal_order_id'),
    sa.UniqueConstraint('request_id')
    )
    op.create_index(op.f('ix_payment_attempts_order_id'), 'payment_attempts', ['order_id'], unique=False)
    op.create_index(op.f('ix_payment_attempts_state'), 'payment_attempts', ['state'], unique=False)
    op.create_table('support_requests',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('order_id', sa.String(length=40), nullable=False),
    sa.Column('topic', sa.String(length=40), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('ai_draft', sa.Text(), nullable=False),
    sa.Column('ai_draft_source', sa.String(length=20), nullable=False),
    sa.Column('ai_invocation_id', sa.String(length=40), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('staff_reply', sa.Text(), nullable=True),
    sa.Column('replied_by', sa.String(length=80), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('replied_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_support_requests_order_id'), 'support_requests', ['order_id'], unique=False)
    op.create_table('refunds',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('payment_attempt_id', sa.String(length=40), nullable=False),
    sa.Column('order_id', sa.String(length=40), nullable=False),
    sa.Column('amount_minor', sa.Integer(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('paypal_refund_id', sa.String(length=64), nullable=True),
    sa.Column('request_id', sa.String(length=64), nullable=False),
    sa.Column('state', sa.String(length=20), nullable=False),
    sa.Column('provider_status', sa.String(length=40), nullable=True),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('requested_by', sa.String(length=80), nullable=False),
    sa.Column('return_to_stock', sa.Boolean(), nullable=False),
    sa.Column('last_error', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint('amount_minor > 0', name='ck_refund_amount_positive'),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ),
    sa.ForeignKeyConstraint(['payment_attempt_id'], ['payment_attempts.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('paypal_refund_id'),
    sa.UniqueConstraint('request_id')
    )
    op.create_index(op.f('ix_refunds_order_id'), 'refunds', ['order_id'], unique=False)
    op.create_index(op.f('ix_refunds_payment_attempt_id'), 'refunds', ['payment_attempt_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_refunds_payment_attempt_id'), table_name='refunds')
    op.drop_index(op.f('ix_refunds_order_id'), table_name='refunds')
    op.drop_table('refunds')
    op.drop_index(op.f('ix_support_requests_order_id'), table_name='support_requests')
    op.drop_table('support_requests')
    op.drop_index(op.f('ix_payment_attempts_state'), table_name='payment_attempts')
    op.drop_index(op.f('ix_payment_attempts_order_id'), table_name='payment_attempts')
    op.drop_table('payment_attempts')
    op.drop_index(op.f('ix_orders_session_id'), table_name='orders')
    op.drop_index(op.f('ix_orders_payment_status'), table_name='orders')
    op.drop_index(op.f('ix_orders_merchant_id'), table_name='orders')
    op.drop_index(op.f('ix_orders_fulfillment_status'), table_name='orders')
    op.drop_index(op.f('ix_orders_customer_user_id'), table_name='orders')
    op.drop_table('orders')
    op.drop_table('webhook_events')
    op.drop_index(op.f('ix_fault_injections_kind'), table_name='fault_injections')
    op.drop_table('fault_injections')
    op.execute("DROP SEQUENCE IF EXISTS order_number_seq")
