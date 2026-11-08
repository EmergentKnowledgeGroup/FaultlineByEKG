export class Bell {
  private listeners = new Map<string, Array<() => void>>();

  on(name: string, fn: () => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  emit(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
}

const bell = new Bell();

function chime(): void {
  console.log('ding');
}

export function arm(): void {
  bell.on('ring', () => {
    chime();
  });
}

export function press(): void {
  bell.emit('ring');
}
