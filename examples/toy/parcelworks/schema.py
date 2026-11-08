"""Shared vocabulary: job states, parcel outcomes, the parcel record, refusal errors."""
import enum
from dataclasses import asdict, dataclass


class JobStatus(enum.Enum):
    PENDING = "pending"
    LEASED = "leased"
    DONE = "done"
    FAILED = "failed"
    HOLD = "hold"


class Outcome(enum.Enum):
    """What the report counts a parcel as."""
    DELIVERED = "delivered"
    DEAD_LETTER = "dead_letter"
    HELD = "held"
    RETURNED = "returned_to_sender"


class Refusal(Exception):
    """Intake said no. `code` is the stable reason, `message` is for people."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Parcel:
    id: str
    sender: str
    recipient: str
    postcode: str
    weight_g: int
    declared_cents: int = 0
    service: str = "standard"

    def to_dict(self):
        return asdict(self)
