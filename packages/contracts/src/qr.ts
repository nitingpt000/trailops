/**
 * Equipment QR label payload (spec §12): `trailops:v1:equipment:<uuid>[:<checksum>]`.
 * The label carries no personal data or authority; it only identifies an entity id. The optional
 * 2-character checksum catches typos when a label is entered by hand.
 */

const PREFIX = 'trailops:v1:equipment:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PAYLOAD = 96;

export function checksum(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1296;
  return h.toString(36).padStart(2, '0');
}

export function encodeEquipmentLabel(id: string, withChecksum = true): string {
  const lower = id.toLowerCase();
  if (!UUID.test(lower)) throw new Error('not an equipment uuid');
  return withChecksum ? `${PREFIX}${lower}:${checksum(lower)}` : `${PREFIX}${lower}`;
}

export type LabelParse =
  | { ok: true; id: string }
  | { ok: false; reason: 'TOO_LONG' | 'WRONG_PREFIX' | 'INVALID_ID' | 'BAD_CHECKSUM' };

export function parseEquipmentLabel(raw: string): LabelParse {
  if (raw.length > MAX_PAYLOAD) return { ok: false, reason: 'TOO_LONG' };
  const value = raw.trim();
  if (!value.startsWith(PREFIX)) return { ok: false, reason: 'WRONG_PREFIX' };
  const [id, sum, ...rest] = value.slice(PREFIX.length).split(':');
  if (rest.length || !UUID.test(id)) return { ok: false, reason: 'INVALID_ID' };
  if (sum !== undefined && sum !== checksum(id)) return { ok: false, reason: 'BAD_CHECKSUM' };
  return { ok: true, id };
}
