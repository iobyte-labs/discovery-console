import assert from "node:assert/strict";
import test from "node:test";

import { GitHubError, deleteFile, putFile, seekerPath } from "./github.js";

const ENV = {
  GITHUB_TOKEN: "ghp_never_real",
  DATA_REPO: "iobyte-labs/personal-outreach",
  DATA_BRANCH: "main",
};
const ID = "s_0123456789abcdef";

test("a seeker's path is under their own directory", () => {
  assert.equal(seekerPath(ID, "config/profile.md"), `seekers/${ID}/config/profile.md`);
});

// The token can write to a private repository, so a crafted path is the thing to stop.
test("a path cannot escape the seeker's directory", () => {
  for (const bad of ["../../.github/workflows/evil.yml", "a/../../b", "..", "./../x"]) {
    assert.throws(() => seekerPath(ID, bad), GitHubError, `${bad} was allowed`);
  }
  for (const bad of ["../other", "s_short", "", "s_0123456789abcdef/../x"]) {
    assert.throws(() => seekerPath(bad, "config/profile.md"), GitHubError, `${bad} was allowed`);
  }
});

test("a new file is created without a sha", async () => {
  const sent = [];
  await putFile(ENV, {
    path: seekerPath(ID, "config/profile.md"),
    content: "# Profile",
    message: "intake",
    fetchImpl: async (url, init) => {
      sent.push({ url, method: init?.method || "GET", body: init?.body });
      if (!init?.method || init.method === "GET") return new Response("", { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: "abc" } }), { status: 201 });
    },
  });
  const put = JSON.parse(sent[1].body);
  assert.equal(put.sha, undefined, "a create must not claim a sha");
  assert.equal(atob(put.content), "# Profile");
  assert.equal(put.branch, "main");
});

test("an existing file is replaced with its sha", async () => {
  const sent = [];
  await putFile(ENV, {
    path: seekerPath(ID, "config/profile.md"),
    content: "# Profile v2",
    message: "update",
    fetchImpl: async (url, init) => {
      sent.push(init?.method || "GET");
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ sha: "oldsha" }), { status: 200 });
      }
      const body = JSON.parse(init.body);
      assert.equal(body.sha, "oldsha", "a replace must carry the sha it is replacing");
      return new Response(JSON.stringify({ commit: { sha: "def" } }), { status: 200 });
    },
  });
  assert.deepEqual(sent, ["GET", "PUT"]);
});

// A commit message is permanent and cannot be deleted later.
test("the caller is responsible for keeping an address out of the message", async () => {
  let message = "";
  await putFile(ENV, {
    path: seekerPath(ID, "config/profile.md"),
    content: "x",
    message: `intake for ${ID}`,
    fetchImpl: async (url, init) => {
      if (!init?.method || init.method === "GET") return new Response("", { status: 404 });
      message = JSON.parse(init.body).message;
      return new Response(JSON.stringify({ commit: { sha: "abc" } }), { status: 201 });
    },
  });
  assert.ok(!message.includes("@"), "a commit message must not carry an address");
  assert.match(message, /s_0123456789abcdef/);
});

test("a write failure is reported rather than swallowed", async () => {
  await assert.rejects(
    () =>
      putFile(ENV, {
        path: seekerPath(ID, "config/profile.md"),
        content: "x",
        message: "m",
        fetchImpl: async (url, init) =>
          !init?.method || init.method === "GET"
            ? new Response("", { status: 404 })
            : new Response("no", { status: 403 }),
      }),
    GitHubError,
  );
});

test("deleting a file that is not there is not an error", async () => {
  const removed = await deleteFile(ENV, {
    path: seekerPath(ID, "private/cv.json"),
    message: "erasure",
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(removed, false);
});

test("deleting a file that exists sends its sha", async () => {
  let body = null;
  const removed = await deleteFile(ENV, {
    path: seekerPath(ID, "private/cv.json"),
    message: "erasure",
    fetchImpl: async (url, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ sha: "s1" }), { status: 200 });
      }
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
  assert.equal(removed, true);
  assert.equal(body.sha, "s1");
});
