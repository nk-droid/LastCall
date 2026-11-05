"""shopping: intents, bundle proposals, quotes, holds, substitution offers and the AI call log

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-06
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('ai_invocations',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('task', sa.String(length=40), nullable=False),
    sa.Column('prompt_version', sa.String(length=40), nullable=False),
    sa.Column('provider', sa.String(length=30), nullable=False),
    sa.Column('model', sa.String(length=80), nullable=False),
    sa.Column('input_hash', sa.String(length=64), nullable=False),
    sa.Column('validation_result', sa.String(length=30), nullable=False),
    sa.Column('failure_reason', sa.Text(), nullable=True),
    sa.Column('latency_ms', sa.Integer(), nullable=False),
    sa.Column('input_tokens', sa.Integer(), nullable=True),
    sa.Column('output_tokens', sa.Integer(), nullable=True),
    sa.Column('repaired', sa.Boolean(), nullable=False),
    sa.Column('fallback_used', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_ai_invocations_task'), 'ai_invocations', ['task'], unique=False)
    op.create_table('customer_intents',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('raw_text_redacted', sa.Text(), nullable=False),
    sa.Column('structured_constraints', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('field_sources', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('clarifications', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('warnings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('parser', sa.String(length=20), nullable=False),
    sa.Column('prompt_version', sa.String(length=40), nullable=False),
    sa.Column('ai_invocation_id', sa.String(length=40), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_customer_intents_session_id'), 'customer_intents', ['session_id'], unique=False)
    op.create_table('bundle_proposals',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('intent_id', sa.String(length=40), nullable=False),
    sa.Column('options', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('no_match', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('excluded', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('engine_version', sa.String(length=40), nullable=False),
    sa.Column('ai_invocation_id', sa.String(length=40), nullable=True),
    sa.Column('inventory_as_of', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['intent_id'], ['customer_intents.id'], ),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_bundle_proposals_session_id'), 'bundle_proposals', ['session_id'], unique=False)
    op.create_table('bundle_quotes',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('lineage_id', sa.String(length=40), nullable=False),
    sa.Column('quote_version', sa.Integer(), nullable=False),
    sa.Column('supersedes_quote_id', sa.String(length=40), nullable=True),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('intent_id', sa.String(length=40), nullable=True),
    sa.Column('proposal_id', sa.String(length=40), nullable=True),
    sa.Column('option_id', sa.String(length=60), nullable=True),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.Column('item_lines', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('subtotal_reference_minor', sa.Integer(), nullable=False),
    sa.Column('discount_minor', sa.Integer(), nullable=False),
    sa.Column('subtotal_minor', sa.Integer(), nullable=False),
    sa.Column('tax_minor', sa.Integer(), nullable=False),
    sa.Column('fees_minor', sa.Integer(), nullable=False),
    sa.Column('amount_minor', sa.Integer(), nullable=False),
    sa.Column('pickup_slot_id', sa.String(length=40), nullable=False),
    sa.Column('pickup_slot_snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('eligibility_snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('invalid_reason', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('trace_id', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('amount_minor > 0', name='ck_quote_amount_positive'),
    sa.ForeignKeyConstraint(['intent_id'], ['customer_intents.id'], ),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.ForeignKeyConstraint(['pickup_slot_id'], ['pickup_slots.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('lineage_id', 'quote_version', name='uq_quote_lineage_version')
    )
    op.create_index(op.f('ix_bundle_quotes_lineage_id'), 'bundle_quotes', ['lineage_id'], unique=False)
    op.create_index(op.f('ix_bundle_quotes_session_id'), 'bundle_quotes', ['session_id'], unique=False)
    op.create_index(op.f('ix_bundle_quotes_status'), 'bundle_quotes', ['status'], unique=False)
    op.create_table('reservations',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('quote_id', sa.String(length=40), nullable=False),
    sa.Column('merchant_id', sa.String(length=40), nullable=False),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('pickup_slot_id', sa.String(length=40), nullable=False),
    sa.Column('sku_qty', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('state', sa.String(length=24), nullable=False),
    sa.Column('slot_booked', sa.Boolean(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('released_reason', sa.String(length=80), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('committed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('fulfilled_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['merchant_id'], ['merchants.id'], ),
    sa.ForeignKeyConstraint(['pickup_slot_id'], ['pickup_slots.id'], ),
    sa.ForeignKeyConstraint(['quote_id'], ['bundle_quotes.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('quote_id')
    )
    op.create_index('ix_reservations_state_expiry', 'reservations', ['state', 'expires_at'], unique=False)
    op.create_table('substitution_offers',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('original_quote_id', sa.String(length=40), nullable=False),
    sa.Column('proposed_quote_id', sa.String(length=40), nullable=True),
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('trigger', sa.String(length=30), nullable=False),
    sa.Column('reasons', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('comparison', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('alternatives', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('explanation', sa.Text(), nullable=False),
    sa.Column('explanation_source', sa.String(length=20), nullable=False),
    sa.Column('ai_invocation_id', sa.String(length=40), nullable=True),
    sa.Column('state', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['original_quote_id'], ['bundle_quotes.id'], ),
    sa.ForeignKeyConstraint(['proposed_quote_id'], ['bundle_quotes.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_substitution_offers_original_quote_id'), 'substitution_offers', ['original_quote_id'], unique=False)
    op.create_table('reservation_lines',
    sa.Column('id', sa.String(length=40), nullable=False),
    sa.Column('reservation_id', sa.String(length=40), nullable=False),
    sa.Column('product_id', sa.String(length=40), nullable=False),
    sa.Column('sku', sa.String(length=32), nullable=False),
    sa.Column('qty', sa.Integer(), nullable=False),
    sa.CheckConstraint('qty > 0', name='ck_reservation_line_qty_positive'),
    sa.ForeignKeyConstraint(['product_id'], ['products.id'], ),
    sa.ForeignKeyConstraint(['reservation_id'], ['reservations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('reservation_id', 'product_id', name='uq_reservation_line_product')
    )
    op.create_index(op.f('ix_reservation_lines_product_id'), 'reservation_lines', ['product_id'], unique=False)
    op.create_index(op.f('ix_reservation_lines_reservation_id'), 'reservation_lines', ['reservation_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_reservation_lines_reservation_id'), table_name='reservation_lines')
    op.drop_index(op.f('ix_reservation_lines_product_id'), table_name='reservation_lines')
    op.drop_table('reservation_lines')
    op.drop_index(op.f('ix_substitution_offers_original_quote_id'), table_name='substitution_offers')
    op.drop_table('substitution_offers')
    op.drop_index('ix_reservations_state_expiry', table_name='reservations')
    op.drop_table('reservations')
    op.drop_index(op.f('ix_bundle_quotes_status'), table_name='bundle_quotes')
    op.drop_index(op.f('ix_bundle_quotes_session_id'), table_name='bundle_quotes')
    op.drop_index(op.f('ix_bundle_quotes_lineage_id'), table_name='bundle_quotes')
    op.drop_table('bundle_quotes')
    op.drop_index(op.f('ix_bundle_proposals_session_id'), table_name='bundle_proposals')
    op.drop_table('bundle_proposals')
    op.drop_index(op.f('ix_customer_intents_session_id'), table_name='customer_intents')
    op.drop_table('customer_intents')
    op.drop_index(op.f('ix_ai_invocations_task'), table_name='ai_invocations')
    op.drop_table('ai_invocations')
