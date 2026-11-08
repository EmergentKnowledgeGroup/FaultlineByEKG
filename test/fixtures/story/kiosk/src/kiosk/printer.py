"""Ticket printing (invented example)."""
from kiosk import sales


def print_ticket(request):
    level = sales.wait_for_paper(request.tray)
    if level < 3:
        raise RuntimeError("paper is low")
    print("ticket", request.id)
    return True
