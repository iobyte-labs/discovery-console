// Tests for the CV envelope. Run with: node --test worker/
import assert from "node:assert/strict";
import test from "node:test";

import { CV_ENVELOPE_VERSION, decryptCV, encryptCV, generateKey } from "./cvcrypto.js";

const TEXT = "CURRICULUM VITAE\nPharmacovigilance, QA/QC, GMP audits";

test("a CV round-trips", async () => {
  const key = await generateKey();
  const envelope = await encryptCV(TEXT, key, { filename: "CV.pdf" });
  const out = new TextDecoder().decode(await decryptCV(envelope, key));
  assert.equal(out, TEXT);
});

test("the key is 256 bits and different every time", async () => {
  const a = await generateKey();
  const b = await generateKey();
  assert.equal(atob(a).length, 32);
  assert.notEqual(a, b, "two seekers must not share a key, or shredding one shreds both");
});

test("the same CV encrypts differently twice", async () => {
  // A fresh IV per encryption. Reusing one under the same key is the classic AES-GCM
  // failure, and it leaks whether two seekers uploaded the same file.
  const key = await generateKey();
  const first = await encryptCV(TEXT, key);
  const second = await encryptCV(TEXT, key);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("another seeker's key cannot read it", async () => {
  const envelope = await encryptCV(TEXT, await generateKey());
  const otherKey = await generateKey();
  await assert.rejects(() => decryptCV(envelope, otherKey));
});

// The property the whole design rests on: destroying a key makes every copy of the
// ciphertext unreadable, including copies in git history that nobody can remove.
test("without the key the ciphertext is unreadable", async () => {
  const key = await generateKey();
  const envelope = await encryptCV(TEXT, key);
  // The key is "destroyed": nothing but the envelope survives.
  const anyOtherKey = await generateKey();
  await assert.rejects(() => decryptCV(envelope, anyOtherKey));
  assert.ok(!JSON.stringify(envelope).includes("Pharmacovigilance"));
});

test("a tampered ciphertext is rejected, not silently accepted", async () => {
  const key = await generateKey();
  const envelope = await encryptCV(TEXT, key);
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
  await assert.rejects(() => decryptCV(tampered, key));
});

test("an envelope from a future version is refused", async () => {
  const key = await generateKey();
  const envelope = { ...(await encryptCV(TEXT, key)), version: "eucd.cv/99" };
  await assert.rejects(() => decryptCV(envelope, key), /eucd\.cv\/99/);
});

test("a key of the wrong length is refused", async () => {
  const envelope = await encryptCV(TEXT, await generateKey());
  await assert.rejects(() => decryptCV(envelope, btoa("too short")));
});

test("the envelope carries what an attachment needs", async () => {
  const key = await generateKey();
  const envelope = await encryptCV(TEXT, key, {
    filename: "Muktha_CV.pdf",
    contentType: "application/pdf",
  });
  assert.equal(envelope.version, CV_ENVELOPE_VERSION);
  assert.equal(envelope.filename, "Muktha_CV.pdf");
  assert.equal(envelope.content_type, "application/pdf");
  assert.ok(envelope.encrypted_at, "a retention policy needs to know when this was written");
});
