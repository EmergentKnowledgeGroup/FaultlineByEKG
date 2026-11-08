class Box:
    def arm(self):
        self.ready = True


def only_tests_call_this(path):
    with open(path, 'w') as f:
        f.write('x')
    return path + '.done'


def nobody_names_this(path):
    with open(path, 'w') as f:
        f.write('y')
    return path + '.done'
