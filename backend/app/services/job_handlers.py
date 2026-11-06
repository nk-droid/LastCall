"""Imports every module that registers background job handlers.

The worker imports this before claiming jobs, so a handler exists for every kind it may see.
"""

from __future__ import annotations

from app.services import (  # noqa: F401 - each module registers its handlers on import
    checkout,
    holds,
    insights,
    inventory,
    jobs,
    listings,
    mail,
    orders,
    overview,
    pickup,
    refunds,
    watches,
    webhooks,
)
