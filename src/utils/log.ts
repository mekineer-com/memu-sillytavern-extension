let _lastStatus = '';
const _once = new Set<string>();

function fmt(msg: string): string {
  const m = String(msg ?? '').trim();
  return m.startsWith('memu-ext:') ? m : `memu-ext: ${m}`;
}

export function status(total: number, processed: number): void {
  const s = `memu-ext: ${total} messages, ${processed} processed`;
  if (s === _lastStatus) return;
  _lastStatus = s;
  console.log(s);
}

export function info(msg: string): void {
  console.log(fmt(msg));
}

export function warn(msg: string): void {
  console.warn(fmt(msg));
}

export function error(msg: string, e?: any): void {
  const extra = e ? (e?.message ?? String(e)) : '';
  console.error(extra ? `${fmt(msg)} (${extra})` : fmt(msg));
}

export function onceInfo(key: string, msg: string): void {
  if (_once.has(key)) return;
  _once.add(key);
  info(msg);
}

export function onceWarn(key: string, msg: string): void {
  if (_once.has(key)) return;
  _once.add(key);
  warn(msg);
}

export function onceError(key: string, msg: string, e?: any): void {
  if (_once.has(key)) return;
  _once.add(key);
  error(msg, e);
}
