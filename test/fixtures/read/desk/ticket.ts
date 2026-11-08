export function dispatch(msg: Message) {
  if (!msg.ok) {
    return;
  }
  switch (msg.cmd) {
    case 'open':
      openTicket(msg);
      break;
    case 'close':
      closeTicket(msg);
      break;
    default:
      ignore(msg);
  }
  record(msg);
}

export function openTicket(msg: Message) {
  store.add(msg.id);
}

export function closeTicket(msg: Message) {
  store.remove(msg.id);
}

export function ignore(msg: Message) {
  if (msg.loud) throw new Error('unexpected message');
  trace(msg);
}

export function record(msg: Message) {
  history.push(msg);
}
