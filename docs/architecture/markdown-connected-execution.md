# Markdown content through connected execution

The historical `feat/growth-github-delivery-v1` prototype supported exact
Markdown/MDX replacements. That useful behavior is adapted into W7 connected
execution; its obsolete migration 0031 and opportunity lifecycle are not restored.

## Preparing and approving

Use the existing `prepare_page_change` tool with `REPLACE_MARKDOWN` and
`value: { edits: [{ find, replace }] }` for a connected `.md` or `.mdx` path.
The manual preparation form still offers only the noindex HTML change.

Each nonempty find must match exactly once in the original source. At most 20
edits, each bounded to 5,000 characters per field and 16,000 serialized UTF-8
bytes combined, may be applied. Overlapping,
missing, ambiguous and overall no-op edits are refused. Deletions are allowed;
replacement order cannot change the result. Source and resulting content are
limited to 256,000 UTF-8 bytes. Provider source bytes must match their blob ID.

HTML actions cannot target Markdown, and Markdown replacements cannot target
HTML. Existing account repository allowlists, registered website scope, permitted
paths, exact diff/hash review, expiring human authorization, dispatch and stale
source checks remain in force. Review MDX code as well as copy: this is not an
MDX sanitizer or build validator. OpenRecord never merges or deploys the PR.

## Three separate facts

Opening a PR records request acceptance. A maintainer merge is verified against
the approved source bytes and records one source-update receipt. Neither proves
that a rendered page was deployed, nor that marketing results improved.

Markdown live checks record `INCONCLUSIVE` without fetching the website: a generic
source replacement cannot reliably be matched to rendered output. Inspect the
live page separately; measured outcomes still belong to the measurement system.

## Migration and tests

Migration 0078 broadens the existing path constraints and action kinds, and adds
a format/action compatibility constraint. It retains W7 lifecycle and guards.
Fixture tests cover exact replacements, HTTP preparation/authorization and tenant
isolation, DB guards, approved worker bytes, replay safety, maintainer merge and
inconclusive deployment. These are stand-in tests, not live GitHub/deployment
acceptance; no external publication or spending is used during validation.
