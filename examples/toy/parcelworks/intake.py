"""Intake: check a raw parcel request, refuse bad ones, hand good ones to the queue."""
import re

from . import config
from .schema import JobStatus, Parcel, Refusal

REQUIRED = ("id", "sender", "recipient", "postcode", "weight_g")
SERVICES = ("standard", "express")
POSTCODE = re.compile(r"^[A-Z0-9]{5}$")
FAST_LANE_MAX_G = 500


def validate(raw):
    """Turn a dict into a Parcel or raise Refusal with a stable code."""
    for key in REQUIRED:
        if not raw.get(key):
            raise Refusal("missing_field", f"{key} is required")
    weight = raw["weight_g"]
    if not isinstance(weight, int) or weight <= 0:
        raise Refusal("bad_weight", "weight_g must be a positive whole number")
    if weight > config.max_weight_g():
        raise Refusal("overweight", f"{weight} g is over the {config.max_weight_g()} g limit")
    if not POSTCODE.match(str(raw["postcode"])):
        raise Refusal("bad_postcode", "postcode must be 5 capital letters or digits")
    service = raw.get("service", "standard")
    if service not in SERVICES:
        raise Refusal("bad_service", f"service must be one of {', '.join(SERVICES)}")
    return Parcel(id=str(raw["id"]), sender=raw["sender"], recipient=raw["recipient"],
                  postcode=raw["postcode"], weight_g=weight,
                  declared_cents=int(raw.get("declared_cents", 0)), service=service)


def accept(queue, raw):
    """Validate, refuse duplicates, then enqueue. Returns a small receipt."""
    parcel = validate(raw)
    if queue.exists(parcel.id):
        raise Refusal("duplicate", f"{parcel.id} is already in the system")
    if config.fast_lane() and parcel.service == "express" and parcel.weight_g <= FAST_LANE_MAX_G:
        queue.enqueue(parcel, status=JobStatus.DONE)
        return {"id": parcel.id, "lane": "fast", "status": "done"}
    queue.enqueue(parcel)
    return {"id": parcel.id, "lane": "normal", "status": "pending"}
