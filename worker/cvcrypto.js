// Encrypting a CV so that it can be committed, and later destroyed.
//
// The problem this solves is not confidentiality in transit. It is that git history is
// effectively permanent: a committed file survives in every clone, every fork and every
// cached object, so "delete this person's CV" cannot be honoured by removing a file.
//
// Each seeker gets a random key, held outside the repository. Destroying that one key makes
// every copy of their ciphertext unreadable at once, including copies nobody controls. That
// is what makes keeping a CV in git defensible — see docs/cv-intake.md.
//
// A note on what this is NOT: the key is random, never derived from the seeker's email or
// any other identifier. An email address appears in the sent log, in the repository and in
// every application that goes out, so a key derived from one would be derivable by exactly
// the people the encryption exists to stop.

/** The envelope format. Bump when the layout changes in a way a reader must notice. */
export const CV_ENVELOPE_VERSION = "eucd.cv/1";

const ALGORITHM = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12; // 96 bits, the size AES-GCM is specified for

/**
 * Generates a fresh key for one seeker, as raw base64.
 *
 * Stored in the Worker's KV and nowhere else. Not in the repository, not in the browser,
 * not in a commit, not in a log.
 */
export async function generateKey() {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_BITS },
    true, // extractable, because it has to be stored
    ["encrypt", "decrypt"],
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(raw));
}

/**
 * Encrypts a CV.
 *
 * Returns a self-describing envelope so that a reader in another language — the send path
 * is Python — knows the algorithm and the IV without being told out of band. The envelope
 * is JSON rather than a binary format for the same reason: it survives being committed,
 * diffed and copied without anyone needing a tool to look at it.
 *
 * `filename` and `contentType` travel with the ciphertext because an application that
 * attaches the CV later needs them, and recovering them from the bytes is guesswork.
 */
export async function encryptCV(plaintext, keyBase64, { filename, contentType } = {}) {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, data);

  return {
    version: CV_ENVELOPE_VERSION,
    algorithm: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    filename: filename || "CV.pdf",
    content_type: contentType || "application/pdf",
    encrypted_at: new Date().toISOString(),
  };
}

/**
 * Decrypts an envelope.
 *
 * Throws when the key is wrong, when the ciphertext has been altered, or when the envelope
 * is a version this code does not understand. AES-GCM authenticates, so a tampered
 * ciphertext fails rather than returning plausible rubbish — which matters when the file
 * will be attached to an email somebody sends in their own name.
 */
export async function decryptCV(envelope, keyBase64) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("not a CV envelope");
  }
  if (envelope.version !== CV_ENVELOPE_VERSION) {
    throw new Error(
      `CV envelope is ${envelope.version || "unversioned"}, this reads ${CV_ENVELOPE_VERSION}`,
    );
  }
  const key = await importKey(keyBase64);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  // A failure here is "wrong key or tampered data" and is not distinguished on purpose:
  // telling an attacker which of the two it was is free information.
  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

async function importKey(keyBase64) {
  const raw = base64ToBytes(keyBase64);
  if (raw.length !== KEY_BITS / 8) {
    throw new Error(`key is ${raw.length} bytes, expected ${KEY_BITS / 8}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// Base64 without Node or browser helpers, so this runs unchanged in a Worker, in Node and
// in a test runner.
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
