export function runCommand(name: string, ...args: unknown[]): string {
  return `${name}:${args.length}`;
}

export function trace(label: string): string {
  return label;
}

export function issue(): string {
  trace('mint');
  return runCommand('mint', 1);
}

export function seal(): string {
  return runCommand('stamp', 2);
}

export function cancel(): string {
  return runCommand('void', 3);
}

export function inspect(): string {
  return runCommand('audit', 4);
}
