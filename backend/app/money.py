"""Money is always integer minor units. These helpers are the only place that
converts to and from decimal strings (PayPal amounts, display labels)."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

# ISO 4217 minor-unit exponents for currencies we can display; default 2.
_EXPONENTS = {"JPY": 0, "KRW": 0, "HUF": 0, "TWD": 0}
_SYMBOLS = {"USD": "$", "CAD": "CA$", "AUD": "A$", "EUR": "€", "GBP": "£", "JPY": "¥"}


def exponent(currency: str) -> int:
    return _EXPONENTS.get(currency.upper(), 2)


def to_decimal_string(minor: int, currency: str) -> str:
    """1600, USD -> '16.00' (the exact string sent to PayPal)."""
    exp = exponent(currency)
    if exp == 0:
        return str(minor)
    sign = "-" if minor < 0 else ""
    whole, frac = divmod(abs(minor), 10**exp)
    return f"{sign}{whole}.{frac:0{exp}d}"


def from_decimal_string(value: str, currency: str) -> int:
    """'16.00', USD -> 1600. Rejects values with more precision than the currency allows."""
    exp = exponent(currency)
    quantized = Decimal(value) * (10**exp)
    if quantized != quantized.to_integral_value():
        raise ValueError(f"{value} has too many decimal places for {currency}")
    return int(quantized)


def format_money(minor: int, currency: str) -> str:
    symbol = _SYMBOLS.get(currency.upper(), currency.upper() + " ")
    return f"{symbol}{to_decimal_string(minor, currency)}"


def apply_rate_bps(amount_minor: int, rate_bps: int) -> int:
    """Tax on an amount, rounded half-up to the minor unit."""
    if rate_bps <= 0:
        return 0
    value = (Decimal(amount_minor) * Decimal(rate_bps) / Decimal(10_000)).quantize(
        Decimal(1), rounding=ROUND_HALF_UP
    )
    return int(value)
