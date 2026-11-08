"""Test helpers: a clock the test controls, parcel builders, an env patch."""
import os
from contextlib import contextmanager

from parcelworks.jobqueue import Queue


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_queue():
    clock = FakeClock()
    return Queue(":memory:", clock=clock), clock


def raw(pid="pw-1", **over):
    base = {"id": pid, "sender": "Ann", "recipient": "Bo", "postcode": "12345", "weight_g": 800}
    base.update(over)
    return base


@contextmanager
def env(**values):
    """Set environment variables for a block, then restore them."""
    old = {k: os.environ.get(k) for k in values}
    os.environ.update({k: str(v) for k, v in values.items()})
    try:
        yield
    finally:
        for key, was in old.items():
            if was is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = was
