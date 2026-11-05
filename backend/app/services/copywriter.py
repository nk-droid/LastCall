"""L4 product copy helper: an AI draft the merchant reviews before saving.

The draft is cleaned so it can't introduce allergens the merchant didn't list or make
"free-from" claims; a rules-based description is the fallback.
"""

from __future__ import annotations

from typing import Any

from app.ai import prompts
from app.ai.provider import invoke_structured
from app.ai.sanitize import clean_merchant_copy
from app.db import transaction
from app.errors import NotFound
from app.models import Product
from app.services.access import StaffContext, require_role


def draft_copy(ctx: StaffContext, product_id: str, notes: str) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        product = db.get(Product, product_id)
        if product is None or product.merchant_id != ctx.merchant_id:
            raise NotFound("Product not found")
        attrs = product.attributes or {}
        contains = set((product.allergens or {}).get("contains", []))
        name, category = product.name, product.category
        payload = {"name": name, "category": category, "flavor": attrs.get("flavor"), "tags": attrs.get("tags", []),
                   "ingredients": attrs.get("ingredients", ""), "merchant_notes": notes[:300]}
    outcome = invoke_structured(task="L4_copy", prompt_version=prompts.COPY_PROMPT_VERSION, system=prompts.COPY_SYSTEM,
                                payload=payload, output_model=prompts.AICopy)
    fallback = f"{name}: a {attrs.get('flavor', '')} {category} from today's bake, offered as same-day surplus."
    if not outcome.ok:
        return {"draft": fallback, "source": "rules", "removed": [], "requires_approval": True}
    cleaned, removed = clean_merchant_copy(outcome.data.description, contains)
    return {"draft": cleaned or fallback, "source": "ai" if cleaned else "rules", "removed": removed, "requires_approval": True}
