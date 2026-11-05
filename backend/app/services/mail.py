"""Transactional email, written to the outbox inside the caller's transaction.

Templates are plain Python so subjects and bodies stay reviewable in code. Links carry
secrets (reset and invite tokens), so they appear only in the message body, never in the
stored context or in logs.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.ids import new_id
from app.models import EmailMessage


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
    raise ValueError(f"unknown email template {template}")


def queue(db: Session, *, to: str, template: str, context: dict[str, Any], link: str | None = None) -> EmailMessage:
    rendered = render(template, context, link)
    message = EmailMessage(id=new_id("eml"), to_email=to, template=template, subject=rendered.subject, text_body=rendered.text,
                           html_body=rendered.html, context=context, status="queued")
    db.add(message)
    return message
