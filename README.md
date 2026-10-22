# discovery-console

A console over a private company-discovery dataset.

**This repository is public and holds no data.** The site it publishes is a static shell:
two HTML files, a stylesheet and four fonts. Everything you see in the console is fetched
from the GitHub API, in your browser, with your own access token. Without a token that can
read the private repository, this site shows nothing to anyone.

That arrangement is forced and it is the right one. GitHub Pages publishes only from public
repositories on the Free plan, and even on a paid plan a site built from a private
repository is still world-readable — private Pages needs Enterprise Cloud. So the data
cannot live in the site. It stays in [`discovery-runner`](https://github.com/iobyte-labs/discovery-runner),
which is private, and reaches your browser only after you sign in.

```
discovery-console (public)   the shell you are reading
        │  fetch() with your own fine-grained token
        ▼
   api.github.com
        │
        ▼
discovery-runner (private)   data/companies.json, the config, the workflows
```

## Signing in

The console asks for a **fine-grained personal access token**, nothing else — the
repository it talks to is fixed in `hugo.toml`, not typed in. Create one at
*github.com/settings/personal-access-tokens*:

| Field | Value |
|---|---|
| Resource owner | `iobyte-labs` — the organisation, not your username |
| Repository access | Only select repositories → `discovery-runner` |
| Contents | **Read-only** — to read the dataset |
| Actions | **Read and write** — to add a source and start a crawl |
| Expiry | The shortest you can live with |

By default the token is held for the tab you are in and forgotten when you close it. Tick
*stay signed in on this device* to keep it in this browser instead. Signing out clears both.

**Only the repository's owner can use the console.** A token that can reach the repository
but not administer it is refused at the gate (`require_admin` in `hugo.toml`). Be clear
about what that is: it restricts this user interface, not the data. The real boundary is
GitHub's — a token without access to `discovery-runner` gets a 404 from the API and never
reaches anything, whatever this page does. If you want to be certain nobody else can mint
such a token, require organisation approval for fine-grained tokens in the org's settings.

## What it does

- **Overview** — how much of the dataset has been crawled, how many companies published a
  contact, which sites refused access, and what to do next.
- **Companies** — every company, filtered by country, sector, crawl status, quality and
  what kind of address was found; grouped by country, sector or source; searchable;
  paginated. Clicking a row opens what the engine knows about it, including every contact
  with the page it was read from and the date.
- **Sources** — the associations in the dataset, and the field that adds a new one. Paste a
  member-directory URL, pick a country and a sector, and it dispatches the runner's
  *Add a source* workflow.
- **Runs** — recent workflow runs, and a button to start a crawl.

## Running it locally

Nothing about the console needs to be published. The same build runs on your machine and
behaves identically, which is the better way to use it if you would rather not have a URL
at all:

```bash
hugo server
```

Then open the console at `/app/` and sign in exactly as you would on the published site.

To see the interface without a token, drop a `companies.json` export at
`static/__testdata.json` and load it from the browser console. It is gitignored, and the
Pages workflow fails the build if anything resembling a dataset reaches `public/` — but
delete it when you are done rather than relying on that.

## Why there is no backend

There is no server to attack, no database to leak and no credential stored anywhere but
your browser. The cost is that the token sits in browser storage while you are signed in,
so the page loads **no third-party script at all** — the fonts are self-hosted and the
Content-Security-Policy allows exactly one connection target, `api.github.com`. If that
trade ever stops being worth it, the upgrade is a GitHub App device flow, not a server.
