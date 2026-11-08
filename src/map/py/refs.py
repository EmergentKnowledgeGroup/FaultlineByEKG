"""Where a name is mentioned, read straight from the syntax tree and independent of the control-flow graph.

The graph reader models function bodies. It does not model lambda bodies, default arguments, decorators, or the statements of a class body.
A function that is named only there looked like an entry ("nobody names it") or like dead code, and a call chain that ends there looked
closed. So the reader keeps two sets per project:

    names   every identifier read anywhere: a Name or Attribute in a load context, an imported name, a decorator, a default, a lambda, a class body
    hidden  the part of `names` that sits in code the graph does not model. A claim about absence ("nothing calls it", "nobody catches it")
            has an open end when the name is in `hidden`.

Both over-approximate on purpose: they are only ever used to refuse an absence claim, never to draw a road.
"""
import ast
import re


def py_names(tree):
    names, hidden = set(), set()

    def see(n, hid):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Load, ast.Del)):
            names.add(n.id)
            if hid:
                hidden.add(n.id)
        elif isinstance(n, ast.Attribute) and isinstance(n.ctx, (ast.Load, ast.Del)):
            names.add(n.attr)
            if hid:
                hidden.add(n.attr)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                if a.name != '*':
                    nm = a.name.split('.')[-1] if isinstance(n, ast.ImportFrom) else a.name.split('.')[0]
                    names.add(nm)

    def walk(n, hid):
        see(n, hid)
        if isinstance(n, ast.Lambda):
            for c in ast.iter_child_nodes(n):
                walk(c, True)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in n.decorator_list:
                walk(d, True)
            for d in list(n.args.defaults) + [x for x in n.args.kw_defaults if x is not None]:
                walk(d, True)
            for a in n.args.posonlyargs + n.args.args + n.args.kwonlyargs + [n.args.vararg, n.args.kwarg]:
                if a is not None and a.annotation is not None:
                    walk(a.annotation, hid)
            if n.returns is not None:
                walk(n.returns, hid)
            for s in n.body:                      # the body of a function is modelled by the graph reader
                walk(s, False)
        elif isinstance(n, ast.ClassDef):
            for d in n.decorator_list + n.bases + [k.value for k in n.keywords]:
                walk(d, True)
            for s in n.body:                      # the statements of a class body are not (methods are, one level down)
                walk(s, True)
        else:
            for c in ast.iter_child_nodes(n):
                walk(c, hid)
    for s in tree.body:
        walk(s, False)
    return names, hidden


IDENT = re.compile(r'[A-Za-z_]\w{0,60}')


def py_facts(tree):
    """Facts about how names are bound and reached, read from the syntax tree (the graph reader does not model them).
    -> (strings, rebound, patched, newcls)
        strings  identifier-like string literals anywhere: a function named as text (a lookup table, getattr, methodcaller) is reachable by that text
        rebound  names a module binds in some way other than its own `def` (an assignment, an import, a loop or `with` target)
        patched  (class name, attribute) pairs assigned outside the method itself: `Cls.attr = v`, `self.attr = v` in a method of Cls, an assignment in a class body
                 after the method, `setattr(Cls, "attr", v)`
        newcls   names of classes that define `__new__` (which may return something else, so `__init__` may never run)
    """
    strings, rebound, patched, newcls = set(), set(), set(), set()

    def bind_names(t, out):
        if isinstance(t, ast.Name):
            out.add(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                bind_names(e, out)
        elif isinstance(t, ast.Starred):
            bind_names(t.value, out)

    def targets_of(n):
        if isinstance(n, ast.Assign):
            return n.targets
        if isinstance(n, (ast.AugAssign, ast.AnnAssign)):
            return [n.target]
        return []

    def note_patch(t, cls):
        if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name):
            owner = cls if t.value.id in ('self', 'cls') and cls else t.value.id
            if owner:
                patched.add((owner, t.attr))
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                note_patch(e, cls)

    def walk(n, cls, scope):
        # scope: 'module' (statements outside any def or class body), 'class', 'def'
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and IDENT.fullmatch(n.value):
            strings.add(n.value)
        for t in targets_of(n):
            note_patch(t, cls)
            if scope == 'module':
                bind_names(t, rebound)
            elif scope == 'class' and cls and isinstance(t, ast.Name):
                patched.add((cls, t.id))
        if scope == 'module':
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                for a in n.names:
                    if a.name != '*':
                        rebound.add(a.asname or a.name.split('.')[0])
            elif isinstance(n, (ast.For, ast.AsyncFor)):
                bind_names(n.target, rebound)
            elif isinstance(n, (ast.With, ast.AsyncWith)):
                for it in n.items:
                    if it.optional_vars is not None:
                        bind_names(it.optional_vars, rebound)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'setattr' and len(n.args) >= 2 and isinstance(n.args[0], ast.Name) \
                and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str):
            patched.add((cls if n.args[0].id in ('self', 'cls') and cls else n.args[0].id, n.args[1].value))
        if isinstance(n, ast.ClassDef):
            if any(isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == '__new__' for s in n.body):
                newcls.add(n.name)
            for c in ast.iter_child_nodes(n):
                walk(c, n.name, 'class' if c in n.body else scope)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for c in ast.iter_child_nodes(n):
                walk(c, cls, 'def')
        else:
            for c in ast.iter_child_nodes(n):
                walk(c, cls, scope)
    for s in tree.body:
        walk(s, None, 'module')
    return strings, rebound, patched, newcls
