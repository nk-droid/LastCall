"""catalog: products, surplus lots, prices, pickup slots, inventory events, alerts and analytics events

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('analytics_events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('event_name', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=True),
    sa.Column('entity_type', sa.String(length=40), nullable=True),
    sa.Column('entity_id', sa.String(length=64), nullable=True),
    sa.Column('properties', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_analytics_merchant_name_time', 'analytics_events', ['merchant_id', 'event_name', 'created_at'], unique=False)
    op.create_table('merchant_alerts',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('entity_type', sa.String(length=40), nullable=False),
    sa.Column('entity_id', sa.String(length=64), nullable=False),
    sa.Column('severity', sa.String(length=12), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('uq_open_alert', 'merchant_alerts', ['merchant_id', 'kind', 'entity_id'], unique=True, postgresql_where=sa.text('resolved_at IS NULL'))
    op.create_table('pickup_slots',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ends_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('capacity', sa.Integer(), nullable=False),
    sa.Column('booked_count', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.CheckConstraint('booked_count >= 0', name='ck_slot_booked_nonneg'),
    sa.CheckConstraint('capacity >= 0', name='ck_slot_capacity_nonneg'),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('merchant_id', 'starts_at', name='uq_slot_merchant_start')
    )
    op.create_index(op.f('ix_pickup_slots_merchant_id'), 'pickup_slots', ['merchant_id'], unique=False)
    op.create_table('products',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('sku', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('description_source', sa.String(length=30), nullable=False),
    sa.Column('image_url', sa.String(length=500), nullable=True),
    sa.Column('category', sa.String(length=30), nullable=False),
    sa.Column('attributes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('allergens', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('allergen_source', sa.String(length=40), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('per_order_limit', sa.Integer(), nullable=False),
    sa.Column('surplus_priority', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('merchant_id', 'sku', name='uq_products_merchant_sku')
    )
    op.create_index(op.f('ix_products_merchant_id'), 'products', ['merchant_id'], unique=False)
    op.create_table('inventory_events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('product_id', sa.String(length=40), nullable=False),
    sa.Column('sku', sa.String(length=32), nullable=False),
    sa.Column('event_type', sa.String(length=30), nullable=False),
    sa.Column('delta', sa.Integer(), nullable=False),
    sa.Column('surplus_before', sa.Integer(), nullable=False),
    sa.Column('surplus_after', sa.Integer(), nullable=False),
    sa.Column('actor', sa.String(length=80), nullable=False),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('reference_id', sa.String(length=40), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.ForeignKeyConstraint(['product_id'], ['products.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_inventory_events_product_time', 'inventory_events', ['product_id', 'created_at'], unique=False)
    op.create_table('inventory_lots',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('product_id', sa.String(length=40), nullable=False),
    sa.Column('on_hand', sa.Integer(), nullable=False),
    sa.Column('surplus_qty', sa.Integer(), nullable=False),
    sa.Column('buffer_qty', sa.Integer(), nullable=False),
    sa.Column('cutoff_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('updated_by', sa.String(length=80), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('buffer_qty >= 0', name='ck_lot_buffer_nonneg'),
    sa.CheckConstraint('on_hand >= 0', name='ck_lot_on_hand_nonneg'),
    sa.CheckConstraint('surplus_qty >= 0', name='ck_lot_surplus_nonneg'),
    sa.ForeignKeyConstraint(['product_id'], ['products.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('product_id')
    )
    op.create_table('prices',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('product_id', sa.String(length=40), nullable=False),
    sa.Column('sku', sa.String(length=32), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('reference_minor', sa.Integer(), nullable=False),
    sa.Column('sale_minor', sa.Integer(), nullable=False),
    sa.Column('tax_category', sa.String(length=40), nullable=False),
    sa.Column('reference_source', sa.Text(), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_by', sa.String(length=80), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('reference_minor >= sale_minor', name='ck_price_reference_gte_sale'),
    sa.CheckConstraint('sale_minor > 0', name='ck_price_sale_positive'),
    sa.ForeignKeyConstraint(['product_id'], ['products.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_prices_product_effective', 'prices', ['product_id', 'effective_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_prices_product_effective', table_name='prices')
    op.drop_table('prices')
    op.drop_table('inventory_lots')
    op.drop_index('ix_inventory_events_product_time', table_name='inventory_events')
    op.drop_table('inventory_events')
    op.drop_index(op.f('ix_products_merchant_id'), table_name='products')
    op.drop_table('products')
    op.drop_index(op.f('ix_pickup_slots_merchant_id'), table_name='pickup_slots')
    op.drop_table('pickup_slots')
    op.drop_index('uq_open_alert', table_name='merchant_alerts', postgresql_where=sa.text('resolved_at IS NULL'))
    op.drop_table('merchant_alerts')
    op.drop_index('ix_analytics_merchant_name_time', table_name='analytics_events')
    op.drop_table('analytics_events')
