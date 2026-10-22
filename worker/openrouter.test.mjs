import assert from "node:assert/strict";
import test from "node:test";

import { ModelUnavailable, modelCaller } from "./openrouter.js";

const KEY = { OPENROUTER_API_KEY: "test-key-never-real" };

function respond(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reply(content) {
  return { choices: [{ message: { content } }] };
}

function catalogue(ids) {
  return { data: ids.map((id) => ({ id })) };
}

test("no key means no caller, which is a usable state", () => {
  assert.equal(modelCaller({}), null);
  assert.equal(modelCaller({ OPENROUTER_API_KEY: "" }), null);
});

test("it asks a free model and returns the content", async () => {
  const seen = [];
  const call = modelCaller(KEY, {
    fetchImpl: async (url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/models")) return respond(200, catalogue(["google/gemma-4-31b-it:free"]));
      return respond(200, reply('{"ok":true}'));
    },
  });
  assert.equal(await call({ system: "s", user: "u" }), '{"ok":true}');
  assert.equal(seen[1].body.model, "google/gemma-4-31b-it:free");
  assert.equal(seen[1].body.temperature, 0, "a re-upload must extract the same way");
});

// The predecessor had a pinned model stop existing mid-campaign.
test("a model that has vanished is skipped and not tried again", async () => {
  let calls = 0;
  const call = modelCaller(KEY, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) {
        return respond(200, catalogue([
          "google/gemma-4-31b-it:free",
          "meta-llama/llama-3.3-70b-instruct:free",
        ]));
      }
      calls++;
      const model = JSON.parse(init.body).model;
      if (model === "google/gemma-4-31b-it:free") return respond(404, { error: "gone" });
      return respond(200, reply("second model answered"));
    },
  });
  assert.equal(await call({ system: "s", user: "u" }), "second model answered");
  const before = calls;
  await call({ system: "s", user: "u" });
  assert.equal(calls, before + 1, "the dead model should not be retried on the next call");
});

test("a rate-limited model falls through to the next", async () => {
  const call = modelCaller(KEY, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) {
        return respond(200, catalogue([
          "google/gemma-4-31b-it:free",
          "qwen/qwen-2.5-72b-instruct:free",
        ]));
      }
      if (JSON.parse(init.body).model.startsWith("google/")) return respond(429, {});
      return respond(200, reply("ok"));
    },
  });
  assert.equal(await call({ system: "s", user: "u" }), "ok");
});

test("when every model refuses, the error names them without leaking the key", async () => {
  const call = modelCaller(KEY, {
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) return respond(200, catalogue(["google/gemma-4-31b-it:free"]));
      return respond(500, {});
    },
  });
  await assert.rejects(
    () => call({ system: "s", user: "u" }),
    (error) => {
      assert.ok(error instanceof ModelUnavailable);
      assert.ok(!error.message.includes("test-key-never-real"), "the key must never surface");
      assert.match(error.message, /gemma/);
      return true;
    },
  );
});

test("a catalogue that cannot be read falls back to the preferred list", async () => {
  const call = modelCaller(KEY, {
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) throw new Error("network down");
      return respond(200, reply("answered anyway"));
    },
  });
  assert.equal(await call({ system: "s", user: "u" }), "answered anyway");
});

test("vision and coder models are not used for extraction", async () => {
  const tried = [];
  const call = modelCaller(KEY, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) {
        return respond(200, catalogue([
          "someone/llava-vision:free",
          "someone/qwen-coder:free",
          "someone/plain-text-model:free",
        ]));
      }
      tried.push(JSON.parse(init.body).model);
      return respond(200, reply("ok"));
    },
  });
  await call({ system: "s", user: "u" });
  assert.deepEqual(tried, ["someone/plain-text-model:free"]);
});

test("an empty reply is a failure, not an empty profile", async () => {
  const call = modelCaller(KEY, {
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) return respond(200, catalogue(["a/b:free"]));
      return respond(200, reply("   "));
    },
  });
  await assert.rejects(() => call({ system: "s", user: "u" }), ModelUnavailable);
});

test("only free models are ever asked", async () => {
  const tried = [];
  const call = modelCaller(KEY, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) {
        return respond(200, catalogue(["expensive/gpt-9", "cheap/model:free"]));
      }
      tried.push(JSON.parse(init.body).model);
      return respond(200, reply("ok"));
    },
  });
  await call({ system: "s", user: "u" });
  assert.ok(tried.every((m) => m.endsWith(":free")), `paid model asked: ${tried}`);
});
