"""Who may do what inside a shop. Roles are per membership: staff < manager < owner.

* staff: count stock, pack orders and hand them off
* manager: also products, prices, allergen data, refunds, settings and inviting staff
* owner: also taxes and fees, PayPal payout account and managing managers
"""

from __future__ import annotations

from dataclasses import dataclass

from app.errors import Forbidden

ROLE_RANK = {"staff": 1, "manager": 2, "owner": 3}
ROLE_LABELS = {"staff": "Staff", "manager": "Manager", "owner": "Owner"}


@dataclass(frozen=True)
class StaffContext:
    """The signed-in person acting inside one shop's console."""

    id: str  # user id
    email: str
    display_name: str
    role: str
    merchant_id: str
    merchant_slug: str
    merchant_status: str
    is_platform_admin: bool = False

    @property
    def actor(self) -> str:
        return f"staff:{self.email}"


def has_role(role: str, required: str) -> bool:
    return ROLE_RANK.get(role, 0) >= ROLE_RANK[required]


def require_role(ctx: StaffContext, required: str) -> None:
    if not has_role(ctx.role, required):
        raise Forbidden(f"This action needs the {ROLE_LABELS[required].lower()} role", code="insufficient_role",
                        details={"required": required, "current": ctx.role})


def actor_name(ctx: StaffContext) -> str:
    return ctx.actor


def assignable_roles(role: str) -> list[str]:
    """Roles a member with ``role`` may grant: managers add staff, owners add anyone."""
    if role == "owner":
        return ["staff", "manager", "owner"]
    if role == "manager":
        return ["staff"]
    return []
