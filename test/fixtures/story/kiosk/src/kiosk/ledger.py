"""The sales ledger (invented example)."""

LEDGER_PATH = "ledger.txt"


def append_entry(sale_id, amount):
    with open(LEDGER_PATH, "a") as handle:
        handle.write(f"{sale_id} {amount}\n")
    return True
