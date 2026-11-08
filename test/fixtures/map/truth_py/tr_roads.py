"""Roads: a call above every box of its function, calls that cannot return, a return out of nested finally blocks, a guard with one arm."""
import sys


class Failure(Exception):
    pass


def writer(path):
    with open(path, 'w') as f:
        f.write('x')


def second_sink(path):
    with open(path, 'w') as f:
        f.write('y')


def die(msg):
    raise Failure(msg)


def starts_with_a_call(x):
    if x:
        writer('a.txt')
    else:
        writer('b.txt')
    if x > 1:
        raise Failure('bad')
    return 1


def arm_then_die(x):
    if x:
        print('stopping')
        die('stop')
    second_sink('b.txt')


def arm_then_exit(x):
    if x:
        print('leaving')
        sys.exit(1)
    second_sink('c.txt')


def nested_finally(path):
    try:
        try:
            return writer(path)
        finally:
            print('inner')
    finally:
        print('outer')


def guard(x):
    if x:
        writer('g.txt')
    return 1
