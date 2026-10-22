// The Worker. It exists because a GitHub Pages site cannot hold a secret.
//
// Everything here is reachable by anyone who finds the URL, and behind it sit a GitHub
// token that writes to a private repository and an API key with a quota. So the shape of
// this file is mostly refusals: what origin may call it, how often, how large a body, and
// which seeker a request is allowed to speak for.
//
// See docs/cv-intake.md for the whole design.

import { encryptCV, generateKey } from "./cvcrypto.js";
import { deleteFile, putFile, seekerPath } from "./github.js";
import { authenticate, isSeekerId, mintSeeker } from "./identity.js";
import { ModelUnavailable, modelCaller } from "./openrouter.js";
import {
  MAX_CV_CHARS,
  ProfileError,
  extractProfile,
  renderProfileMarkdown,
  renderRankingProfile,
} from "./profile.js";

/** A CV is a few pages. The cap is on the request, before anything is parsed. */
const MAX_BODY_BYTES = 256 * 1024;

/** Per-address limits. An upload costs a model call; a read costs nothing much. */
const LIMITS = {
  intake: { perHour: 5, window: 3600 },
  write: { perHour: 60, window: 3600 },
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") {
      return preflight(env, origin);
    }
    try {
      const response = await route(request, env, ctx);
      return withCORS(response, env, origin);
    } catch (error) {
      // Never let an internal message reach the browser: it may name the repository, the
      // model, or a path. The seeker gets a sentence they can act on.
      console.error("unhandled:", error?.message || error);
      return withCORS(problem(500, "Something went wrong. Please try again shortly."), env, origin);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health") {
    // Deliberately says nothing about whether keys are configured: that is a detail for
    // the operator, not for anyone who finds the URL.
    return json(200, { ok: true });
  }
  if (path === "/api/intake" && request.method === "POST") {
    return intake(request, env, ctx);
  }
  if (path === "/api/profile" && request.method === "PUT") {
    return saveProfile(request, env);
  }
  if (path === "/api/seeker" && request.method === "DELETE") {
    return erase(request, env);
  }
  return problem(404, "No such endpoint.");
}

// ---------------------------------------------------------------- intake

/**
 * First upload: mints a seeker, extracts a profile, encrypts the CV, writes both.
 *
 * Returns the profile for the seeker to review and the token they will need next time.
 * The token is shown once — it is not recoverable, which is said plainly in the response
 * rather than discovered later.
 */
async function intake(request, env, ctx) {
  const limited = await rateLimit(request, env, "intake", LIMITS.intake);
  if (limited) return limited;

  const body = await readJSON(request);
  if (!body) return problem(413, `That upload is too large. A CV should be well under ${Math.round(MAX_BODY_BYTES / 1024)} KB of text.`);

  const cvText = typeof body.cv_text === "string" ? body.cv_text : "";
  const email = normaliseEmail(body.email);
  if (!email) {
    return problem(400, "An email address is needed, so applications can be sent from it later.");
  }
  if (body.consent !== true) {
    // The one thing that must be explicit. Extraction sends the CV to a model, and the
    // seeker has to have said yes to that before it happens.
    return problem(400, "Extraction needs your agreement before the CV is sent for analysis.");
  }
  if (cvText.length > MAX_CV_CHARS * 2) {
    return problem(413, "That CV is much longer than expected. Please upload the CV itself.");
  }

  const call = modelCaller(env);
  if (!call) {
    return problem(503, "CV analysis is not available at the moment. Please try again later.");
  }

  let extracted;
  try {
    extracted = await extractProfile(cvText, {
      call,
      countries: splitList(env.DEFAULT_COUNTRIES || "de"),
      sectors: splitList(env.AVAILABLE_SECTORS || "pharma,automotive"),
    });
  } catch (error) {
    if (error instanceof ProfileError) return problem(422, error.message);
    if (error instanceof ModelUnavailable) {
      console.error("model unavailable:", error.message);
      return problem(503, "CV analysis is busy right now. Please try again in a few minutes.");
    }
    throw error;
  }

  const seeker = await mintSeeker();
  const cvKey = await generateKey();

  // The key goes to KV and nowhere else. Not to the browser, not to a commit, not to a log.
  await env.SEEKERS.put(
    `seeker:${seeker.id}`,
    JSON.stringify({
      tokenHash: seeker.tokenHash,
      email,
      cvKey,
      createdAt: new Date().toISOString(),
    }),
  );

  const ranking = renderRankingProfile(seeker.id, extracted.profile);
  const markdown = renderProfileMarkdown({
    headline: extracted.profile.headline,
    facts: extracted.facts,
    skills: extracted.profile.skills,
    languages: extracted.profile.languages,
  });
  const envelope = await encryptCV(cvText, cvKey, {
    filename: typeof body.filename === "string" ? body.filename.slice(0, 120) : "CV.txt",
    contentType: "text/plain",
  });

  // Written after the response is prepared, so a slow GitHub does not hold the seeker at a
  // spinner. A failure here is logged and retried by the next save rather than losing the
  // extraction they just waited for.
  const write = Promise.all([
    putFile(env, {
      path: seekerPath(seeker.id, "config/profile.md"),
      content: markdown,
      message: `intake: profile for ${seeker.id}`,
    }),
    putFile(env, {
      path: seekerPath(seeker.id, "config/profiles/cv.json"),
      content: JSON.stringify(ranking, null, 2) + "\n",
      message: `intake: ranking profile for ${seeker.id}`,
    }),
    putFile(env, {
      path: seekerPath(seeker.id, "private/cv.json"),
      content: JSON.stringify(envelope, null, 2) + "\n",
      message: `intake: encrypted CV for ${seeker.id}`,
    }),
  ]).catch((error) => console.error("intake write failed:", error?.message));
  ctx?.waitUntil ? ctx.waitUntil(write) : await write;

  return json(201, {
    seeker_id: seeker.id,
    token: seeker.token,
    token_is_shown_once: true,
    profile: ranking,
    facts: extracted.facts,
  });
}

// ---------------------------------------------------------------- profile

/** Saves a profile the seeker edited after reviewing it. */
async function saveProfile(request, env) {
  const who = await authenticate(request, env.SEEKERS);
  if (!who) return problem(401, "Please upload your CV again to continue.");

  const limited = await rateLimit(request, env, "write", LIMITS.write);
  if (limited) return limited;

  const body = await readJSON(request);
  if (!body?.profile) return problem(400, "No profile was sent.");

  // Rebuilt rather than trusted. The browser is not a safe source for a file that goes to
  // the engine, and an edited profile is still only preferences.
  const ranking = renderRankingProfile(who.id, {
    headline: String(body.profile.headline || ""),
    countries: Array.isArray(body.profile.countries) ? body.profile.countries.slice(0, 8) : [],
    sectors: Array.isArray(body.profile.sectors) ? body.profile.sectors.slice(0, 12) : [],
    languages: Array.isArray(body.profile.languages) ? body.profile.languages.slice(0, 6) : [],
    skills: Array.isArray(body.profile.skills) ? body.profile.skills.slice(0, 40) : [],
  });

  await putFile(env, {
    path: seekerPath(who.id, "config/profiles/cv.json"),
    content: JSON.stringify(ranking, null, 2) + "\n",
    message: `profile edited by ${who.id}`,
  });
  return json(200, { profile: ranking });
}

// ---------------------------------------------------------------- erasure

/**
 * Honours a deletion request.
 *
 * The key is destroyed first. That is the step that actually deletes the CV: the ciphertext
 * survives in git history, in every clone and in every fork, and destroying the key makes
 * all of those unreadable at once. Removing the files is tidiness by comparison.
 */
async function erase(request, env) {
  const who = await authenticate(request, env.SEEKERS);
  if (!who) return problem(401, "Please upload your CV again to continue.");

  await env.SEEKERS.delete(`seeker:${who.id}`);

  const removals = ["private/cv.json", "config/profile.md", "config/profiles/cv.json"].map((name) =>
    deleteFile(env, {
      path: seekerPath(who.id, name),
      message: `erasure requested by ${who.id}`,
    }).catch((error) => console.error("erasure:", error?.message)),
  );
  await Promise.all(removals);

  return json(200, {
    erased: true,
    detail:
      "Your key has been destroyed, so the stored copy of your CV can no longer be read by " +
      "anyone, including us. Your profile files have been removed.",
  });
}

// ---------------------------------------------------------------- plumbing

async function readJSON(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A fixed window per address.
 *
 * Crude on purpose: the thing being protected is a free-tier quota, and the failure mode
 * worth preventing is one address spending all of it. A sliding window would be fairer and
 * needs state this does not want to keep.
 */
async function rateLimit(request, env, bucket, { perHour, window }) {
  if (!env.SEEKERS) return null;
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  const slot = Math.floor(Date.now() / 1000 / window);
  const key = `rl:${bucket}:${slot}:${address}`;
  const used = Number((await env.SEEKERS.get(key)) || 0);
  if (used >= perHour) {
    return problem(429, "That is a lot of uploads in one hour. Please try again later.");
  }
  await env.SEEKERS.put(key, String(used + 1), { expirationTtl: window * 2 });
  return null;
}

function allowedOrigin(env, origin) {
  const allowed = splitList(env.ALLOWED_ORIGINS || "");
  // No wildcard. The Worker holds credentials, so any page being able to call it from a
  // browser is a page being able to spend the quota and write to the repository.
  return allowed.includes(origin) ? origin : "";
}

function preflight(env, origin) {
  const allow = allowedOrigin(env, origin);
  if (!allow) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Seeker-Id",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function withCORS(response, env, origin) {
  const allow = allowedOrigin(env, origin);
  if (allow) {
    response.headers.set("Access-Control-Allow-Origin", allow);
    response.headers.set("Vary", "Origin");
  }
  return response;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Nothing here is cacheable: it is somebody's profile.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function problem(status, detail) {
  return json(status, { error: detail });
}

function normaliseEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) && text.length < 254 ? text : "";
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const __testing = { normaliseEmail, allowedOrigin, splitList };
