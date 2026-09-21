// Lightweight host-session token: an HMAC over an expiry timestamp, signed with the
// server-only HOST_PASSWORD secret. Never send the password itself to the client --
// only this derived token, which the client stores and replays.
//
// Ported from Node's `node:crypto` (createHmac/timingSafeEqual) to the Web Crypto API
// (`crypto.subtle`), which is what's natively available in the Workers runtime. This
// also means the secret is no longer read from `process.env` -- Workers pass bindings
// and secrets through the request-scoped `env` object, so the secret is now an explicit
// argument instead of a module-level lookup.

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(sig);
}

// Manual constant-time string compare -- Web Crypto has no direct equivalent of
// Node's `timingSafeEqual`, but both signatures are fixed-length base64url so a
// simple XOR-accumulate over every character gives the same constant-time property.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function createHostToken(secret: string): Promise<string> {
  const payload = String(Date.now() + TOKEN_TTL_MS);
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

export async function verifyHostToken(token: string | null | undefined, secret: string): Promise<boolean> {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = await sign(payload, secret);
  if (!timingSafeEqual(expected, sig)) return false;
  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  return true;
}

export async function requireHost(req: Request, secret: string): Promise<boolean> {
  const token = req.headers.get("x-host-token");
  return verifyHostToken(token, secret);
}
