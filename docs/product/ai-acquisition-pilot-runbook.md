# AI Discovery — operator runbook

AI Discovery lives at **Clients → client → AI Discovery** (`/clients/:id/discovery`). It answers: *how often did the measured
AI surface mention or recommend this business, and what acquisition evidence is available?*

## 1. Before you start

- State the basis honestly: **Authorized client** only with the business's authorization. Otherwise use **Public research**:
  the business is not a customer, has not authorized the measurement, and must not be contacted. Never invent authorization.
- Keep private pilot material (subjects, answers, reviews, exports) out of the public repository.

## 2. Freeze the question set

1. Enter the product category, brand name, known aliases, verified owned domains and, when justified, named competitors
   (`Name | aliases | domains`, one per line). Add a name-ambiguity note when the brand shares a name with something else;
   tick **Match case** (or add `| case` to a competitor line) for a name that is also a common word or acronym.
2. Write buyer questions the way buyers ask, grouped by intent. The pilot uses 30: six each for category discovery,
   problem-solving, alternatives, integration needs and purchase evaluation. Do not write leading questions
   ("Why is this brand the best?"). The page flags questions that name the brand.
3. **Freeze.** The exact text, keys (`CD-01`…), groups and a sha256 digest are stored. Nothing can be edited; a change is a new
   version, and batches on different versions are never compared.

## 3. Approve spend

A batch costs one provider call per sample; the worker allows up to 4 attempts per check, and grounded search queries are
billed separately. Get written operator approval for the ceiling **before** starting. Previous budgets (e.g. a validation
budget) do not carry over.

## 4. Run a smoke batch, then the full batch

1. Verify only one worker is running (`ps aux | grep apps/worker`). Exactly one.
2. **Start batch → Smoke batch**: one question per group, one sample. Tick the approval box for the displayed call ceiling.
3. Check that answers arrive, live web retrieval is observed, and citations resolve. Failures stay visible and are never re-run
   selectively; a new batch is a new measurement.
4. **Start batch → All questions**, 5 samples per question, after approval of the full ceiling.

## 5. Review every answer

Open a question, read the exact answer (candidate mentions are highlighted; the text is unchanged), the search queries and
the cited sources, then decide:

- **Mention**: Mentioned / Not mentioned / Unclear (e.g. a different entity with the same name).
- **Recommendation** (when mentioned): Recommended / Mentioned, not recommended / Advised against / Unclear.

A listed alternative ("you could consider A, B or C") needs your judgment; the detector never decides. Corrections append and
keep history. Only reviewed answers enter mention and recommendation counts.

## 6. Import GA4 referral evidence (optional)

Export from GA4 a report with **Date, Session source, Session medium** (or *Session source / medium*), **Sessions**, and
**Key events** only if a signup key event is configured, filtered to that event. No other columns: anything else, including
visitor-level identifiers, is refused. Enter the property, the exact date range, the report time zone and the event name, then
upload the CSV. The original file and its digest are kept; re-importing the same file is a no-op.

Without a configured event the report shows `SIGNUPS_NOT_MEASURED`. AI-attributed sessions are what GA4 recorded under known AI
assistant sources; they are not tied to any sampled answer.

## 7. Report

**Report** opens the agency report: business, category, question-set version, surface and model, collection period, attempted
and completed samples, confirmed mentions and recommendations with denominators, competitor appearances, owned-domain
citations, per-question repeatability, representative exact answers with evidence links, optional GA4 totals, and limitations.
Print or save it as PDF. There is no public link.

Never present the report as ChatGPT or Claude data, as a probability, as market share, or as proof that an edit caused a change
or that AI produced customers.
