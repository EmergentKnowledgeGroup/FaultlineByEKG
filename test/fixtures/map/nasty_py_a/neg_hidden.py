"""Hidden callers. Every target below IS called at run time, in ways the reader might not see. The bottom prints which ran."""
import operator
import sys
RAN = []


class Holder:
    def via_methodcaller(self):
        RAN.append('via_methodcaller')
        raise ValueError('methodcaller')

    def via_attrgetter(self):
        RAN.append('via_attrgetter')
        raise ValueError('attrgetter')

    def via_dunder_dict(self):
        RAN.append('via_dunder_dict')
        raise ValueError('dunder dict')

    def via_vars(self):
        RAN.append('via_vars')
        raise ValueError('vars')

    def via_getattribute(self):
        RAN.append('via_getattribute')
        raise ValueError('getattribute')


def module_vars_target():
    RAN.append('module_vars_target')
    raise ValueError('vars(module)')


def sys_modules_target():
    RAN.append('sys_modules_target')
    raise ValueError('sys.modules')


def dunder_dict_target():
    RAN.append('dunder_dict_target')
    raise ValueError('__dict__')


def run_all():
    h = Holder()
    results = []
    calls = [
        lambda: operator.methodcaller('via_methodcaller')(h),
        lambda: operator.attrgetter('via_attrgetter')(h)(),
        lambda: Holder.__dict__['via_dunder_dict'](h),
        lambda: vars(Holder)['via_vars'](h),
        lambda: object.__getattribute__(h, 'via_getattribute')(),
        lambda: vars(sys.modules[__name__])['module_vars_target'](),
        lambda: sys.modules[__name__].sys_modules_target(),
        lambda: sys.modules[__name__].__dict__['dunder_dict_target'](),
    ]
    for c in calls:
        try:
            c()
        except ValueError as e:
            results.append(str(e))
    print(RAN)
    print(results)


if __name__ == '__main__':
    run_all()
