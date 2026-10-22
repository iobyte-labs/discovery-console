// Telling one seeker from another, without accounts.
//
// A seeker has no GitHub account and no password. Identity therefore cannot be their email
// address: an address is a claim, not a proof, and anyone who typed somebody else's would
// read and overwrite their CV. What a seeker holds instead is a capability — a random token
// issued on first upload and kept in their browser.
//
// The honest limit: lose the browser storage and you lose access. There is no password
// reset, because there is no password and no verified address to send one to. The token is
// shown once as a recovery code for exactly this reason. Adding real recovery means
// verifying an email address, which means sending mail, which is a dependency this does not
// have yet. See docs/cv-intake.md.

/** How long a token is, in bytes, before encoding. 32 bytes is not guessable. */
const TOKEN_BYTES = 32;

/**
 * Mints a new seeker.
 *
 * Returns the id (safe to log and to use as a path segment) and the token (never logged,
 * never stored in the clear). Only the token's hash is kept, so a leak of the key store
 * does not hand over anybody's account — the same reason a password database stores hashes.
 */
export async function mintSeeker() {
  const id = "s_" + hex(crypto.getRandomValues(new Uint8Array(8)));
  const token = hex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  return { id, token, tokenHash: await sha256Hex(token) };
}

/**
 * Checks a presented token against the stored hash.
 *
 * Compares in constant time. A fast reject leaks, byte by byte, how much of a guess was
 * right, and a token is guessable one byte at a time if you let it be.
 */
export async function verifyToken(token, storedHash) {
  if (typeof token !== "string" || typeof storedHash !== "string") return false;
  if (token.length === 0 || storedHash.length === 0) return false;
  return timingSafeEqual(await sha256Hex(token), storedHash);
}

/**
 * Reads the bearer token from a request, or "" when there is none.
 *
 * Deliberately only the Authorization header: a token in a query string ends up in browser
 * history, in proxy logs and in Referer headers on every outbound link.
 */
export function bearerFrom(request) {
  const header = request.headers.get("authorization") || "";
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return "";
  return value.trim();
}

/**
 * Loads the seeker a request claims to be, or null.
 *
 * Returns null for "no token", "unknown seeker" and "wrong token" alike. Distinguishing
 * them would tell a prober which seeker ids exist.
 */
export async function authenticate(request, kv) {
  const token = bearerFrom(request);
  if (!token) return null;
  const id = request.headers.get("x-seeker-id") || "";
  if (!isSeekerId(id)) return null;

  const raw = await kv.get(`seeker:${id}`);
  if (!raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!(await verifyToken(token, record.tokenHash))) return null;
  return { id, ...record };
}

/**
 * Whether a string is a seeker id this code issued.
 *
 * Checked before the id reaches a KV key or a repository path, so that a crafted value
 * cannot address another seeker's data or escape the directory it belongs in.
 */
export function isSeekerId(value) {
  return typeof value === "string" && /^s_[0-9a-f]{16}$/.test(value);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
