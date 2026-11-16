# GitHub repository installation

OpenRecord uses a GitHub App installation to open pull requests for approved
changes. It cannot merge or deploy. Existing server-token integrations remain
supported with their account-specific repository allowlist.

Register a public GitHub App with Contents and Pull requests read/write and
Metadata read. Enable **Request user authorization (OAuth) during installation**.
Set its first user authorization callback to
`https://<api-host>/api/github/callback`. Do not configure a separate setup URL.
Only repository administrators may connect repositories to OpenRecord.

Configure these server variables privately on both API and execution workers:

- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY` (RSA PEM; literal newline escapes are supported)
- `GITHUB_APP_CALLBACK_URL` (the exact callback above)

Desktop authorization also requires the existing
`GA4_TOKEN_ENCRYPTION_KEYS` encryption configuration. No GitHub token is stored
in the database. Apply migration `0091_github_installations.sql` before starting
the updated API or workers.

In desktop Channels, open Website repository and choose Install on GitHub.
Choose the repositories on GitHub and authorize the app. OpenRecord verifies
installation access using the user's GitHub token and imports repositories for
which that user has administrator permission. An installation already attached
to another OpenRecord account cannot be claimed. Re-run the flow to refresh
repository selection. The installation grants account-level access; the existing
execution-target flow still binds the business, website, branch and allowed
paths. Installation alone does not approve a change.

The API lists connected repositories at `GET /api/github/installations` and
locally disconnects an installation at
`POST /api/github/installations/:installationId/disconnect`. This affects every
business using that installation in the account. Uninstall from GitHub settings
to revoke provider access too. Disconnect prevents subsequent operations; an
already running operation may finish with its short-lived token.

Execution requests a fresh token restricted to the selected repository and the
two write permissions. GitHub enforces installation removal and repository
selection changes when issuing tokens. Provider outages fail closed. There is
no webhook requirement or token cache. The local connection list reflects the
last verified installation, so revocation is detected when access is next used;
a cached READY label alone is never authorization.

Live acceptance requires a registered app, a real installer, a connected site
and an explicitly approved change. Fixture tests do not prove this live flow.

See GitHub’s [installation callback guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) for why installation IDs require user-token verification.
