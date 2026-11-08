"""Exception-road traps. Every function is called from the bottom so the fixture can be run and its real behaviour printed."""
import asyncio
import functools
import contextlib
import sys


class BoomError(Exception):
    pass


def gen_raises():
    raise BoomError("from a generator body")
    yield 1


def plain_raises():
    raise BoomError("plain")


# T1: calling a generator function runs nothing: the handler cannot take it at the call.
def t1_generator_call_never_raises():
    try:
        it = gen_raises()
    except BoomError:
        print("t1 handler ran")
        return "t1-handled"
    return ("t1-not-handled", it)


# T2: functools.partial does not call
def t2_partial_does_not_call():
    try:
        p = functools.partial(plain_raises)
    except BoomError:
        print("t2 handler ran")
        return "t2-handled"
    return ("t2-not-handled", p)


# T3: map is lazy
def t3_map_is_lazy():
    try:
        m = map(lambda x: plain_raises(), [1])
    except BoomError:
        print("t3 handler ran")
        return "t3-handled"
    return ("t3-not-handled", m)


# T4: generator expression is lazy
def t4_genexp_is_lazy():
    try:
        g = (plain_raises() for _ in [1])
    except BoomError:
        print("t4 handler ran")
        return "t4-handled"
    return ("t4-not-handled", g)


# T5: a nested def in the try body
def t5_nested_def_does_not_run():
    try:
        def inner():
            raise BoomError("inner")
    except BoomError:
        print("t5 handler ran")
        return "t5-handled"
    return ("t5-not-handled", inner)


# T6: a lambda in the try body
def t6_lambda_does_not_run():
    try:
        f = lambda: plain_raises()
    except BoomError:
        print("t6 handler ran")
        return "t6-handled"
    return ("t6-not-handled", f)


# T7: the suppress inside the try swallows it first
def t7_suppress_inside_try():
    try:
        with contextlib.suppress(BoomError):
            plain_raises()
    except BoomError:
        print("t7 handler ran")
        return "t7-handled"
    return "t7-not-handled"


# T8: except Exception does not take SystemExit
def t8_sysexit_not_caught_by_exception():
    try:
        sys.exit(3)
    except Exception:
        print("t8 handler ran")
        return "t8-handled"
    return "t8-not-handled"


# T9: asyncio.CancelledError is a BaseException
def t9_cancelled_not_caught_by_exception():
    try:
        raise asyncio.CancelledError()
    except Exception:
        print("t9 handler ran")
        return "t9-handled"


# T10: a second handler shadowed by the first
def t10_shadowed_second_handler():
    try:
        plain_raises()
    except Exception:
        print("t10 first ran")
        return "t10-first"
    except BoomError:
        print("t10 second ran")
        return "t10-second"


# T11: raises only under a guard that is always false at run time through a constant
DEBUG = False


def only_when_debug():
    if DEBUG:
        raise BoomError("debug only")
    return 1


def t11_guarded_raise():
    try:
        only_when_debug()
    except BoomError:
        print("t11 handler ran")
        return "t11-handled"
    return "t11-not-handled"


# T12: the callee catches its own on every path
def catches_itself():
    try:
        raise BoomError("mine")
    except BoomError:
        return 1


def t12_callee_catches_itself():
    try:
        catches_itself()
    except BoomError:
        print("t12 handler ran")
        return "t12-handled"
    return "t12-not-handled"


# T13: asyncio.create_task inside try: the exception goes to the task, not here
async def async_raises():
    raise BoomError("async")


async def t13_create_task_in_try():
    try:
        t = asyncio.create_task(async_raises())
    except BoomError:
        print("t13 handler ran")
        return "t13-handled"
    try:
        await t
    except BoomError:
        pass
    return "t13-not-handled"


# T14: coroutine created but not awaited inside try, awaited after
async def t14_coroutine_awaited_after_try():
    try:
        c = async_raises()
    except BoomError:
        print("t14 handler ran")
        return "t14-handled"
    try:
        await c
    except BoomError:
        return "t14-not-handled"


# T15: StopIteration raised inside a generator becomes RuntimeError (PEP 479)
def gen_stop():
    raise StopIteration
    yield 1


def t15_pep479():
    try:
        next(gen_stop())
    except StopIteration:
        print("t15 handler ran")
        return "t15-handled"
    except RuntimeError:
        return "t15-became-runtime-error"


# T16: a class with the same name as the exception, local shadow
def t16_local_class_shadow():
    class BoomError(Exception):      # noqa
        pass
    try:
        plain_raises()
    except BoomError:
        print("t16 handler ran")
        return "t16-handled"
    return "t16-not"


if __name__ == '__main__':
    fns = [t1_generator_call_never_raises, t2_partial_does_not_call, t3_map_is_lazy, t4_genexp_is_lazy, t5_nested_def_does_not_run, t6_lambda_does_not_run, t7_suppress_inside_try, t8_sysexit_not_caught_by_exception, t9_cancelled_not_caught_by_exception, t10_shadowed_second_handler, t11_guarded_raise, t12_callee_catches_itself, t15_pep479, t16_local_class_shadow]
    for f in fns:
        try:
            print(f.__name__, '->', f())
        except BaseException as e:
            print(f.__name__, 'ESCAPED', type(e).__name__)
    print('t13', asyncio.run(t13_create_task_in_try()))
    print('t14', asyncio.run(t14_coroutine_awaited_after_try()))
