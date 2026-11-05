"""Imports every module that registers background job handlers.

The worker imports this before claiming jobs, so a handler exists for every kind it may see.
"""

from __future__ import annotations

from app.services import holds, inventory, jobs, pickup  # noqa: F401 - registers holds.sweep, inventory.monitor, jobs.cleanup, pickup.ensure_slots
