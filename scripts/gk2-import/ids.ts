// RFC 9562 UUIDv5: a uuid derived from a namespace uuid and a name, so a re-run of the import writes the same
// occurrence, head and collection ids and a repeated Push is a receipt replay, not a second copy.
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuidV5(namespace: string, name: string): string {
  if (!UUID.test(namespace)) throw new TypeError(`not a lowercase dashed uuid: ${JSON.stringify(namespace)}`);
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest();
  const b = Uint8Array.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
