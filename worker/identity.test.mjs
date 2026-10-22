import assert from "node:assert/strict";
import test from "node:test";

import { authenticate, bearerFrom, isSeekerId, mintSeeker, verifyToken } from "./identity.js";

/** A KV stub: the same get/put surface the Worker runtime provides. */
function kvWith(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    _map: map,
  };
}

function requestWith(token, id) {
  const headers = new Headers();
  if (token) headers.set("authorization", "Bearer " + token);
  if (id) headers.set("x-seeker-id", id);
  return new Request("https://example.org/api/profile", { headers });
}

test("a minted seeker has an id, a token, and only the hash is keepable", async () => {
  const { id, token, tokenHash } = await mintSeeker();
  assert.match(id, /^s_[0-9a-f]{16}$/);
  assert.equal(token.length, 64, "32 bytes of hex");
  assert.notEqual(token, tokenHash);
  assert.ok(!tokenHash.includes(token), "the hash must not contain the token");
});

test("two seekers never collide", async () => {
  const a = await mintSeeker();
  const b = await mintSeeker();
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.token, b.token);
});

test("a token verifies against its own hash and nothing else", async () => {
  const a = await mintSeeker();
  const b = await mintSeeker();
  assert.ok(await verifyToken(a.token, a.tokenHash));
  assert.ok(!(await verifyToken(b.token, a.tokenHash)));
  assert.ok(!(await verifyToken("", a.tokenHash)));
  assert.ok(!(await verifyToken(a.token, "")));
});

test("a bearer token is read only from the Authorization header", () => {
  assert.equal(bearerFrom(requestWith("abc")), "abc");
  // A token in a query string would reach browser history and proxy logs.
  const query = new Request("https://example.org/api/profile?token=abc");
  assert.equal(bearerFrom(query), "");
  const basic = new Request("https://example.org/", {
    headers: { authorization: "Basic abc" },
  });
  assert.equal(bearerFrom(basic), "");
});

test("authenticate accepts the right seeker", async () => {
  const seeker = await mintSeeker();
  const kv = kvWith({
    [`seeker:${seeker.id}`]: JSON.stringify({ tokenHash: seeker.tokenHash, email: "a@b.fr" }),
  });
  const who = await authenticate(requestWith(seeker.token, seeker.id), kv);
  assert.equal(who.id, seeker.id);
  assert.equal(who.email, "a@b.fr");
});

// The attack this exists to stop: typing somebody else's identifier.
test("one seeker cannot read another's data", async () => {
  const alice = await mintSeeker();
  const bob = await mintSeeker();
  const kv = kvWith({
    [`seeker:${alice.id}`]: JSON.stringify({ tokenHash: alice.tokenHash }),
    [`seeker:${bob.id}`]: JSON.stringify({ tokenHash: bob.tokenHash }),
  });
  // Bob presents his own token against Alice's id.
  assert.equal(await authenticate(requestWith(bob.token, alice.id), kv), null);
});

test("no token, unknown seeker and wrong token are all just null", async () => {
  const seeker = await mintSeeker();
  const kv = kvWith({ [`seeker:${seeker.id}`]: JSON.stringify({ tokenHash: seeker.tokenHash }) });
  assert.equal(await authenticate(requestWith("", seeker.id), kv), null);
  assert.equal(await authenticate(requestWith(seeker.token, "s_0000000000000000"), kv), null);
  assert.equal(await authenticate(requestWith("wrong", seeker.id), kv), null);
});

// A seeker id reaches a KV key and a repository path, so a crafted one must not address
// another seeker's data or climb out of its directory.
test("a crafted seeker id is refused", () => {
  for (const bad of [
    "../../etc/passwd",
    "s_../../other",
    "s_0000000000000000/../x",
    "s_SHORT",
    "s_0000000000000000extra",
    "",
    "seeker:admin",
  ]) {
    assert.ok(!isSeekerId(bad), `${bad} should be refused`);
  }
  assert.ok(isSeekerId("s_0123456789abcdef"));
});

test("a corrupted KV record does not authenticate", async () => {
  const seeker = await mintSeeker();
  const kv = kvWith({ [`seeker:${seeker.id}`]: "not json" });
  assert.equal(await authenticate(requestWith(seeker.token, seeker.id), kv), null);
});
