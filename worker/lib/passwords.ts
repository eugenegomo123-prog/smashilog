// Password hashing via PBKDF2, using the Web Crypto API that's already built into
// the Workers runtime -- no external library needed. Reasonable for a casual club
// app; not bank-grade, but nothing sensitive rides on it beyond a login.

const PBKDF2_ITERATIONS = 100_000;
const HASH_BITS = 256;

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    HASH_BITS,
  );
}

// Generates a fresh random salt and derives a hash from it -- call this once,
// at sign-up, and store both fields on the account.
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveKey(password, saltBytes);
  return { hash: toBase64(derived), salt: toBase64(saltBytes) };
}

// Re-derives using the account's stored salt and compares to the stored hash.
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const saltBytes = fromBase64(salt);
  const derived = await deriveKey(password, saltBytes);
  const derivedB64 = toBase64(derived);
  if (derivedB64.length !== hash.length) return false;
  let mismatch = 0;
  for (let i = 0; i < derivedB64.length; i++) mismatch |= derivedB64.charCodeAt(i) ^ hash.charCodeAt(i);
  return mismatch === 0;
}
