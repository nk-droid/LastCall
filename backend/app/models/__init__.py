"""SQLAlchemy models. PostgreSQL is the system of record for stock, money and payment state.

Each domain keeps its tables in its own module; everything is re-exported here so callers
import from ``app.models``.
"""

from app.models.accounts import SHOP_ROLES, Invite, Membership, PasswordReset, User, UserSession
from app.models.agents import AgentRun, AgentStep, Conversation
from app.models.ai import AIInvocation
from app.models.base import Base
from app.models.catalog import (
    PRODUCT_CATEGORIES,
    AnalyticsEvent,
    InventoryEvent,
    InventoryLot,
    MerchantAlert,
    MetricSnapshot,
    PickupSlot,
    Price,
    Product,
)
from app.models.media import Asset
from app.models.merchants import MERCHANT_STATUSES, Merchant
from app.models.notifications import EmailMessage
from app.models.orders import FaultInjection, Order, PaymentAttempt, Refund, SupportRequest, WebhookEvent
from app.models.shopping import BundleProposal, BundleQuote, CustomerIntent, Reservation, ReservationLine, SubstitutionOffer
from app.models.system import AuditEvent, Job, SystemState
from app.models.watches import Watch, WatchMatch

__all__ = [
    "MERCHANT_STATUSES", "PRODUCT_CATEGORIES", "SHOP_ROLES",
    "AgentRun", "AgentStep", "AIInvocation", "Conversation", "AnalyticsEvent", "Asset", "AuditEvent", "BundleProposal", "BundleQuote", "CustomerIntent", "Base", "EmailMessage", "FaultInjection", "InventoryEvent", "InventoryLot", "Invite", "Job", "Membership", "Merchant",
    "MerchantAlert", "MetricSnapshot", "Order", "PasswordReset", "PaymentAttempt", "PickupSlot", "Price", "Product", "Refund", "Reservation", "ReservationLine", "SubstitutionOffer", "SupportRequest", "Watch", "WatchMatch", "SystemState", "User", "UserSession", "WebhookEvent",
]
