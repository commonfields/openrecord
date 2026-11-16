# Marketing P0 acceptance contract

The first complete delivery path is an OpenRecord-hosted campaign page with an
inquiry form. It is an optional destination, not a replacement for a business's
website. Research and drafting require neither a repository nor a publishing
connection. Existing WordPress, Webflow and GitHub paths remain available.

The alternative was to make the first complete path depend on a customer's CMS
credentials. That reuses delivery but leaves setup, conversion capture and
tracking dependent on another product. The hosted path has a larger public
surface, so it must enforce strict HTML isolation, bounded one-use form tickets,
submission quotas, encrypted contact data and separate test/production events.

The durable chain is business → campaign revision/task → artifact revision/hash
→ prepared publication → exact operator approval → published revision → observed
inquiry. A current artifact or campaign edit makes the preparation stale; the
already published version stays pinned until a separately approved replacement.
No chat message or generated content authorizes publication.

Prelaunch acceptance uses the same renderer and form handler as publication,
with server-issued test tickets. Tests never increase production inquiry counts.
An inquiry is a recorded submission, not a qualified lead, revenue or causal lift.
Contact details are never returned to the agent; authenticated operators can
retrieve them, and retention is bounded. The first conversion event is deliberately
narrow: a visitor submits an email and inquiry on the hosted page.

P0 gates:
1. A normal agent turn saves a campaign, finished artifact and exact deliverable link.
2. The owner can choose hosted delivery in chat without IDs or credentials.
3. Preparation fixes content, destination, CTA and tracking; stale revisions refuse approval.
4. An actual form submission records test evidence before approval is possible.
5. The native decision card describes and approves exactly that publication.
6. Public GET serves only approved pinned content; production submissions are durable,
   replay-safe, quota-bound and isolated from test events and other tenants.
7. Desktop campaign progress comes from these records, with an accessible live URL,
   explicit test readiness and separate submission counts.
8. Restart/replay, cross-tenant access, malicious HTML, forged tickets, stale approvals,
   withdrawal and contact-data retention have executable regression checks.

Validation distinguishes scripted-agent/local HTTP/native UI checks from a real
provider turn and a deployed customer campaign. None substitutes for another.
