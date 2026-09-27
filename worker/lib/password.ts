// Password hashing for player accounts. Uses PBKDF2 via the Web Crypto API's
// `crypto.subtle` -- the only password-hashing-adjacent primitive available in the
// Workers runtime (there's no bcrypt/argon2 here, and neither is pure-JS-portable to a
// Worker anyway). Each password gets its own random 16-byte salt, stored alongside the
// resulting hash; verifying re-derives with that same salt and compares in constant time.

const ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_LENGTH_BITS,
  );
  return toHex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, saltBytes);
  return { salt: toHex(saltBytes), hash };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const candidate = await derive(password, fromHex(salt));
  if (candidate.length !== hash.length) return false;
  let mismatch = 0;
  for (let i = 0; i < candidate.length; i++) mismatch |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return mismatch === 0;
}
