"""Invented names. One small trap per function; the tests in map-fixes.test.mjs say what the map may and may not claim about each."""
import os
import threading


class Hush:
    def __enter__(self):
        return self

    def __exit__(self, kind, value, trace):
        return True


class Plain:
    def __enter__(self):
        return self

    def __exit__(self, kind, value, trace):
        return False


def always_fails():
    raise ValueError("no")


def stamp(text):
    open("stamp.txt", "w").write(text)


def log_line(text):
    open("lines.txt", "a").write(text)


def hushed():
    with Hush():
        always_fails()
    stamp("hushed")


def plain():
    with Plain():
        always_fails()
    stamp("plain")


def give_up(code):
    raise SystemExit(code)


def pick(flag):
    if flag:
        give_up(2)
    stamp("picked")


def after_stop(text):
    always_fails()
    log_line(text)


def purge(path):
    if os.remove(path):
        pass
    stamp("purged")


class Worker:
    def step(self):
        raise NotImplementedError

    def go(self):
        self.step()
        stamp("go")


class Impl(Worker):
    def step(self):
        stamp("impl")


def must_clean(flag):
    try:
        if flag:
            raise ValueError("bad")
        return 1
    finally:
        open("cleaned.txt", "w").close()


def call_twice(fn):
    fn()
    fn()


def helper():
    stamp("helper")


def drive():
    call_twice(helper)


class Poller:
    def work(self):
        stamp("work")

    def start(self):
        threading.Thread(target=self.work).start()
