export function resolveDrmKeys(payload: { drmKeyId?: string; contentKey?: string }) {
  const keyId = payload.drmKeyId;
  const contentKey = payload.contentKey;

  if (!keyId || !contentKey) {
    throw new Error('DRM keys missing in transcode job payload. Backend must provide drmKeyId and contentKey.');
  }

  return {
    keyIdHex: normalizeKeyIdToHex(keyId),
    contentKeyHex: normalizeContentKeyToHex(contentKey),
  };
}

function normalizeKeyIdToHex(value: string) {
  const normalized = value.trim();
  const uuid = normalized.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(uuid)) return uuid;

  return base64To16ByteHex(normalized, 'DRM key id');
}

function normalizeContentKeyToHex(value: string) {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(normalized)) return normalized;

  return base64To16ByteHex(value.trim(), 'DRM content key');
}

function base64To16ByteHex(value: string, label: string) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 16) {
    throw new Error(`${label} must be UUID, 32-char hex, or base64 encoding of exactly 16 bytes`);
  }

  return bytes.toString('hex');
}
