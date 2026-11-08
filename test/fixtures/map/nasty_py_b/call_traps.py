"""Roads the checker pins, that the program does not take. Bottom prints what really ran."""
import functools
RAN = []


def real_target():
    RAN.append('real_target')
    with open('z.txt', 'w') as f:
        f.write('z')


def named_target():
    RAN.append('named_target')
    with open('y.txt', 'w') as f:
        f.write('y')


# K1: a decorator replaces the function. Calling `decorated` runs real_target, never the body.
def replace_with(other):
    def deco(fn):
        return other
    return deco


@replace_with(real_target)
def decorated():
    named_target()
    with open('w.txt', 'w') as f:
        f.write('never')


def k1_caller():
    decorated()


# K2: rebinding at module level after the def
def rebound():
    named_target()
    with open('v.txt', 'w') as f:
        f.write('never')


rebound = real_target


def k2_caller():
    rebound()


# K3: instance attribute shadows the method
class Shadow:
    def __init__(self):
        self.go = real_target

    def go(self):
        named_target()
        with open('u.txt', 'w') as f:
            f.write('never')


def k3_caller():
    Shadow().go()


# K4: monkeypatch of the class
class Patched:
    def run(self):
        named_target()
        with open('t.txt', 'w') as f:
            f.write('never')


Patched.run = lambda self: real_target()


def k4_caller():
    Patched().run()


# K5: __new__ returns another class, so __init__ never runs
class Other:
    pass


class Maker:
    def __new__(cls):
        return Other()

    def __init__(self):
        named_target()
        with open('s.txt', 'w') as f:
            f.write('never')


def k5_caller():
    Maker()


# K6: diamond: super().step() at run time goes to the sibling, not the base the checker names
class Base:
    def step(self):
        named_target()
        with open('r.txt', 'w') as f:
            f.write('base')


class Left(Base):
    def step(self):
        super().step()


class Right(Base):
    def step(self):
        real_target()


class Both(Left, Right):
    pass


def k6_caller():
    Both().step()


# K7: conditional def: both exist, one runs
FLAG = False
if FLAG:
    def cond():
        named_target()
        with open('q.txt', 'w') as f:
            f.write('never')
else:
    def cond():
        real_target()


def k7_caller():
    cond()


# K8: try/except ImportError: fallback def
try:
    from json import loads as maybe_loads
except ImportError:
    def maybe_loads(s):
        named_target()
        with open('p.txt', 'w') as f:
            f.write('never')
        return s


def k8_caller():
    return maybe_loads('1')


# K9: a local variable shadows a function in the same module with a lambda
def k9_shadow():
    named_target = lambda: 1
    named_target()


# K10: functools.wraps wrapper that never calls the original
def block(fn):
    @functools.wraps(fn)
    def inner(*a, **k):
        return None
    return inner


@block
def blocked():
    named_target()
    with open('o.txt', 'w') as f:
        f.write('never')


def k10_caller():
    blocked()


# K11: subclass overrides, and the receiver is really the subclass, typed as the base
class Svc:
    def work(self):
        named_target()
        with open('n.txt', 'w') as f:
            f.write('base')


class SubSvc(Svc):
    def work(self):
        real_target()


def k11_make() -> Svc:
    return SubSvc()


def k11_caller():
    k11_make().work()


if __name__ == '__main__':
    k1_caller()
    k2_caller()
    k3_caller()
    k4_caller()
    k5_caller()
    k6_caller()
    k7_caller()
    k8_caller()
    k10_caller()
    k11_caller()
    k9_shadow()
    print(RAN)
