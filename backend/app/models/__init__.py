"""SQLAlchemy models. PostgreSQL is the system of record for stock, money and payment state.

Each domain keeps its tables in its own module; everything is re-exported here so callers
import from ``app.models``.
"""

from app.models.accounts import SHOP_ROLES, Invite, Membership, PasswordReset, User, UserSession
from app.models.base import Base
from app.models.catalog import (
    PRODUCT_CATEGORIES,
    AnalyticsEvent,
    InventoryEvent,
    InventoryLot,
    MerchantAlert,
    PickupSlot,
    Price,
    Product,
)
from app.models.merchants import MERCHANT_STATUSES, Merchant
from app.models.notifications import EmailMessage
from app.models.system import AuditEvent, Job, SystemState

__all__ = [
    "MERCHANT_STATUSES", "PRODUCT_CATEGORIES", "SHOP_ROLES",
    "AnalyticsEvent", "AuditEvent", "Base", "EmailMessage", "InventoryEvent", "InventoryLot", "Invite", "Job", "Membership", "Merchant",
    "MerchantAlert", "PasswordReset", "PickupSlot", "Price", "Product", "SystemState", "User", "UserSession",
]
