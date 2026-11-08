"""Ticket sales for a ferry kiosk (invented example used by the story tests)."""
import time

from kiosk import ledger, printer


class SaleRefused(Exception):
    pass


FARES = {"harbour": 4, "island": 9}


def lookup_fare(route, rider_class):
    base = FARES.get(route)
    if base is None:
        return None
    if rider_class == "child":
        return base // 2
    return base


def take_payment(request, amount):
    if request.card is None:
        return None
    return gateway_charge(request.card, apply_discount(request, amount))


def gateway_charge(card, amount):
    import subprocess
    done = subprocess.run(["cardtool", "--charge", card, str(amount)])
    return done.returncode == 0


def sell_ticket(request):
    fare = lookup_fare(request.route, request.rider_class)
    if fare is None:
        raise SaleRefused("no such route")
    if request.seats_left <= 0:
        return refuse_full(request)
    amount = fare * request.count
    paid = take_payment(request, amount)
    if not paid:
        return None
    ledger.append_entry(request.id, amount)
    try:
        printer.print_ticket(request)
    except RuntimeError:
        print("could not print the ticket", request.id)
        ledger.append_entry(request.id, -amount)
        return None
    return amount


def refuse_full(request):
    ledger.append_entry(request.id, 0)
    return None


def wait_for_paper(tray):
    while tray.empty():
        time.sleep(2)
    return tray.level()


def apply_discount(request, amount):
    if request.coupon:
        amount = redeem_coupon(request.coupon, amount)
    else:
        amount = note_full_price(amount)
    return amount


def redeem_coupon(coupon, amount):
    ledger.append_entry(coupon.id, -coupon.value)
    return amount - coupon.value


def note_full_price(amount):
    print("full price", amount)
    return amount


def pick_lane(request):
    if request.priority:
        return fast_lane(request)
    return slow_lane(request)


def fast_lane(request):
    return request.id + "-fast"


def slow_lane(request):
    return request.id + "-slow"
