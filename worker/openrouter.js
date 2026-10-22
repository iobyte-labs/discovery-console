// Calling a model, cheaply and without assuming it will answer.
//
// The budget here is "free", which is a constraint rather than a discount. Free models on
// OpenRouter appear and disappear without notice — the predecessor project learned this by
// having a pinned model stop existing mid-campaign — so the list is discovered at runtime
// and tried in order. A hard-coded model is a time bomb with a long fuse.
//
// Nothing here is allowed to take the site down with it. Every failure mode (no key, no
// model, rate limited, malformed reply) raises a ModelUnavailable that the caller turns
// into "try again shortly", because a seeker uploading a CV should never see a stack trace
// about somebody else's rate limit.

const API = "https://openrouter.ai/api/v1";

/** One request's ceiling. A seeker is watching a spinner; this cannot run for minutes. */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_MODELS_TRIED = 4;

/** Preferred free models, tried first when still offered. Order is deliberate: larger first. */
const PREFERRED = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
];

/** Models that are free but unsuited to structured extraction. */
const SKIP = [/vision/i, /\bvl\b/i, /image/i, /audio/i, /coder/i, /\bguard\b/i];

export class ModelUnavailable extends Error {}

/**
 * Builds a caller for pkg profile extraction.
 *
 * Returns null when there is no key. A nil caller is a usable state, not an error: the
 * route checks for it and tells the seeker the feature is off, rather than failing.
 */
export function modelCaller(env, { fetchImpl = fetch } = {}) {
  const key = env?.OPENROUTER_API_KEY;
  if (!key) return null;

  let cachedModels = null;

  return async function call({ system, user }) {
    const models = cachedModels || (cachedModels = await freeModels(key, env, fetchImpl));
    if (!models.length) {
      throw new ModelUnavailable("no free model is currently offered");
    }

    const failures = [];
    for (const model of models.slice(0, MAX_MODELS_TRIED)) {
      try {
        return await complete(model, { system, user }, key, env, fetchImpl);
      } catch (error) {
        // A model that is rate limited or has vanished is not a reason to stop; it is a
        // reason to try the next one. Only the message is kept — never the key, never the
        // CV text, both of which pass through here.
        failures.push(`${model}: ${error.message}`);
        if (error instanceof ModelGone) {
          cachedModels = models.filter((m) => m !== model);
        }
      }
    }
    throw new ModelUnavailable(`every model refused (${failures.join("; ")})`);
  };
}

class ModelGone extends Error {}

async function complete(model, { system, user }, key, env, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter asks for these; they identify the caller rather than a person.
        "HTTP-Referer": env?.PUBLIC_ORIGIN || "https://github.com/iobyte-labs",
        "X-Title": "eucd cv intake",
      },
      body: JSON.stringify({
        model,
        // Zero, so the same CV extracts the same way twice. A seeker who re-uploads and
        // gets a different profile has no way to tell which one was wrong.
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 400) {
      throw new ModelGone(`not available (${response.status})`);
    }
    if (response.status === 429) {
      throw new Error("rate limited");
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("empty reply");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks OpenRouter which free models exist right now.
 *
 * Falls back to the preferred list when the catalogue cannot be read, so a failure to
 * discover is not a failure to run.
 */
async function freeModels(key, env, fetchImpl) {
  let offered = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetchImpl(`${API}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const body = await response.json();
      offered = (body?.data || [])
        .map((entry) => entry?.id)
        .filter((id) => typeof id === "string" && id.endsWith(":free"))
        .filter((id) => !SKIP.some((pattern) => pattern.test(id)));
    }
  } catch {
    // Discovery is an optimisation. The preferred list below is the floor.
  }

  const preferredStillOffered = PREFERRED.filter((id) => offered.includes(id));
  const rest = offered.filter((id) => !PREFERRED.includes(id));
  const ordered = [...preferredStillOffered, ...rest];
  return ordered.length ? ordered : PREFERRED;
}
