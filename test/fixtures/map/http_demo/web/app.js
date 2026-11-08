export async function loadItems() {
  const r = await fetch('/api/items');
  return r.json();
}

export async function ping() {
  const r = await fetch('/api/health');
  return r.ok;
}

export async function nowhere() {
  return fetch('/api/missing');
}

export function things() {
  return fetch('/v1/things');
}
