import assert from "node:assert/strict";
import test from "node:test";

import worker, { __testing } from "./index.js";
import { decryptCV } from "./cvcrypto.js";

const ORIGIN = "https://iobyte-labs.github.io";

const CV = `CURRICULUM VITAE
Quality Assurance Specialist, Acme Pharma GmbH, Munich, 2019-2024.
Pharmacovigilance case processing, aggregate reporting, two GMP audits led.
Reduced deviation closure time by 40 percent across the site.
`.repeat(4);

const MODEL_REPLY = JSON.stringify({
  headline: "Pharmacovigilance and QA roles",
  sectors: ["pharma"],
  languages: ["de", "en"],
  skills: [{ term: "pharmacovigilance", weight: 9, aliases: ["PV"] }],
  facts: [{ id: "qa-acme", text: "Ran pharmacovigilance at Acme Pharma GmbH.", tags: ["pv"] }],
});

/** An in-memory KV with the surface the Worker uses. */
function kv() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    _map: map,
  };
}

/** Records every GitHub write so a test can inspect what was committed. */
function makeEnv(overrides = {}) {
  const writes = [];
  const store = kv();
  const env = {
    SEEKERS: store,
    GITHUB_TOKEN: "ghp_never_real",
    OPENROUTER_API_KEY: "or_never_real",
    DATA_REPO: "iobyte-labs/personal-outreach",
    ALLOWED_ORIGINS: ORIGIN,
    DEFAULT_COUNTRIES: "de",
    AVAILABLE_SECTORS: "pharma,automotive",
    _writes: writes,
    ...overrides,
  };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("openrouter.ai/api/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "a/b:free" }] }), { status: 200 });
    }
    if (target.includes("openrouter.ai")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: MODEL_REPLY } }] }),
        { status: 200 },
      );
    }
    if (target.includes("api.github.com")) {
      if (!init?.method || init.method === "GET") return new Response("", { status: 404 });
      writes.push({ url: target, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ commit: { sha: "abc" } }), { status: 201 });
    }
    throw new Error("unexpected fetch to " + target);
  };
  return env;
}

function post(path, body, headers = {}) {
  return new Request("https://worker.example.workers.dev" + path, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ctx = { waitUntil: (p) => p };

async function intake(env, overrides = {}) {
  const response = await worker.fetch(
    post("/api/intake", { cv_text: CV, email: "seeker@example.org", consent: true, ...overrides }),
    env,
    ctx,
  );
  return { response, body: await response.json() };
}

test("a CV upload returns a profile and a one-time token", async () => {
  const env = makeEnv();
  const { response, body } = await intake(env);
  assert.equal(response.status, 201);
  assert.match(body.seeker_id, /^s_[0-9a-f]{16}$/);
  assert.equal(body.token.length, 64);
  assert.equal(body.token_is_shown_once, true);
  assert.equal(body.profile.skills[0].term, "pharmacovigilance");
  assert.equal(body.facts.length, 1);
});

// The one thing that must be explicit, because extraction sends the CV to a model.
test("without consent nothing is sent to a model", async () => {
  const env = makeEnv();
  let modelCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("openrouter.ai")) modelCalled = true;
    return realFetch(url, init);
  };
  const { response } = await intake(env, { consent: false });
  assert.equal(response.status, 400);
  assert.equal(modelCalled, false);
  assert.equal(env._writes.length, 0);
});

test("three files are written, and the CV is written encrypted", async () => {
  const env = makeEnv();
  const { body } = await intake(env);

  const paths = env._writes.map((w) => decodeURI(w.url.split("/contents/")[1]));
  assert.deepEqual(paths.sort(), [
    `seekers/${body.seeker_id}/config/profile.md`,
    `seekers/${body.seeker_id}/config/profiles/cv.json`,
    `seekers/${body.seeker_id}/private/cv.json`,
  ]);

  const cvWrite = env._writes.find((w) => w.url.includes("private/cv.json"));
  const envelope = JSON.parse(atob(cvWrite.body.content));
  assert.equal(envelope.version, "eucd.cv/1");
  assert.ok(!JSON.stringify(envelope).includes("Acme Pharma"), "the CV was committed in the clear");

  // And it is readable with the key that was kept out of the repository.
  const record = JSON.parse(await env.SEEKERS.get(`seeker:${body.seeker_id}`));
  const plain = new TextDecoder().decode(await decryptCV(envelope, record.cvKey));
  assert.match(plain, /Acme Pharma/);
});

test("the key and the token never reach the repository", async () => {
  const env = makeEnv();
  const { body } = await intake(env);
  const committed = env._writes.map((w) => atob(w.body.content)).join("\n");
  const record = JSON.parse(await env.SEEKERS.get(`seeker:${body.seeker_id}`));
  assert.ok(!committed.includes(record.cvKey), "the CV key was committed");
  assert.ok(!committed.includes(body.token), "the seeker's token was committed");
  const messages = env._writes.map((w) => w.body.message).join(" ");
  assert.ok(!messages.includes("@"), "an address reached a commit message");
});

test("only the hash of the token is stored", async () => {
  const env = makeEnv();
  const { body } = await intake(env);
  const stored = await env.SEEKERS.get(`seeker:${body.seeker_id}`);
  assert.ok(!stored.includes(body.token), "the raw token was stored");
});

test("a profile can be edited, but only by its own seeker", async () => {
  const env = makeEnv();
  const { body } = await intake(env);
  const edited = { ...body.profile, headline: "Edited by me", skills: body.profile.skills };

  const ok = await worker.fetch(
    new Request("https://w.example.dev/api/profile", {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        authorization: "Bearer " + body.token,
        "x-seeker-id": body.seeker_id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ profile: edited }),
    }),
    env,
    ctx,
  );
  assert.equal(ok.status, 200);

  const second = await intake(makeEnvSharing(env));
  const stolen = await worker.fetch(
    new Request("https://w.example.dev/api/profile", {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        authorization: "Bearer " + second.body.token,
        "x-seeker-id": body.seeker_id, // somebody else's id
        "content-type": "application/json",
      },
      body: JSON.stringify({ profile: edited }),
    }),
    env,
    ctx,
  );
  assert.equal(stolen.status, 401);
});

function makeEnvSharing(env) {
  return env; // the same KV, so two seekers coexist
}

test("erasure destroys the key, which is what deletes the CV", async () => {
  const env = makeEnv();
  const { body } = await intake(env);
  const record = JSON.parse(await env.SEEKERS.get(`seeker:${body.seeker_id}`));
  const envelope = JSON.parse(
    atob(env._writes.find((w) => w.url.includes("private/cv.json")).body.content),
  );

  const response = await worker.fetch(
    new Request("https://w.example.dev/api/seeker", {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        authorization: "Bearer " + body.token,
        "x-seeker-id": body.seeker_id,
      },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(await env.SEEKERS.get(`seeker:${body.seeker_id}`), null);

  // The committed ciphertext still exists in history; without the key it is noise.
  const anyOtherKey = await freshKey();
  await assert.rejects(() => decryptCV(envelope, anyOtherKey));
  // And the original key is gone from the only place it was kept.
  assert.ok(record.cvKey, "the key existed before erasure");
});

async function freshKey() {
  const { generateKey } = await import("./cvcrypto.js");
  return generateKey();
}

test("a page on another origin cannot call this", async () => {
  const env = makeEnv();
  const response = await worker.fetch(
    post("/api/intake", { cv_text: CV, email: "a@b.fr", consent: true }, { origin: "https://evil.example.org" }),
    env,
    ctx,
  );
  // The request may be processed, but the browser is never told it may read the answer.
  assert.equal(response.headers.get("access-control-allow-origin"), null);

  const preflight = await worker.fetch(
    new Request("https://w.example.dev/api/intake", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.org" },
    }),
    env,
    ctx,
  );
  assert.equal(preflight.status, 403);
});

test("the allowed origin gets CORS headers", async () => {
  const env = makeEnv();
  const preflight = await worker.fetch(
    new Request("https://w.example.dev/api/intake", {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    }),
    env,
    ctx,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(preflight.headers.get("vary"), "Origin");
});

test("uploads are rate limited per address", async () => {
  const env = makeEnv();
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  let last;
  for (let i = 0; i < 7; i++) {
    last = await worker.fetch(
      post("/api/intake", { cv_text: CV, email: "a@b.fr", consent: true }, headers),
      env,
      ctx,
    );
  }
  assert.equal(last.status, 429, "a single address should not spend the whole quota");
});

test("a bad email is refused before a model is called", async () => {
  const env = makeEnv();
  for (const email of ["", "not-an-email", "a@b", "@example.org"]) {
    const { response } = await intake(env, { email });
    assert.equal(response.status, 400, `${email} was accepted`);
  }
  assert.equal(env._writes.length, 0);
});

test("an oversized body is refused", async () => {
  const env = makeEnv();
  const { response } = await intake(env, { cv_text: "x".repeat(300 * 1024) });
  assert.equal(response.status, 413);
});

test("no model key means a clear message, not a crash", async () => {
  const env = makeEnv({ OPENROUTER_API_KEY: "" });
  const { response, body } = await intake(env);
  assert.equal(response.status, 503);
  assert.match(body.error, /not available/i);
});

test("an internal failure does not leak internals to the browser", async () => {
  const env = makeEnv();
  globalThis.fetch = async () => {
    throw new Error("repo iobyte-labs/personal-outreach token ghp_secret failed");
  };
  const { body } = await intake(env);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("ghp_secret"));
  assert.ok(!text.includes("personal-outreach"));
});

test("health says nothing about configuration", async () => {
  const env = makeEnv();
  const response = await worker.fetch(
    new Request("https://w.example.dev/api/health", { headers: { origin: ORIGIN } }),
    env,
    ctx,
  );
  const body = await response.json();
  assert.deepEqual(body, { ok: true });
});

test("an unknown endpoint is a plain 404", async () => {
  const env = makeEnv();
  const response = await worker.fetch(
    new Request("https://w.example.dev/api/admin", { headers: { origin: ORIGIN } }),
    env,
    ctx,
  );
  assert.equal(response.status, 404);
});

test("email normalisation", () => {
  const { normaliseEmail } = __testing;
  assert.equal(normaliseEmail("  A@B.FR "), "a@b.fr");
  assert.equal(normaliseEmail("a@b"), "");
  assert.equal(normaliseEmail("x".repeat(300) + "@b.fr"), "");
});
