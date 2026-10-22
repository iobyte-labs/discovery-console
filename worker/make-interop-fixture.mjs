// Writes a CV envelope for the Python reader to consume.
//
// A dedicated script rather than a test filtered out of the suite: the Python side invoked
// `node --test --test-name-pattern=...`, which matched locally on one Node version and
// silently matched nothing on another. The test then passed with "0 failures" while the
// contract it exists to check was never exercised — the worst way for a cross-language test
// to fail, because it fails open.
//
//   node worker/make-interop-fixture.mjs <path>

import { writeFileSync } from "node:fs";

import { encryptCV, generateKey } from "./cvcrypto.js";

const TEXT = "CURRICULUM VITAE\nPharmacovigilance, QA/QC, GMP audits";

const path = process.argv[2];
if (!path) {
  console.error("usage: node make-interop-fixture.mjs <path>");
  process.exit(2);
}

const key = await generateKey();
const envelope = await encryptCV(TEXT, key, {
  filename: "CV.pdf",
  contentType: "application/pdf",
});
writeFileSync(path, JSON.stringify({ key, envelope, plaintext: TEXT }, null, 2));
