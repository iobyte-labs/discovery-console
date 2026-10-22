// Writing a seeker's files into the private repository.
//
// The token used here can write to a private repository, so this module is deliberately
// narrow: it writes under one seeker's directory and nowhere else, and the path is built
// from an id that has already been validated as one this system issued. A path assembled
// from anything a caller supplies is how a write to `seekers/alice/../../.github/workflows`
// happens.

const API = "https://api.github.com";

export class GitHubError extends Error {}

/**
 * The directory one seeker owns. Every path this module touches is built through here.
 *
 * `isSeekerId` has already refused anything that is not `s_` plus sixteen hex characters,
 * so there is no traversal to strip — but the single chokepoint is what makes that
 * guarantee checkable rather than spread across call sites.
 */
export function seekerPath(seekerId, filename) {
  if (!/^s_[0-9a-f]{16}$/.test(seekerId)) {
    throw new GitHubError(`refusing to build a path from ${JSON.stringify(seekerId)}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(filename) || filename.includes("..")) {
    throw new GitHubError(`refusing to build a path from ${JSON.stringify(filename)}`);
  }
  return `seekers/${seekerId}/${filename}`;
}

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "eucd-cv-intake",
    "Content-Type": "application/json",
  };
}

/** Reads a file's blob sha, or "" when it does not exist yet. */
async function currentSha(env, path, fetchImpl) {
  const url = `${API}/repos/${env.DATA_REPO}/contents/${encodeURI(path)}`;
  const response = await fetchImpl(url, { headers: headers(env) });
  if (response.status === 404) return "";
  if (!response.ok) {
    throw new GitHubError(`could not read ${path}: HTTP ${response.status}`);
  }
  const body = await response.json();
  return body?.sha || "";
}

/**
 * Writes one file, creating or replacing it.
 *
 * The commit message names the seeker by id, never by email: a commit message is permanent
 * and world-readable to anyone with repository access, and an address in one is an address
 * that cannot be deleted later.
 */
export async function putFile(env, { path, content, message, fetchImpl = fetch }) {
  const sha = await currentSha(env, path, fetchImpl);
  const body = {
    message,
    content: toBase64(content),
    branch: env.DATA_BRANCH || "main",
  };
  if (sha) body.sha = sha;

  const response = await fetchImpl(`${API}/repos/${env.DATA_REPO}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: headers(env),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new GitHubError(`could not write ${path}: HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  const result = await response.json();
  return result?.commit?.sha || "";
}

/**
 * Deletes one file.
 *
 * Used for erasure. Note what this does NOT do: the file leaves the branch but stays in
 * history, which is exactly why the CV is encrypted and why erasure destroys the key. See
 * docs/cv-intake.md.
 */
export async function deleteFile(env, { path, message, fetchImpl = fetch }) {
  const sha = await currentSha(env, path, fetchImpl);
  if (!sha) return false;
  const response = await fetchImpl(`${API}/repos/${env.DATA_REPO}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: headers(env),
    body: JSON.stringify({ message, sha, branch: env.DATA_BRANCH || "main" }),
  });
  if (!response.ok) {
    throw new GitHubError(`could not delete ${path}: HTTP ${response.status}`);
  }
  return true;
}

function toBase64(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
