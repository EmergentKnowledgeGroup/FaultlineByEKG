"""Control-flow traps: each decides whether a road can exist."""
import sys
import os
import contextlib
from typing import NoReturn


class CErr(Exception):
    pass


def die(msg) -> NoReturn:
    raise CErr(msg)


def store_it(x):
    with open('x.txt', 'w') as f:
        f.write(str(x))


def next_step(x):
    with open('y.txt', 'w') as f:
        f.write(str(x))


# C1: the arm with die() never reaches next_step. A road from the arm's box to next_step's box is false.
def c1_noreturn(x):
    if x > 0:
        store_it(x)
        die('stop')
    next_step(x)


# C2: sys.exit in the arm
def c2_sysexit(x):
    if x > 0:
        store_it(x)
        sys.exit(1)
    next_step(x)


# C3: os._exit
def c3_os_exit(x):
    if x > 0:
        store_it(x)
        os._exit(1)
    next_step(x)


# C4: a `while True` that only leaves by return: code after is dead
def c4_dead_after_loop(x):
    while True:
        if x > 0:
            store_it(x)
            return 1
        x += 1
    next_step(x)


# C5: for-else: else runs only without break
def c5_for_else(xs):
    for x in xs:
        if x:
            store_it(x)
            break
    else:
        next_step(xs)
        return 'no break'
    return 'break'


# C6: try-else: else does not run after the handler
def c6_try_else(x):
    try:
        store_it(x)
    except OSError:
        print('oh')
        return 'handled'
    else:
        next_step(x)
    return 'ok'


# C7: finally that returns overrides the raise
def c7_finally_return(x):
    try:
        raise CErr('x')
    finally:
        return 'swallowed'


# C8: short-circuit: the right-hand call runs conditionally
def c8_short_circuit(x):
    ok = x and store_it(x)
    return ok


# C9: conditional expression
def c9_ternary(x):
    v = store_it(x) if x else next_step(x)
    return v


# C10: elif chain
def c10_elif(x):
    if x == 1:
        store_it(x)
    elif x == 2:
        next_step(x)
    elif x == 3:
        raise CErr('three')
    else:
        print('other')


# C11: match
def c11_match(x):
    match x:
        case 1:
            store_it(x)
        case 2:
            next_step(x)
        case _:
            raise CErr('no')


# C12: assert false raises under normal python
def c12_assert_false(x):
    if x:
        store_it(x)
        assert False, 'never'
    next_step(x)


# C13: an unreachable statement after return in the same block
def c13_after_return(x):
    return 1
    store_it(x)


# C14: helper that always raises, not declared NoReturn
def always_raises_helper():
    raise CErr('always')


def c14_helper_raises(x):
    if x:
        store_it(x)
        always_raises_helper()
    next_step(x)


# C15: constant guard
TYPE_CHECK = False


def c15_constant_guard(x):
    if TYPE_CHECK:
        store_it(x)
    next_step(x)


# C16: with that swallows: code after a raise inside
def c16_suppress(x):
    with contextlib.suppress(CErr):
        raise CErr('x')
    next_step(x)


# C17: continue in a loop means the rest is skipped
def c17_continue(xs):
    for x in xs:
        if x:
            store_it(x)
            continue
        next_step(x)
