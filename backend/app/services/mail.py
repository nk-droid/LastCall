"""Transactional email: written to the outbox inside the caller's transaction, delivered by the worker.

Templates are plain Python so subjects and bodies stay reviewable in code. Links and codes carry
secrets (reset, invite and order-link tokens, pickup codes), so they appear only in the message
body, never in the stored context or in logs. Delivery is SMTP with retries; without SMTP
configured, messages are marked skipped (the console offers links to share instead).
"""

from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage as MimeMessage
from email.utils import make_msgid
from html import escape
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.config import settings
from app.db import transaction
from app.ids import new_id
from app.models import EmailMessage
from app.services import jobs

log = logging.getLogger(__name__)
MAX_ATTEMPTS = 5


@dataclass(frozen=True)
class Rendered:
    subject: str
    text: str
    html: str


def app_link(path: str) -> str:
    return settings().public_app_url.rstrip("/") + path


def _html(paragraphs: list[str], action: tuple[str, str] | None = None) -> str:
    body = "".join(f"<p style=\"margin:0 0 14px\">{escape(p)}</p>" for p in paragraphs)
    if action:
        label, url = action
        body += (f'<p style="margin:20px 0"><a href="{escape(url)}" style="background:#247B54;color:#fff;padding:12px 20px;'
                 f'border-radius:10px;text-decoration:none;font-weight:600">{escape(label)}</a></p>'
                 f'<p style="margin:0;color:#52645B;font-size:13px">Or paste this link into your browser: {escape(url)}</p>')
    return (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F8F7F2;padding:24px">'
        '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #DCE3DE;border-radius:14px;padding:28px;color:#14231D">'
        '<div style="font-weight:800;font-size:20px;margin-bottom:18px">Last<span style="color:#247B54">Call</span></div>'
        f"{body}</div></div>"
    )


def render(template: str, ctx: dict[str, Any], link: str | None) -> Rendered:
    if template == "password_reset":
        lines = [f"Hi {ctx['name']},", "We received a request to reset your LastCall password. The link below works once and expires in 1 hour.",
                 "If you didn't ask for this, you can ignore this email; your password stays the same."]
        return Rendered("Reset your LastCall password", "\n\n".join([*lines, link or ""]), _html(lines, ("Choose a new password", link or "")))
    if template == "staff_invite":
        lines = [f"{ctx['inviter']} invited you to join {ctx['shop']} on LastCall as {ctx['role_label']}.",
                 "Accept the invitation to manage surplus, orders and pickups from the merchant console. The link expires in 7 days."]
        return Rendered(f"Join {ctx['shop']} on LastCall", "\n\n".join([*lines, link or ""]), _html(lines, ("Accept invitation", link or "")))
    if template == "shop_submitted":
        lines = [f"{ctx['owner']} submitted {ctx['shop']} for review.", "Check the profile, pickup address, policies and allergen records, then approve it or send it back with a note."]
        return Rendered(f"Review request: {ctx['shop']}", "\n\n".join([*lines, link or ""]), _html(lines, ("Open review", link or "")))
    if template == "shop_approved":
        lines = [f"Good news: {ctx['shop']} is live on LastCall.", "Shoppers can now find your shop, build bundles from today's surplus and pay with PayPal."]
        return Rendered(f"{ctx['shop']} is live on LastCall", "\n\n".join([*lines, link or ""]), _html(lines, ("Open your console", link or "")))
    if template == "shop_rejected":
        lines = [f"{ctx['shop']} needs a few changes before it can go live.", f"Reviewer note: {ctx['note']}", "Update your shop and submit it again."]
        return Rendered(f"Changes needed for {ctx['shop']}", "\n\n".join([*lines, link or ""]), _html(lines, ("Update your shop", link or "")))
    if template == "shop_suspended":
        lines = [f"{ctx['shop']} has been paused on LastCall and isn't taking new orders.", f"Reason: {ctx['note']}",
                 "Existing orders stay in your console. Reply to this email to resolve it."]
        return Rendered(f"{ctx['shop']} is paused", "\n\n".join([*lines, link or ""]), _html(lines, ("Open your console", link or "")))
    if template == "order_confirmed":
        lines = [f"Hi {ctx['name']}, your order at {ctx['shop']} is confirmed and paid.", f"Order {ctx['order_number']} · {ctx['total']}",
                 *ctx["items"], f"Pickup: {ctx['pickup']} at {ctx['address']}", f"Your pickup code: {ctx['code']}",
                 "Show the code at the counter. Your order page has the code, a QR pass and cancellation options."]
        return Rendered(f"Order {ctx['order_number']} confirmed: pickup {ctx['pickup']}", "\n\n".join([*lines, link or ""]),
                        _html(lines, ("View your pickup pass", link or "")))
    if template == "order_ready":
        lines = [f"Hi {ctx['name']}, order {ctx['order_number']} is packed and ready at {ctx['shop']}.", f"Pickup: {ctx['pickup']} at {ctx['address']}",
                 "Bring the pickup code from your order page."]
        return Rendered(f"Order {ctx['order_number']} is ready for pickup", "\n\n".join([*lines, link or ""]), _html(lines, ("Open your pickup pass", link or "")))
    if template == "refund_completed":
        lines = [f"Hi {ctx['name']}, PayPal has completed your refund of {ctx['refund']} for order {ctx['order_number']} at {ctx['shop']}.",
                 "It goes back to the payment method you used with PayPal."]
        return Rendered(f"Refund of {ctx['refund']} completed", "\n\n".join([*lines, link or ""]), _html(lines, ("View your order", link or "")))
    raise ValueError(f"unknown email template {template}")


def queue(db: Session, *, to: str, template: str, context: dict[str, Any], link: str | None = None,
          secret: dict[str, Any] | None = None) -> EmailMessage:
    """Render and store a message; ``secret`` values are rendered into the body but not kept in its context."""
    rendered = render(template, {**context, **(secret or {})}, link)
    message = EmailMessage(id=new_id("eml"), to_email=to, template=template, subject=rendered.subject, text_body=rendered.text,
                           html_body=rendered.html, context=context, status="queued")
    db.add(message)
    return message


# --------------------------------------------------------------------------- delivery


def _send(message: EmailMessage) -> None:
    s = settings()
    mime = MimeMessage()
    mime["Subject"] = message.subject
    mime["From"] = s.smtp_from
    mime["To"] = message.to_email
    mime["Message-ID"] = make_msgid(domain="lastcall.app")
    mime.set_content(message.text_body)
    if message.html_body:
        mime.add_alternative(message.html_body, subtype="html")
    with smtplib.SMTP(s.smtp_host or "", s.smtp_port, timeout=15) as smtp:
        if s.smtp_starttls:
            smtp.starttls()
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password or "")
        smtp.send_message(mime)


def deliver_pending(limit: int = 20) -> dict[str, int]:
    configured = settings().mail_configured
    sent = skipped = failed = 0
    with transaction() as db:
        rows = db.scalars(select(EmailMessage).where(EmailMessage.status == "queued").order_by(EmailMessage.created_at)
                          .limit(limit).with_for_update(skip_locked=True)).all()
        for message in rows:
            if not configured:
                message.status = "skipped"
                skipped += 1
                continue
            message.attempts += 1
            try:
                _send(message)
            except (OSError, smtplib.SMTPException) as exc:
                message.last_error = f"{exc.__class__.__name__}: {exc}"[:500]
                if message.attempts >= MAX_ATTEMPTS:
                    message.status = "failed"
                    failed += 1
                log.warning("email delivery failed", extra={"template": message.template, "attempt": message.attempts})
                continue
            message.status = "sent"
            message.sent_at = clock.now()
            sent += 1
    return {"sent": sent, "skipped": skipped, "failed": failed}


@jobs.handler("email.deliver", every=30)
def _deliver(_: dict[str, Any]) -> dict[str, Any]:
    return deliver_pending()
