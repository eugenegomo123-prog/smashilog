// Player-account tokens. Deliberately separate from auth.ts's host token: same
// HMAC-over-Web-Crypto approach, but signed with its own secret, so a player
// token can never be mistaken for -- or used to derive -- host access.

const PLAYER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- players stay logged in
const REGISTRATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Player login token: proves "this browser is logged in as account #N".
export async function createPlayerToken(accountId: number, secret: string): Promise<string> {
  const payload = `${accountId}.${Date.now() + PLAYER_TOKEN_TTL_MS}`;
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

export async function verifyPlayerToken(token: string | null | undefined, secret: string): Promise<number | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [accountIdStr, expiryStr, sig] = parts;
  const expected = await sign(`${accountIdStr}.${expiryStr}`, secret);
  if (!timingSafeEqual(expected, sig)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  const accountId = Number(accountIdStr);
  return Number.isFinite(accountId) ? accountId : null;
}

export async function requirePlayer(req: Request, secret: string): Promise<number | null> {
  return verifyPlayerToken(req.headers.get("x-player-token"), secret);
}

// Registration token: proves whoever is signing up scanned a real host's QR code.
// Stateless, like the host token -- "regenerate" issues a fresh one, but (same
// limitation as host login today) a previously-issued, still-unexpired token
// keeps working until it naturally expires.
export async function createRegistrationToken(secret: string): Promise<string> {
  const payload = String(Date.now() + REGISTRATION_TOKEN_TTL_MS);
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

export async function verifyRegistrationToken(token: string | null | undefined, secret: string): Promise<boolean> {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = await sign(payload, secret);
  if (!timingSafeEqual(expected, sig)) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && expiry >= Date.now();
}
