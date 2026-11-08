"""Handlers: what a handler does with the error, and who hears an ending."""


class CErr(Exception):
    pass


def risky(x):
    if x:
        raise CErr('c')
    return 0


def returns_default(x):
    try:
        return risky(x)
    except CErr:
        return ""


def returns_the_error(x):
    try:
        return risky(x)
    except CErr as e:
        return str(e)


def retries(x, n=0):
    try:
        return risky(x)
    except CErr:
        return retries(x, n + 1)


def reads_only(x):
    try:
        return risky(x)
    except CErr as e:
        msg = str(e)
        n = len(msg)


class Holder:
    def keeps_it(self, x):
        try:
            risky(x)
        except CErr as e:
            self.last = e


def translate_helper(e):
    raise CErr(str(e))


def hands_to_a_thrower(x):
    try:
        risky(x)
    except CErr as e:
        translate_helper(e)


def raise_for_default():
    raise CErr('default')


def caller_default():
    try:
        raise_for_default()
    except CErr:
        return ""


def raise_for_error():
    raise CErr('error')


def caller_error():
    try:
        raise_for_error()
    except CErr as e:
        return "failed: " + str(e)


def raise_then_redo(n=0):
    raise CErr('retry')


def again_caller(n=0):
    try:
        raise_then_redo()
    except CErr:
        return again_caller(n + 1)
