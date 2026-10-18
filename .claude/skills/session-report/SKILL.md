---
name: session-report
description: Write the session's report as docs/sessions/REPORT_SESSION_CONCORDANCE_<id>_<date>.md — what the session landed, the mechanisms that made it efficient, where it lost time or money, and the improvements it suggests, each with its value, ranked most impactful first — from measured figures (git, GitHub Actions job minutes, agent token counts, the deploy runs, the transcript), never from memory. Invoke when the operator asks for a session report, an account of the session, or "how did this session do".
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# session-report

One file per session, in `docs/sessions/` at the repository root:
`REPORT_SESSION_CONCORDANCE_<id>_<YYYY-MM-DD>.md`. It leads with the result and the mechanisms
that produced it, then the losses, each loss tied to a suggested improvement and its value. Every
figure in it is measured in this session; nothing is recalled.

## The file name

`<id>` is the first six characters of the base64 SHA-256 of the session id (the
`Claude-Session:` URL's last path segment), so the same session always names the same file:

```bash
printf '%s' "$SESSION_ID" | shasum -a 256 | cut -d' ' -f1 | xxd -r -p | base64 | cut -c1-6
```

`<date>` is today's UTC date. Re-running the skill in the same session overwrites the file.

## Gather, do not recall

Run these before writing a line. Tee each to a file under the scratchpad before filtering.

**Output.** Session commits, PRs, and the diff, with generated output separated from hand-written
change. Plan documents, `NEXT.md` and this folder's reports are prose, not code; count them apart:

```bash
git log --since="<session start ISO>" --format='%h' --grep="<session id>" --no-merges | wc -l
gh pr list --state merged --search "<session id>" --json number,title,mergedAt
git diff --shortstat <main at session start>..<main now> -- . ':!*.md' ':!test/fixtures' ':!corpora'
git diff --shortstat <main at session start>..<main now>
```

Board rows closed: the rows that left `NEXT.md` between the session's first and last `/board`
render (`git log -p --since=<start> -- NEXT.md` shows each `- [ ] **<label>.` line removed).
Requests the session sent to another session's inbox count separately; they are not this
repository's output.

**Elapsed.** Session start is the first tool call's timestamp; a batch's dispatch-to-deployed time
runs from its first agent dispatch to the `deploy.yml` run's success on `main`. Both from
timestamps, not estimates.

**LLM, the session's own.** Every sub-agent's completion notification carries `subagent_tokens`;
sum them and list them per agent with its model and its label. The main session's usage is not
exposed to the session: estimate it from turn count and context size, say it is an estimate, and
price at the current list rates (input, output, cache read) with the subscription's marginal cost
stated beside it.

**LLM, the product's.** Model calls the session made through the tool itself (embedding and
generation through Ollama on the laptop, and any call made from the sandbox): count them from the
eval outputs under `evals/` and the run logs, and name the model for each. A local call has no
marginal price; say so and give the elapsed time instead. Report a call that reached a paid
service with its figure and its source.

**GitHub Actions.** Billable job-minutes, not wall-clock run minutes; jobs run in parallel inside
a run:

```bash
for id in $(gh run list --limit 200 --created ">=<session start ISO>" --json databaseId --jq '.[].databaseId'); do
  gh api "repos/polycode-public/concordance/actions/runs/$id/jobs?per_page=100" \
    --jq '[.jobs[] | select(.completed_at!=null) | ((.completed_at|fromdate)-(.started_at|fromdate))] | add // 0'
done | paste -sd+ | bc
```

Also count runs per workflow and note which were duplicates (push and pull_request on one commit),
supersessions, cancellations made on purpose, reruns, or docs-only triggers (a `NEXT.md` or plan
commit on `main` runs `deploy.yml`). A public repository bills nothing; say so and give the
private-rate figure beside it.

**AWS.** Count the `deploy.yml` runs on `main` and the stacks updated (`cloudformation list-stacks`
with `LastUpdatedTime` in the session, `--profile polycode-sandbox`). The sandbox's standing cost
is the account's (`AWS_ACCOUNT.md`); name the source for any figure.

**Operator.** Count the operator's messages in the transcript and class each: a decision between
named alternatives, a paste of a command the session could not run (`aws sso login`, a merge the
permission classifier refused, a worktree removal), a question, a correction of the session's
behaviour, a new requirement. The pastes and corrections carry the lessons; the new requirements
are listed for the operator to place.

## The report's shape

In this order. Lead with the result; the operator reads the first line and decides whether to read
on.

1. **Result line**: PRs merged, rows closed, commits, hand-written lines, generated files, what
   the sandbox serves (the `main` commit deployed), the board's state (rows open, in flight,
   blocked).
2. **Method, in prose.** First person, the operator's voice, four to six sentences, so it can be
   sent as it stands. State what the operator does, what the sessions do, what the operator
   decides, what this session landed and for what, and what the operator's next area to develop
   is. The shape:

   > I use Claude Code as a coordinator. I write the plan and the rules into the repo, it
   > dispatches several agents in parallel on separate branches, merges what passes the tests,
   > and I make the decisions it can't (which design, what gets merged, anything that spends
   > money or deletes things). In this session that landed seven rows in one batch and three
   > follow-up fixes in one day for roughly £x of tokens. I spend my time reviewing the evals
   > and fixing the process when it wastes cycles, not writing code or even looking at it.
   > Today the batch-and-watch loop became reliable and my next areas to develop are the
   > retrieval evals and the contradiction engine's precision.

   Every figure in it is this session's; the last sentence names what became reliable this
   session and the one or two areas the losses table points at.

3. **What worked**: one table, a row per efficiency (elapsed time, LLM cost, CI minutes, operator
   input, quality), the measured figure, and the mechanism that produced it. Mechanisms are named
   things the next session can repeat: a skill, a rule, a brief shape, a file boundary, a worktree
   per agent, a batch branch per wave, an eval run.
4. **Room for improvement**: one table, a row per loss, the measured size of the loss, the cause,
   and the improvement that would remove it. A loss with no suggested improvement is not finished
   being reported. Losses this repository produces by shape: a docs-only commit on `main` running
   a full deploy; a permission classifier refusing a gated merge or a settings edit; a board edit
   that lost rows; a push that went out before the check log's `exit` line was read; a worktree
   with no `node_modules`; an agent that ended its turn on a long foreground build; a Docker or
   Ollama tier test that was not run because its environment variable was unset.
5. **Placement**: where the session sits on each efficiency against published anchors, with the
   anchors cited and the scales labelled as constructed. Anchors come from `anchors/` in this
   skill's directory (see Anchors below), never from the last report's text.
6. **Suggested improvements**: one line each, ranked most impactful first: what to change, its
   value (the measured loss it removes, in the losses table's unit), and the board row that already
   covers it, if one does.

## Anchors

`anchors/` beside this file holds one file per source (a site, a report, a price list), each with
front matter: `source`, `url`, `retrieved` (the UTC date the facts were read), `query` (the search
that found it), `efficiencies` (the report rows it anchors) and `read` (`page` when the page was
read, `search-summary` when only a search engine's summary was). The body lists the facts, one per
line, as the source states them. Create the folder when it is missing.

**Maximum age: 30 days.** For each efficiency the Placement table needs, use the anchor files whose
`retrieved` date is within 30 days of today. When an efficiency has none, or all of its files are
older, run a fresh web search for it (anchors published within the last three months), then write
or overwrite that source's file with today's `retrieved` date and the query used; a source whose
new search finds nothing current is left as it is, and the report names it as stale. Prefer reading
the page over the search summary, and set `read: page` when you do. Commit the changed anchor files
with the report.

## The suggested improvements

The report suggests; it opens no board row. Every loss in the "Room for improvement" table gets one
suggestion: what to change, in one line, and its value as the measured loss it would remove
(minutes, pounds, job-minutes, operator messages), in the unit the losses table used. Rank the
list by value, most impactful first; where two values are in different units, say which ranks
higher and why. Name any board row that already covers a suggestion. A loss whose remedy is an
action the operator has kept for themselves (a command that spends money, deletes, or refreshes a
credential; a GitHub setting; an AWS write) gets a suggestion about handling the block efficiently,
never one that pre-authorises the command. The operator picks which suggestions become rows.

## Write-back

Prettier the report alone (`npx prettier --write docs/sessions/<file>`; never reformat `NEXT.md`
in the same command) and give it the licence header the other documents carry. Commit the report,
and any anchor files it refreshed, as a docs-only commit straight to `main` and push it as its own
command. Then say, in the reply: the file name and the result line, and end the reply with the
ranked suggestions and their values as its last block, so the operator's choice sits where they
stop reading.

## What the report is not

Not a transcript, not a log of tool calls, not a place for the session to grade itself in prose.
Figures, mechanisms, losses, suggestions. Where a figure could not be measured, the report says
"estimated" beside it and how; it never fills the gap with a confident number.
