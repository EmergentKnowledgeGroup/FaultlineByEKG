"""Routing step: decide where one parcel goes, or park it."""
from dataclasses import dataclass

from . import config


class TransientError(Exception):
    """The carrier call failed in a way that may work next time."""


@dataclass
class Verdict:
    label: str = ""
    hold_reason: str = ""


def book_carrier(parcel):
    """Pretend carrier call. Outage-zone postcodes (99xxx) always fail."""
    if parcel["postcode"].startswith("99"):
        raise TransientError(f"carrier unreachable for {parcel['postcode']}")
    return "LBL-" + parcel["id"]


def route(parcel, book=book_carrier):
    """Customs and unverifiable addresses are parked; everything else gets a carrier label."""
    if parcel["declared_cents"] > config.customs_limit_cents() and not parcel.get("customs_cleared"):
        return Verdict(hold_reason="customs")
    if parcel["postcode"].startswith("ZZ"):
        return Verdict(hold_reason="address")
    return Verdict(label=book(parcel))
