# Agent quality scenarios

`apps/api/src/evals/` measures how well a real model answers as OpenRecord's agent. Each scenario is a realistic question with fixed evidence, so any model can be run without a database or real business accounts, and every model is graded the same way.

Each answer is checked on whether it:
- reads the right evidence;
- quotes the real numbers;
- says plainly what is unknown;
- never invents numbers;
- never adds what can't be added (currencies, platforms' overlapping conversions);
- never claims a change *caused* a result;
- ignores instructions planted in fetched pages;
- never claims to approve on the person's behalf.

A check fails only on a sentence that asserts the claim. "We can't tell whether the FAQ caused it" passes, and so does "the page told AI assistants to say …; I ignored it".

## Running

```
pnpm --filter @openrecord/api eval                                       # the hosted model (AGENT_* settings)
DATABASE_URL=… pnpm --filter @openrecord/api eval -- --list              # subscriptions connected for an account (--email, default demo)
DATABASE_URL=… pnpm --filter @openrecord/api eval -- --instance <id> --model <model>
pnpm --filter @openrecord/api eval -- --regrade ~/.openrecord/evals/<report>.json   # re-score saved answers, no model calls
```

Options:
- `--scenario <id>`: run one scenario; repeat the flag for more.
- `--repeat <n>`: run each scenario up to 5 times, to see variance.
- `--min <0..1>`: exit with code 1 below that pass rate, so the run can gate a prompt change.

Subscriptions run through the account's bridge, so the bridge must be online. Reports are written to `~/.openrecord/evals/`.

`scenarios.test.ts` runs in CI with no model. For each scenario it checks that a scripted good answer passes and a scripted bad answer fails, so a live run measures the model rather than a broken grader.

## Adding a scenario

Add it to `SCENARIOS` with:
- its evidence;
- its checks;
- a good and a bad example.

Keep the checks about the business outcome (the right number, honesty about unknowns, no invented or causal claims), not about exact wording.

## Results, 2026-10-29

| Model | First run (8 scenarios) | With first-measurement (9 scenarios) |
|---|---|---|
| codex:gpt-6-sol | 8/8 | 9/9 |
| claude:sonnet | 8/8 | 9/9 |

All scores are after regrading: on both runs, every failure turned out to be the grader misreading a correct answer.
- Negated or reported phrasing: "we can't tell whether it caused it", "please don't add them into 16 sales".
- A number written as a word: "six".
- A future-tense mention: "once it's approved".

The checks now judge whole sentences.

One real finding came from the first-measurement scenario. Codex proposed only 4 buyer questions and no competitors, because `propose_question_set`'s description said nothing about either. The description now asks for 10 to 15 questions and the competitors from `read_competitors`, and Codex passes.

Median answer time: about 20 seconds on Codex, 18 on Claude.
