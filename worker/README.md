# worker

The component that holds credentials, because nothing else can.

`discovery-console` is served by GitHub Pages, which serves static files and runs nothing.
A credential the page uses is a credential the page ships, readable by anyone who opens the
site. So the console holds none, and this holds them all: the GitHub token that writes into
the org, the OpenRouter key that extracts a profile from a CV, and the per-seeker keys that
encrypt CVs.

Accepting that this is a server is the honest part of the design. It is a small one — one
function, free tier — but it is a server, and the alternative was asking a non-technical job
seeker to create a GitHub account, a fine-grained token and an OpenRouter key before
anything worked.

See [`../docs/cv-intake.md`](../docs/cv-intake.md) for the whole flow and for the two
designs that were tried first and rejected.

## What is here now

`cvcrypto.js` and `cvcrypto.py` — the CV envelope, written by the Worker and read by the
send path. Two languages because the Worker runs where the credentials live and sending runs
on the operator's own machine, so the envelope is the contract between them: JSON, base64,
AES-256-GCM, a version string.

The cross-language test is the one that matters. If the two readers ever disagree, a CV
cannot be attached to the email it was kept for, and nothing else would notice.

```bash
node --test worker/            # 10 tests
pytest worker/test_cvcrypto.py # 8 tests, including the interop contract
```

## The key rule

A seeker's key is **random**, generated once, stored in KV, and never derived from anything.

An earlier proposal derived it from the seeker's email address. That protects nothing: the
address is in the sent log, in the repository and in every application that goes out, so
anyone who can read the ciphertext can also derive the key. A salt is public by design and
is not key material.

Destroying a key is how a CV is deleted. Git history is effectively permanent — a committed
file survives in every clone and every fork — so removing the file is a promise that cannot
be kept. Destroying the key makes every copy unreadable at once, including the copies nobody
controls.

## The routes

| | |
|---|---|
| `POST /api/intake` | First upload. Mints a seeker, extracts a profile, encrypts the CV, writes three files, returns the profile and a one-time token. |
| `PUT /api/profile` | Saves a profile the seeker edited. Rebuilt from a whitelist, never trusted as sent. |
| `DELETE /api/seeker` | Erasure. Destroys the key first, then removes the files. |
| `GET /api/health` | Says `{"ok":true}` and deliberately nothing about whether keys are configured. |

## What it refuses

Everything here is reachable by anyone who finds the URL, and behind it sit a token that
writes to a private repository and a key with a quota. So most of the Worker is refusals:

- **One origin, no wildcard.** Any page that may call this from a browser is a page that may
  spend the quota and write to the repository.
- **Consent before a model call.** Extraction sends the CV to a model. Without
  `consent: true` nothing is sent, and the test asserts the model was not reached.
- **Five uploads an hour per address**, because an upload costs a model call from a shared
  free tier.
- **256 KB bodies**, checked before anything is parsed.
- **A seeker speaks only for themselves.** Presenting a valid token against somebody else's
  id is a 401, not a read.
- **No internals in a response.** A failure is logged and the browser gets a sentence; the
  test checks that a repository name and a token cannot appear in an error.

## Where wrangler lives

Wrangler is Cloudflare's command-line tool for Workers — it creates the key store, holds
the secrets and ships the code. It is **dev-time only**: the deployed Worker never uses it,
and nothing in `index.js` imports it.

It is a pinned devDependency here rather than a global install, because a global one drifts
between machines and a deploy tool that changes version underneath you is how a deploy
starts behaving differently on a Tuesday. The lockfile is committed for the same reason.

```bash
nvm use              # reads .nvmrc at the repository root
cd worker
npm install          # wrangler, pinned, into worker/node_modules (gitignored)
npm test             # 71 tests
npm run check        # validates wrangler.toml and bundles, without deploying
```

**Node 22 or newer is required** — current wrangler refuses anything older, and Node 20
reached end of life in April 2026, so it is not receiving security patches either way.
`.nvmrc` pins it and `engine-strict=true` in `.npmrc` makes npm refuse rather than warn,
because a wrong Node otherwise surfaces much later as a confusing wrangler error.

`node_modules` here is around 220 MB. It is a deploy-time tool, not a dependency of the
site, and nothing in it reaches the browser or the Worker.

## Deploying

```bash
cd worker
npx wrangler login                         # once, opens a browser
npx wrangler kv namespace create SEEKERS   # put the printed id into wrangler.toml
npx wrangler secret put GITHUB_TOKEN       # fine-grained, Contents:write, one repo, with an expiry
npx wrangler secret put OPENROUTER_API_KEY
npm run deploy
```

Then put the Worker's URL into `hugo.toml` as `params.worker`, so the intake page knows
where to post and the page's content policy names that host. Until it is set, the page says
uploads are not configured rather than failing at the first attempt.

Deployment is manual on purpose. Doing it from CI would mean a Cloudflare API token living
as a GitHub secret — a third credential, to save a command that runs rarely.

`wrangler.toml` is committed and holds nothing secret. The KV namespace is the only place a
CV key exists, so choose its **backup** retention deliberately: too little and a lost key is
an unreadable CV with no recovery, too much and a destroyed key lives on in a backup, which
defeats erasure.
