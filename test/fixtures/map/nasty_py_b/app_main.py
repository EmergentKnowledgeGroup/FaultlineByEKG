"""A script, so 'nothing above it catches it' can be proven by the tool. Every raise below IS caught at run time, or the claim is otherwise false. Bottom prints the truth."""
import json
import os
import socket
import urllib.error

ERRS = (ValueError, KeyError)


class ProjectBase(json.JSONDecodeError):
    pass


class WrappedLib(urllib.error.URLError):
    pass


# N1: handler type is a tuple held in a variable
def n1_raises_tuple_var():
    raise ValueError("n1")


def n1_caller():
    try:
        n1_raises_tuple_var()
    except ERRS:
        return "n1-caught"


# N2: urllib URLError is an OSError
def n2_raises_urlerror():
    raise urllib.error.URLError("n2")


def n2_caller():
    try:
        n2_raises_urlerror()
    except OSError:
        return "n2-caught"


# N3: json.JSONDecodeError is a ValueError
def n3_raises_jsonerror():
    raise json.JSONDecodeError("n3", "doc", 0)


def n3_caller():
    try:
        n3_raises_jsonerror()
    except ValueError:
        return "n3-caught"


# N4: a project class on an outside base, caught by `except Exception`
def n4_raises_project_on_lib():
    raise ProjectBase("n4", "doc", 0)


def n4_caller():
    try:
        n4_raises_project_on_lib()
    except Exception:
        return "n4-caught"


# N5: same, a subclass of URLError, caught by OSError
def n5_raises_wrapped():
    raise WrappedLib("n5")


def n5_caller():
    try:
        n5_raises_wrapped()
    except OSError:
        return "n5-caught"


# N6: except clause computed by a call
def handled_types():
    return (ZeroDivisionError,)


def n6_raises():
    raise ZeroDivisionError("n6")


def n6_caller():
    try:
        n6_raises()
    except handled_types():
        return "n6-caught"


# N7: socket.error is an alias of OSError
def n7_raises():
    raise OSError("n7")


def n7_caller():
    try:
        n7_raises()
    except socket.error:
        return "n7-caught"


# N8: os.error alias, raising through a name
def n8_raises():
    raise FileNotFoundError("n8")


def n8_caller():
    try:
        n8_raises()
    except os.error:
        return "n8-caught"


# N9: class-level alias
class Errs:
    Bad = KeyError


def n9_raises():
    raise KeyError("n9")


def n9_caller():
    try:
        n9_raises()
    except Errs.Bad:
        return "n9-caught"


# N10: the caller's finally exits, so the error never reaches module level
def n10_raises():
    raise RuntimeError("n10")


def n10_caller():
    try:
        n10_raises()
    finally:
        return "n10-finally-return-ate-it"


# N11: walrus / assignment rebinds builtin name
ValueErrorAlias = Exception


def n11_raises():
    raise RuntimeError("n11")


def n11_caller():
    try:
        n11_raises()
    except ValueErrorAlias:
        return "n11-caught"


if __name__ == '__main__':
    print('n1', n1_caller())
    print('n2', n2_caller())
    print('n3', n3_caller())
    print('n4', n4_caller())
    print('n5', n5_caller())
    print('n6', n6_caller())
    print('n7', n7_caller())
    print('n8', n8_caller())
    print('n9', n9_caller())
    print('n10', n10_caller())
    print('n11', n11_caller())
