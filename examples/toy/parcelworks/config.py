"""Settings read from the environment at call time, so tests can patch os.environ."""
import os


def fast_lane():
    """FAST_LANE=1 lets small express parcels skip the queue. Off by default."""
    return os.environ.get("FAST_LANE", "0") == "1"


def max_attempts():
    """MAX_ATTEMPTS: tries a job gets before it is failed for good."""
    return int(os.environ.get("MAX_ATTEMPTS", "4"))


def max_weight_g():
    """MAX_WEIGHT_G: heaviest parcel intake accepts, in grams."""
    return int(os.environ.get("MAX_WEIGHT_G", "30000"))


def lease_seconds():
    """LEASE_SECONDS: how long a worker owns a claimed job before it can be reclaimed."""
    return float(os.environ.get("LEASE_SECONDS", "30"))


def backoff_base_s():
    """BACKOFF_BASE_S: first retry delay; each later retry doubles it."""
    return float(os.environ.get("BACKOFF_BASE_S", "2"))


def customs_limit_cents():
    """CUSTOMS_LIMIT_CENTS: declared value above which a parcel waits for paperwork."""
    return int(os.environ.get("CUSTOMS_LIMIT_CENTS", "50000"))


def db_path():
    """PARCELWORKS_DB: where the queue file lives."""
    return os.environ.get("PARCELWORKS_DB", "parcelworks.db")
