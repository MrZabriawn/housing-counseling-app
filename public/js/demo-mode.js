const _map = new Map();
let _counter = 0;

export function isDemoMode() {
  return sessionStorage.getItem('demoMode') === '1';
}

export function demoClientName(clientId) {
  if (!clientId) return 'Client —';
  if (!_map.has(clientId)) {
    _counter++;
    _map.set(clientId, `Client ${String(_counter).padStart(3, '0')}`);
  }
  return _map.get(clientId);
}
