def handle(request):
    user = lookup(request)
    if not user:
        raise PermissionError("no user")
    if request.kind == "refund":
        refund(request)
        return "refunded"
    elif request.kind == "close":
        close(request)
        return "closed"
    audit(request)
    return "ok"


def lookup(request):
    if request.id is None:
        return None
    return find(request.id)


def find(ident):
    for item in TABLE:
        if item.id == ident:
            return item
    return None


def refund(request):
    ledger.write(request.amount)
    notify(request)


def close(request):
    ledger.close(request.id)


def audit(request):
    if request.kind == "audit":
        log.record(request)


def notify(request):
    if request.quiet:
        return False
    mailer.send(request.email)
    return True


def route(path):
    if path == "/refund":
        return handle_refund()
    if path == "/close":
        return handle_close()
    return "not found"


def handle_refund():
    refund(REQUEST)
    return "refund done"


def handle_close():
    close(REQUEST)
    return "close done"
