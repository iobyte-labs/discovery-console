# CV intake: the design, and the two things it refuses to do

A job seeker opens a URL, uploads a CV, and gets a profile that ranks companies for them.
They have no GitHub account, no access token, no API key, and no reason to know what any of
those are.

This document records how that works, and — more usefully — the two designs that were tried
first and rejected, because both look reasonable until you check them.

## The flow

```
seeker's browser                 the Worker                      your org
────────────────                 ──────────                      ────────
opens the console
uploads CV.pdf
  │
  │  POST /api/intake  (CV text + email)
  ├────────────────────────────▶ holds every credential
  │                              │
  │                              ├─ OpenRouter: extract skills and facts
  │                              ├─ generates a random 256-bit key
  │                              ├─ AES-GCM encrypts the CV with it
  │                              ├─ stores the key in KV, keyed by seeker
  │                              │
  │                              └─ GitHub: commits into the seeker's area
  │                                   config/profile.md         facts, for letters
  │                                   config/profiles/cv.json   preferences, for ranking
  │                                   private/cv.age            ciphertext
  │
  ◀────────────────────────────┘ returns the profile for review
  shows it, lets them edit
```

Nothing in the browser holds a secret. Nothing in the repository can be read without a key
that is not in the repository.

## Refused design 1: the console writes to GitHub directly

The obvious shape is a static page that calls the GitHub API itself. It cannot work, and the
reason is not a limitation to engineer around.

**GitHub Pages serves static files.** There is no server-side execution of any kind, so a
credential the page uses is a credential the page ships. Anyone who opens the site can read
it out of the JavaScript, and a token that can write to the org would let them write to the
org — or read every seeker's data.

The only ways out are a credential the *seeker* supplies, which the premise rules out, or a
credential held somewhere that is not the browser. Hence the Worker. It is a server, and
accepting that it is a server is the honest part of this design.

## Refused design 2: encrypting the CV with a key derived from the seeker's email

This was the first proposal for keeping CVs in git safely, and it protects nothing.

**A salt is not a key, and the email is not secret.** The seeker's address appears in the
sent log, in the repository, and in every application that goes out. Deriving the encryption
key from it means that everyone who can read the repository can also derive the key — which
is precisely the population the encryption is supposed to stop. It converts "the CV is in
git" into "the CV is in git, in a format that takes one extra step to read".

A salt exists to make precomputed hash tables useless. It is public by design. Using one as
key material is a category error, and a plausible-looking one.

## What is done instead: crypto-shredding

Each seeker gets a **random 256-bit key**, generated once and stored in the Worker's KV —
never in the repository, never in the browser, never in a commit.

The CV is encrypted with that key (AES-256-GCM) and the ciphertext is committed. It stays
available, so a later application can attach the original file, which is the whole reason
for keeping it.

**Deletion destroys the key, not the file.** This is the part that matters. Git history is
effectively permanent: a committed file survives in every clone, every fork and every cached
object, so "delete the CV" is a promise that cannot be kept by removing a file. Destroying
the key makes every copy of the ciphertext permanently unreadable at once, including the
ones you do not control.

That turns an erasure request from an impossible git-history rewrite into a single key
deletion — which is what makes keeping CVs in git defensible at all.

```
deletion request
  └─ delete the seeker's key from KV
       └─ every copy of private/cv.age, everywhere, is now unreadable
       └─ delete config/profile.md and config/profiles/cv.json in the same commit
```

### What crypto-shredding does not do

It does not undo what was already decrypted and used. A letter already sent quoting the CV
has been sent. The derived `profile.md` is plaintext in the repository and must be deleted
in the ordinary way — it is small and bounded, which is exactly why the extracted facts are
kept separately from the CV rather than the CV being re-read each time.

It also assumes the key store is authoritative and backed up carefully. A lost key is an
unreadable CV with no recovery, which is the same property that makes deletion work.

## Identity, without accounts

A seeker has no GitHub account and no password, so identity cannot be their email address:
an address is a claim, not a proof, and anyone who typed somebody else's would read and
overwrite their CV. What a seeker holds instead is a **capability** — a random token issued
on first upload and kept in their browser. Only its hash is stored, so a leak of the key
store does not hand over anybody's account.

The honest limit: **lose the browser storage and you lose access.** There is no password
reset, because there is no password and no verified address to send one to. The token is
shown once as a recovery code for exactly that reason, and a non-technical user will not
save it. Real recovery means verifying an email address, which means sending mail, which is
a dependency this does not have — it is the next thing to decide, not something already
solved.

## Keeping personal data out of the ranking profile

The ranking profile goes to a public engine, so it must carry no personal data. Three layers,
because the first two are not enough on their own:

1. **The prompt** asks for a role description and no personal data. A model mostly complies.
2. **A whitelist** rebuilds the output field by field, so anything the model invented — a
   `name`, an `email`, an `exfiltrate` — has nowhere to land.
3. **A scrubber** removes addresses, phone numbers and URLs from the free-text fields that
   *do* survive.

The third layer exists because the second is not sufficient, and the test that proved it is
worth keeping in mind: `headline` is whitelisted, and a model returned
`"Bhargav Muktha, name@example.org, seeking QA roles"` into it. A whitelist decides which
fields survive; it cannot decide what is inside one.

A name cannot be stripped this way — a name looks like any other word — which is why the
headline is capped and why nothing downstream treats it as identifying.

Facts are deliberately **not** scrubbed. They name employers and dates because that is what
a cover letter cites, and they stay on the private side.

## Who may hold what

| | Credentials | Personal data |
|---|---|---|
| `discovery-console` (public Pages) | none, ever | none — it renders what the Worker returns |
| the Worker | GitHub token, OpenRouter key, the CV keys | CV text in memory, for the length of one request |
| `eu-company-discovery` (public) | none | none — a ranking profile carries preferences only |
| the seeker's area (private) | none | `profile.md`, the ranking profile, the encrypted CV |

The engine is listed here to make a point: it never sees a CV, and `model.Profile` has no
field for a name, an employer or a contact detail. A profile handed to `eucd rank
--profile-file` cannot carry personal data, because there is nowhere to put it.

## What this makes you

Holding other people's CVs makes you a data controller for them, which the personal
job-search tool this grew out of never was. That brings obligations the architecture cannot
discharge on its own: a lawful basis for processing, a privacy notice telling seekers what
is stored and for how long, a retention period after which an inactive seeker's data is
removed, and a route for someone to ask for their data or its deletion.

The design above makes the last of those mechanically possible. It does not make the others
true, and no amount of code will.

## Retention

Set a retention period and enforce it on a schedule: a seeker inactive for N months has
their key destroyed and their derived files removed. Decide N deliberately rather than
letting it default to forever, which is what happens if nobody chooses.
