// Each method below IS called by the language itself. Each returns a value so an (entry) claim can be made.
export class Money {
  constructor(public cents: number) {}
  toString() {
    return `${this.cents / 100}`;
  }
  toJSON() {
    return { cents: this.cents };
  }
  valueOf() {
    return this.cents;
  }
  *[Symbol.iterator]() {
    yield this.cents;
  }
  then(ok: (v: number) => void) {
    ok(this.cents);
    return 1;
  }
}
const asString = String(new Money(5));
const asJson = JSON.stringify(new Money(5));
const asSum = +new Money(5) + 1;
const asList = [...new Money(5)];
async function viaAwait() {
  return await (new Money(5) as any);
}
export const results = [asString, asJson, asSum, asList, viaAwait];
