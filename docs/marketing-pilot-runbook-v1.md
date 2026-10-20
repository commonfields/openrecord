# Marketing pilot runbook v1

For a marketing operator running one real business through OpenRecord's
marketing workflow:

```
business goal → initiative → approval → measurement plan → recorded work
→ imported figures → outcome evaluation → your decision → client report
```

OpenRecord records what you did and what the figures say. It does not run
campaigns, pull data from analytics tools, or decide whether the work
succeeded.

**Test fixtures versus real evidence.** Every name, figure and link in the
repository's acceptance runs (`TEST Fixture …`, `*.w6-fixture.test`) is
synthetic. The acceptance runs show that the software works. They are not
customer evidence. Do not copy their figures into a client report. Real
evidence starts when you import exports from the client's own analytics or
booking system.

## 0. Before you start

| You need | Notes |
| --- | --- |
| An account and a sign-in | Use the sign-up page. Every account member is an operator. There are no separate roles in v1. |
| The client's goal in one sentence | One goal, one metric (for example "Increase trial signups"). |
| A way to export daily counts | GA4 export, or a spreadsheet saved as CSV. See section 4. |
| The metric's time zone | Days are counted in this zone. It cannot be changed per file. |

Work from a browser at the address the deployment is configured for
(`APP_BASE_URL`). The service refuses changes sent from any other origin with
`OriginRefused`. Whoever deploys the pilot must set `APP_BASE_URL` to the
exact address operators use.

## 1. Onboard a business and choose the outcome

1. Open **Clients → Add a product**.
2. Choose **Authorized client** for a client's business (or **Owned product**
   for your own).
3. Enter the name, website, category, audience and value proposition.
4. Write the **goal statement**. Pick the **outcome**: Leads, Signups,
   Purchases or Bookings.
5. Define the **measurement source** (section 2) and save.

You land on the **Growth workspace** for the business.

## 2. Define the measurement source

| Source | Use when | Event field |
| --- | --- | --- |
| GA4 aggregate export | The outcome is a GA4 key event | The exact event name, for example `trial_signup` |
| Operator aggregate CSV | Any other system: booking tool, CRM, spreadsheet | Not used |

Set these carefully. They are pinned to the goal:

- **Label** — the name clients will read ("Trial signups", "Bookings").
- **Source identity** — what produced the numbers ("Acme GA4 property").
- **Reporting time zone** — an IANA name such as `UTC` or `Asia/Makassar`. The
  form pre-fills `Asia/Makassar`. **Change it** if the business is elsewhere.
- Only **count** metrics are supported (events per day). Revenue and other
  currency metrics are refused. See section 11.

Editing the profile later creates a new metric version. Initiatives already
approved keep the version they started with, and reports state it.

## 2a. Create and approve an initiative

1. In the Growth workspace choose **Propose opportunity**.
2. Describe one specific change: the problem, the audience, the proposed
   change, why it might help, and what is still uncertain.
3. Choose **Approve** and give your reason. Approval is a human decision, and
   only an approved initiative can be measured and reported.

Do not put private client information in the text fields you want to keep
internal. Public reports hide your assumptions, uncertainty and approval
reason, but show the title, the problem statement, the proposed change and
the target page.

## 3. Declare the measurement plan before you do the work

On the approved initiative open **Measurement plan** and enter four dates:

- **Baseline** period: the days before the change (at least a week is
  sensible).
- **Observation** period: the days after the change.

Rules:

- The observation period must begin after the baseline period ends.
- Each period can be at most 365 days.
- Declare the plan **before** you record any work. If an action's performed
  date is earlier than the plan's declaration time, the report says the
  periods were "chosen after the work was done" and shows **no comparison**.
- Declaring again replaces the plan in force. The report states the plan was
  re-declared.
- The evaluation only compares figures once the **observation period has
  ended** in the metric's time zone.

## 4. Record the actual work

Choose **Record execution** on the initiative. Record what a person did:

- The **action** (for example "Source updated", "Listing updated",
  "Campaign sent") and a compatible **channel** (Website, Third-party
  profile, Email, Paid, Social, Other).
- A **reference**: a page address, listing name or campaign name. OpenRecord
  stores it and does not open it.
- What you actually did, and when you did it.

Every entry is shown as **operator-attested**: your statement, not verified by
OpenRecord. Record each piece of work separately. Several entries for one
initiative are allowed, and reports say the figures describe them together.
Work on *other* initiatives in the same period is disclosed in the report.

Mistakes: an entry cannot be edited or deleted. If you recorded the wrong
date or detail, record a new correct entry with a clear description. Your
note in the report's next steps can explain the earlier entry. See section 11.

## 5. Import real measurement data

Open **Measurement imports** (link in the Growth workspace header). Choose the
metric, the **coverage start and end** (the days the file is meant to
cover), paste the CSV and choose **Import daily aggregate**.

Always choose **Operator-supplied export** for real data. "Synthetic fixture"
is only for tests, is disabled in normal environments, and is labelled as
synthetic wherever it appears.

**GA4 export**: a CSV with the header
`date,session source,session medium,sessions,key events`. Optional comment
lines starting with `#` are allowed before the header. Daily key events for
the event you named are summed across source/medium rows. Sessions and source
rows are not stored.

**Operator CSV**: the header is exactly `date,value`, one row per day:

```
date,value
2026-09-01,3
2026-09-02,4
```

Limits and rules:

- Dates are `YYYY-MM-DD` and must fall inside the coverage you declared.
- Values are whole numbers, zero or more. Fractions and negatives are refused.
- One row per day. Duplicate days are refused.
- At most 1 MB and 10,000 rows per file.
- A day inside your coverage with no row stays **missing**. It is never
  treated as zero. If a day really had zero, write `0`.
- Importing the same bytes again changes nothing. Importing different values
  for a day already reported is allowed, and the day is shown as
  **conflicting**. The newest import is shown, and the evaluation is not
  comparable while a window contains a conflict.
- Raw files are kept privately. They are never in reports.

After importing, use **Load series** to check the days. Anything shown as
Missing or Conflicting will weaken the evaluation.

## 6. Review the outcome evaluation

Open **Outcome evaluation** on the initiative.

- **Measurements comparable** means the data is complete enough for a before
  and after reading: both periods are complete, all days have a value, nothing
  conflicts and the plan was declared in advance. It is a statement about data
  quality. It is **not** a verdict that the work succeeded.
- **Indeterminate** means the data cannot support a comparison. The page lists
  the plain reasons (no plan, plan declared late, missing days, conflicts,
  observation period not finished, unsupported metric). No improvement figure
  is shown.

The comparison, when shown, is a plain difference of recorded daily averages
and totals. OpenRecord does not claim the work caused the change, and it does
not calculate return on spend.

## 7. Record your decision

Choose **Record review**, pick Keep, Revert, Extend or Inconclusive, and write
your reason. Only a person can do this. If you do not record a decision, the
report says no decision has been recorded.

## 8. Preview, publish and share the report

1. Open **Client report → Preview client report**. Read it as the client
   would. Add optional **next steps** in your own words.
2. Choose **Publish version N**. Publishing freezes the figures, the evidence
   and your decision. Nothing is published automatically.
3. Choose **Create view-only link**. Send the link to the client yourself.
   OpenRecord does not email it.

The link opens a client page without a sign-in. It does not show your private
notes, raw files or other clients. It can be saved as a PDF with **Print or
save as PDF**.

## 9. Correct an error and publish a new version

Published versions never change. To correct or update a report:

1. Fix the cause (import corrected figures, record your decision, add next
   steps).
2. Open **Client report → Preview client report** again, then publish the new
   version. It supersedes the old one.
3. Old links keep opening their own frozen version with a notice that a newer
   version exists. Revoke old links you no longer want clients to use.

If the preview you reviewed is out of date when you publish ("The evidence
changed" or "Another version was published"), preview again and re-check.

## 10. Revoke a report link

In **Client report**, choose **Revoke link** next to the version. The link
stops working at once for everyone. A revoked link never works again. To share
again, choose **Create a new view-only link**, which gives a new address.

## 11. Limits and common problems

**Known limits in v1**

- Count metrics only. Revenue and other currency metrics are refused.
- One observation window per plan. Figures are daily aggregates.
- Imports are pasted text. There is no file upload and no connection to GA4 or
  booking systems.
- No edit or delete for recorded work. Record a corrected new entry.
- No roles, no client login and no email delivery of reports.
- OpenRecord does not authenticate your exports. Reports say figures came from
  files supplied by the team.
- OpenRecord does not show a causal effect, an attributed result, or return on
  spend. These words appear in reports only in limitation statements.
- The print layout depends on your browser's PDF output. Check the PDF before
  sending.

**Common problems**

| What you see | Meaning | What to do |
| --- | --- | --- |
| "Plan declared after the action" | A recorded action is earlier than the plan | Record new work only after declaring a plan. For past work the periods cannot be shown as agreed in advance |
| "Observation period not complete" | The observation period has not ended yet | Wait until it has ended in the metric's time zone, then re-evaluate |
| "Missing days" | A day inside the coverage has no row | Re-export with all days, or accept an indeterminate report |
| "Conflicting days" | Two imports disagree for a day | Decide which export is right and re-import the full range |
| "The first CSV row must be exactly `date,value`" | Wrong header for an operator metric | Fix the header |
| "A CSV row is dated outside the declared range" | A row falls outside the coverage dates | Widen the coverage or remove the row |
| "This request replays an earlier import with different content" | Same file under a different source or range | Re-import with the original settings |
| "Currency aggregation is not implemented" | Money metric | Use a count metric |
| "The evidence changed since this preview" | New data arrived after you previewed | Preview again |
| "Report not available" on a client link | Revoked, mistyped or unknown link | Create a new link |

## 12. Before the first real pilot

- Use one real business with a real, known goal and your own consent to
  share its numbers.
- Run section 1 to section 8 once with a harmless goal and a colleague as the
  client, and note every point where you needed help.
- Do not describe the pilot as customer-validated until the client has read
  the report, made a decision from it and said whether they would continue or
  pay. Record that outside OpenRecord.
