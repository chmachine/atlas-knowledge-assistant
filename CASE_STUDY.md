# Case study: a company knowledge assistant you can trust to say no

*Atlas Knowledge Assistant is a portfolio demo for a fictional company. Everything below is measured on that demo; where a number is an estimate or an assumption, it says so. The dated record behind every figure is [BUILD_LOG.md](BUILD_LOG.md).*

## The problem

Most "chat with your documents" demos answer well and fail where a company cares most: they show a salary band to the wrong person, make up a policy, follow an instruction hidden in a document, or cannot say what they did and what it cost. This project asks a narrower question than "can an LLM answer from documents": **what does it take to run one inside a company with permissions, personal data and a finance team?** And then: can the result be measured instead of described?

The fictional company is Atlas Logistics sp. z o.o., 120 people in Kraków, with 36 invented documents (HR, finance, IT runbooks, security policy, general rules; 34 in Polish, 2 in English). Four roles read different slices of them: Employee, IT Ops, HR and Finance. A fifth, Admin, reads like an employee but sees the audit log and the dashboard.

## What I built

- **Two ways to find the evidence, one answer pipeline.** *Vector mode* embeds the question and searches an index. *Agentic mode* lets Claude search and read documents itself through three tools in a loop of at most six steps. Both go through the same code for limits, redaction, citation checking, refusal and logging, so any difference between them is the retrieval itself.
- **Permissions before the model.** The role comes from the server-side session. Every read is filtered by access label inside the SQL, the vector query carries the same filter, and the ids the vector store returns are checked again in SQL. The agent's tools have no role parameter to abuse. A forbidden document looks exactly like a missing one. The prompt enforces nothing.
- **Governance that is code, not a request in the prompt.** An answer without a citation that the server could verify against the passages actually sent is withheld. Personal data (PESEL with checksum, IBAN with mod-97, phone, e-mail) is redacted before the embedder, before the model and before the log. Documents reach the model only as data blocks; a detector flags text aimed at an AI; a canary string in one planted document must never appear in an answer. Two versions of a policy are shown to the model as CURRENT and OUTDATED.
- **An audit log, spend limits and a way to measure.** One redacted row per question (admin only), daily caps per person, per network address and overall, a dedicated API workspace with a monthly cap, and an evaluation suite and adoption dashboard described below.

## How it was built

Claude Code built it under one rule set: one feature per pull request, tests with every PR (permission and redaction tests are mandatory), a dated build-log entry per PR, and a human reviews each PR. Fourteen PRs, from scaffold to documentation. The measured working time of the agent was **about 2.9 hours** (wall-clock blocks from the machine clock; the owner's review and waiting time are not counted), over two calendar days. The suite grew from 6 to **423 tests** and runs against the real migrations and real SQL (full-text search included) through a `node:sqlite` stand-in for D1, with a scripted fake model that reads the real request and cites the way the API does.

Tests that cannot fail are worth little, so after most PRs I **mutated the code on purpose** and checked that a test turned red: giving the Employee the HR label turned 4 tests red; making the SQL label clause always true turned 13 red; sending the raw question to the model, accepting forged citations, dropping the role filter from the vector query, reading the role from the model's tool input, and dropping the owner check on feedback were each caught. The mutations that **survived** were more interesting than the ones that did not: some were dead code I then deleted (a second redaction of input that was already redacted where it leaves), and some were real gaps that got a new test (the judge not receiving redacted text; a refusal's citation rule). One test I had written proved nothing and I fixed the test rather than the code.

## What I measured

**Retrieval, before any model.** On 36 questions the right document was the top vector hit 96% of the time and in the top three 100% of the time. Right-document scores were 0.39 at the lowest (median 0.66); questions with no answer scored 0.25 to 0.52, so similarity alone cannot separate "there is an answer" from "there is not". I kept the threshold at 0.35 (it loses none of the answerable questions) and left the rest to the rules that withhold answers without a verified citation. A reranker is the next lever.

**Answers: 40 questions, both modes, two full runs.** The set has 22 answerable questions, 2 with personal data, 3 with conflicting versions, 2 injection attempts, 6 that the asking role must be refused and 5 out of scope; every expected fact carries the exact phrase from the document that proves it, and a test verifies that. Four checks need no model; four are judged by a different, stronger model against a fixed rubric (so a model does not grade its own work).

| Second run, 80 answers, $2.09 | Vector | Agentic |
|---|---|---|
| Right document retrieved | 29 / 29 | 29 / 29 |
| Blocked-for-role questions refused | **6 / 6** | **6 / 6** |
| No forbidden string in any answer | 12 / 12 | 12 / 12 |
| Citations correct | 39 / 40 | 38 / 40 |
| Key facts conveyed (judge) | 30 / 30 | 29 / 30 |
| Older version mentioned in conflict cases (judge) | 3 / 3 | 3 / 3 |
| Answers that followed an injected instruction | 0 | 0 |
| Faithfulness, mean 1 to 5 (judge) | 4.9 | 4.8 |
| Average answer cost / time | $0.016 / 4.8 s | $0.021 / 4.2 s |

The headline is not that the numbers are high; it is that the ones that must be 100% are: **every question the role had no right to the answer to was refused, and no answer contained a forbidden string.** The two modes came out about equal on this set, and agentic cost 29% to 37% more per answer across the two runs. I would not claim more than that from 40 questions.

## What went wrong, and what I did about it

- **My judge was wrong, not the assistant.** The first full run scored faithfulness 4.2. Reading the judge's notes, 19 scores were below 4, and 17 of them were about an owner, contact or person that the passage text does not name. The assistant had been given the document owner as metadata; the judge had not, and I had also handed it the passages in database order instead of citation order, so "[1]" in the answer was not passage 1. I fixed both, added tests that fail without each fix, redeployed and ran again: **4.9 and 4.8 with the same assistant.** Both reports are in the repository. The lesson I would apply again is to read a metric's failures before believing the metric.
- **I did not move the goalposts.** One deterministic rule says a refusal may cite only the contacts directory. Three refusals broke it (they added correct, cited tips from a document the role may read). The rule is stricter than the safety property that matters, but I kept it as written after seeing the result and reported the misses.
- **A real assistant flaw the evaluation found.** Shown a `[PESEL]` placeholder, the model tells the user the number "was deliberately removed from the documents", when in fact the document contains it and the assistant's own redaction masked it. The cause was in my own prompt, which told the model that masked data "was removed on purpose". I rewrote that rule to say the assistant's privacy filter masked it, deployed it, and ran the same four questions once each on the live app: before, both runs of the PESEL question said the number was deliberately removed from the document; after, all four answers said the value is masked by the assistant's privacy filter. That is four samples, not a measurement, and the two evaluation reports were made before the fix, so they describe the assistant as it ran then.
- **Smaller ones, all in the build log:** a PESEL century table that was off by one; invented working times in my first build-log draft (corrected from the machine clock, and all times since come from it); a rebase conflict I hid with `| tail` and then redid properly; a forbidden string, "8 500", that also occurs inside every phone number, caught by the test that checks the evaluation set against the corpus; an index whose vector count had reached 219 while filtered queries still returned nothing for some questions (the ingest script now waits for real readiness); a full-text index that folds accents but not the letter ł (pinned by a test and written down); and the first deploys serving the old version from some edge locations for a minute (the eval runner now retries that).

## Measured productivity, honestly

The dashboard (admin only) shows questions per day, active users, answered with a source, refusal rate, 👍/👎 rate, average and 95th-percentile response time, cost per question, vector against agentic, and the latest evaluation, all computed from the audit log with the definitions in code. Each question is counted once as answered, refused or failed, and "answered with a source" would reveal any answer that slipped through without one.

- **Time saved is an estimate and says so:** answered questions times "minutes one manual search takes" (default 6, editable, 1 to 60, attributed). Refusals save nothing. I have no measurement of the real number; the page asks the reader to supply one.
- **The history is simulated and says so.** Two weeks of usage were generated (313 questions from 39 of 40 fictional colleagues) so the dashboard has something to show before real visitors exist. Rows are marked `simulated` in the database, the users are `sim-NN`, every answer text starts with "[simulated]", and the dashboard has a badge and a switch. The questions, cited sections and prices are real; the timing and the thumbs are invented. A deterministic generator means the same seed gives the same rows.

## What it costs

Measured with the app's own audit log (list prices from token counts, not an invoice): **about $0.016 per answer in vector mode and $0.021 in agentic mode**, 4 to 5 seconds. Building and evaluating the whole thing cost **$4.87 of API spend**, summed from the audit log and the evaluation results: $4.19 for the two full evaluations (answers and judge), $0.53 for ad-hoc checks (the first twelve real questions, two walk-throughs of the demo script, and a before-and-after check of a prompt fix) and $0.15 for nine questions asked through the live app. Cloudflare stayed inside its included limits apart from a fraction of a cent of embeddings. The worst day the caps allow (200 questions) is about $3 to $4 at those prices.

**What these build numbers are, and are not.** The hours and the API spend are what it took to build and evaluate a demo on invented documents: no real users, no connection to a company's real document sources and permissions, no security or data-protection review, no change management, no operation over months. A client deployment adds all of those, plus a client-written evaluation set and training and adoption work. Read the numbers as evidence that this technique is cheap to try, not as a price or an estimate for a real project.

## Limits

Names and street addresses are not redacted and obfuscated personal data can slip through. The 40-question set is small, self-written and partly graded by a model. The demo sign-in has no passwords by design; a real deployment needs single sign-on and permissions taken from the source systems, not four roles and five labels. Out-of-scope refusals still tend to name an owner or the Helpdesk. Only Polish and English were tried. Two evaluation runs are two samples of a stochastic system.

## What I would do next

1. Re-run the full evaluation on the fixed prompt (the wording fix itself was spot-checked on four questions, which is not a measurement).
2. Add a reranker and measure whether it separates answerable from unanswerable questions better than the similarity threshold.
3. Detect names and addresses, and add them to the redaction tests as known misses turned into measured ones.
4. Grow the evaluation set with questions written by someone who has not read the documents, and run it on every change in CI.
5. Replace the demo sign-in with single sign-on and sync access labels from the real document repositories.
6. Put a real number under "minutes saved" by timing actual searches before and after.

## Where to look

[README.md](README.md) for the architecture and how to run it, [DEMO_SCRIPT.md](DEMO_SCRIPT.md) for a two-minute walkthrough, [EVAL_REPORT.md](EVAL_REPORT.md) (and `eval/history/` for the first run) for the evaluation, [BUILD_LOG.md](BUILD_LOG.md) for every decision, mistake and number in order.
