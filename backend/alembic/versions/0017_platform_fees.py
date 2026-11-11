"""platform fees: LastCall's commission on each paid order and the weekly PayPal invoices that bill it

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-11
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0017'
down_revision: str | None = '0016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'fee_invoices',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=False, index=True),
        sa.Column('number', sa.String(length=40), nullable=False, unique=True),
        sa.Column('paypal_invoice_id', sa.String(length=64), nullable=True, unique=True),
        sa.Column('status', sa.String(length=24), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('charges_minor', sa.Integer(), nullable=False),
        sa.Column('credit_minor', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('amount_minor', sa.Integer(), nullable=False),
        sa.Column('orders', sa.Integer(), nullable=False),
        sa.Column('lines', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='[]'),
        sa.Column('period_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('recipient_email', sa.String(length=320), nullable=False),
        sa.Column('payer_url', sa.String(length=500), nullable=True),
        sa.Column('request_id', sa.String(length=64), nullable=False, unique=True),
        sa.Column('last_error', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        'platform_fees',
        sa.Column('id', sa.String(length=40), primary_key=True),
        sa.Column('merchant_id', sa.String(length=40), sa.ForeignKey('merchants.id'), nullable=False, index=True),
        sa.Column('order_id', sa.String(length=40), sa.ForeignKey('orders.id'), nullable=False, unique=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('basis_minor', sa.Integer(), nullable=False),
        sa.Column('rate_bps', sa.Integer(), nullable=False),
        sa.Column('min_minor', sa.Integer(), nullable=False),
        sa.Column('fee_minor', sa.Integer(), nullable=False),
        sa.Column('billed_minor', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('invoice_id', sa.String(length=40), sa.ForeignKey('fee_invoices.id'), nullable=True, index=True),
        sa.Column('accrued_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint('fee_minor >= 0 AND billed_minor >= 0 AND basis_minor >= 0', name='ck_platform_fee_amounts'),
    )


def downgrade() -> None:
    op.drop_table('platform_fees')
    op.drop_table('fee_invoices')
