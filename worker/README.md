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

## Not built yet

The Worker itself: the `/api/intake` route, the KV bindings, the OpenRouter call and the
GitHub write. Only the envelope and its two readers exist so far, which is deliberate — it
is the part that is hard to change later, because a CV encrypted under one format has to
stay readable.
