import { test } from 'node:test';
import assert from 'node:assert';
import { ipIsPrivate, safeLookupResult } from '../net';

test('ipIsPrivate blocks loopback/private/CGNAT/metadata and internal IPv6', () => {
  const block = [
    '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '::1', '::', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
  ];
  for (const ip of block) assert.equal(ipIsPrivate(ip), true, `should block ${ip}`);
});

test('ipIsPrivate allows public IPs (incl. boundary values)', () => {
  const allow = [
    '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1',
    '100.63.0.1', '100.128.0.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946',
  ];
  for (const ip of allow) assert.equal(ipIsPrivate(ip), false, `should not block ${ip}`);
});

test('safeLookupResult returns an ARRAY when Node requests all (autoSelectFamily); single otherwise', () => {
  const addrs = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  // The regression: under all:true the callback MUST get the array, not a bare string
  // (otherwise Node throws "Invalid IP address: undefined").
  assert.deepStrictEqual(safeLookupResult(addrs, true), addrs);
  assert.deepStrictEqual(safeLookupResult(addrs, false), { address: '8.8.8.8', family: 4 });
  assert.deepStrictEqual(safeLookupResult(addrs, undefined), { address: '8.8.8.8', family: 4 });
});

test('safeLookupResult refuses the host (null) if ANY address is private, or none resolve (strict SSRF)', () => {
  // Strict anti-rebinding: a public host that ALSO resolves to a private IP is refused whole.
  const mixed = [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
  assert.strictEqual(safeLookupResult(mixed, true), null);
  assert.strictEqual(safeLookupResult([{ address: '127.0.0.1', family: 4 }], false), null);
  assert.strictEqual(safeLookupResult([{ address: '169.254.169.254', family: 4 }], true), null);
  assert.strictEqual(safeLookupResult([], true), null);
});
