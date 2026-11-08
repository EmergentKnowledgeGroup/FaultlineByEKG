"""Entry and 'nothing names this function' traps. Each function DOES run at run time. Each returns a value or writes so it gets the confident claim, if it can."""
import operator
import sys
import pathlib
OUT = pathlib.Path('.')


class Holder:
    def m_methodcaller(self):
        (OUT / 'a').write_text('x')
        return 1

    def m_attrgetter(self):
        (OUT / 'b').write_text('x')
        return 2

    def m_dunder_dict(self):
        (OUT / 'c').write_text('x')
        return 3

    def m_vars(self):
        (OUT / 'd').write_text('x')
        return 4

    def m_getattribute(self):
        (OUT / 'e').write_text('x')
        return 5


def f_module_vars():
    (OUT / 'f').write_text('x')
    return 6


def f_sys_modules():
    (OUT / 'g').write_text('x')
    return 7


def f_dunder_dict():
    (OUT / 'h').write_text('x')
    return 8


def f_string_table():
    (OUT / 'i').write_text('x')
    return 9


def f_getattr_name_var():
    (OUT / 'j').write_text('x')
    return 10


def f_builtin_map_string():
    (OUT / 'k').write_text('x')
    return 11


TABLE = {'go': 'f_string_table'}


def run_all():
    h = Holder()
    r = []
    r.append(operator.methodcaller('m_methodcaller')(h))
    r.append(operator.attrgetter('m_attrgetter')(h)())
    r.append(Holder.__dict__['m_dunder_dict'](h))
    r.append(vars(Holder)['m_vars'](h))
    r.append(object.__getattribute__(h, 'm_getattribute')())
    me = sys.modules[__name__]
    r.append(vars(me)['f_module_vars']())
    r.append(me.f_sys_modules())
    r.append(me.__dict__['f_dunder_dict']())
    r.append(me.__dict__[TABLE['go']]())
    return r


if __name__ == '__main__':
    print(run_all())
