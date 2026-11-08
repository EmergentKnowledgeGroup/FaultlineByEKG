export class Orders {
  constructor(private opts: { autoCharge?: boolean } = { autoCharge: false }) {}

  /** Place one order for a customer. */
  placeOrder(id: string) {
    if (!id) {
      throw new Error('missing id');
    }
    this.validate(id);
    try {
      return this.withRetry(() => this.charge(id));
    } catch (err) {
      console.error(err);
      this.notify(err);
    }
  }

  validate(id: string) {
    if (id.length > 40) {
      throw new Error('id too long');
    }
    return true;
  }

  withRetry(fn: () => unknown) {
    return fn();
  }

  charge(id: string) {
    if (this.opts.autoCharge) {
      this.db.save(`order:${id}`, 'paid', '1');
    }
    return { ok: true };
  }

  notify(err: unknown) {
    this.queue.push(err);
  }
}

export function handler(req: { url: string }) {
  if (req.url === '/api/orders') {
    return new Orders().placeOrder('7');
  }
  return { status: 404 };
}

export function lonely() {
  return 1;
}
