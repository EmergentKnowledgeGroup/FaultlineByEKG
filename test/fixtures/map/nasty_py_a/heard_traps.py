"""Who hears? Traps for confident 'nobody hears it' and confident 'heard'."""
import sys
import logging
import concurrent.futures as cf
LAST_ERROR = None


class AError(Exception):
    pass


# H1: a write to a module-level variable from inside a handler: the name is assigned, not an attribute or an item.
def h1_global_write(x):
    global LAST_ERROR
    try:
        if x:
            raise AError("h1")
    except AError as e:
        LAST_ERROR = e


# H2: nonlocal write
def h2_nonlocal_write(x):
    seen = None

    def inner():
        nonlocal seen
        try:
            if x:
                raise AError("h2")
        except AError as e:
            seen = e
    inner()
    return seen


# H3: mutation through an alias passed in
def h3_param_alias_add(x, errs):
    try:
        if x:
            raise AError("h3")
    except AError as e:
        out = errs
        out += [e]


# H4: del of something shared
SHARED = {'k': 1}


def h4_del_global_item(x):
    try:
        if x:
            raise AError("h4")
    except AError:
        del SHARED['k']


# H5: stderr through sys.stderr.write
def h5_stderr(x):
    try:
        if x:
            raise AError("h5")
    except AError as e:
        sys.stderr.write(str(e))


# H6: a yield inside the handler: generator tells its consumer
def h6_yield_in_handler(x):
    try:
        if x:
            raise AError("h6")
    except AError as e:
        yield e


# H7: return value ignored by every caller: "heard by the caller" while nobody hears
def h7_returns_flag(x):
    try:
        if x:
            raise AError("h7")
    except AError:
        return False
    return True


def h7_caller_ignores():
    h7_returns_flag(1)
    h7_returns_flag(0)


# H8: finally raises a different error
def h8_finally_raises(x):
    try:
        try:
            if x:
                raise AError("h8")
        except AError:
            pass
        finally:
            raise KeyError("finally always raises")
    except KeyError:
        print("h8 outer heard the KeyError")


# H9: print to a sink nobody reads, reported as telling a person
def h9_print_to_devnull(x):
    import os
    try:
        if x:
            raise AError("h9")
    except AError as e:
        with open(os.devnull, 'w') as sink:
            print(e, file=sink)


# H10: logging disabled: logger.debug is "heard"
logging.disable(logging.CRITICAL)
log = logging.getLogger('x')


def h10_log_disabled(x):
    try:
        if x:
            raise AError("h10")
    except AError as e:
        log.debug(e)


# H11: a handler that tells someone only on a dead branch
def h11_callee(x):
    if x:
        raise AError("h11")


def h11_top():
    try:
        h11_callee(1)
    except AError as e:
        if False:
            print(e)


# H12: an os.environ item write after the handler
def h12_env_after(x):
    import os
    try:
        if x:
            raise AError("h12")
    except AError:
        pass
    os.environ['SEEN'] = '1'


# H13: exception handed to a future
def h13_future(x, fut: cf.Future):
    try:
        if x:
            raise AError("h13")
    except AError as e:
        fut.set_exception(e)


# H14: a local alias of a global list
GLOBAL_LOG = []


def h14_local_alias_of_global(x):
    sink = GLOBAL_LOG
    try:
        if x:
            raise AError("h14")
    except AError as e:
        sink += [e]


# H15: setattr
class Rec:
    last = None


def h15_setattr(x):
    try:
        if x:
            raise AError("h15")
    except AError as e:
        setattr(Rec, 'last', e)


if __name__ == '__main__':
    h7_caller_ignores()
    h11_top()
