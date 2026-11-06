# agent-decision-tracker

Causal decision logging and audit trails for AI agents: outcome tracking, confidence recording, and reasoning attribution.

An append-only, tamper-evident journal that answers the three questions every autonomous agent eventually has to answer: *what did I decide, why, and was the decision any good?*

## The problem

Agent failures are rarely caused by one bad decision. They are caused by decisions that were never recorded — an agent retries with a different policy, quietly escalates a timeout, re-weights a fallback — and weeks later nobody can say which choice caused the outage, or whether the agent's stated confidence ever matched reality.

Existing options fall short:

| Approach | Why it fails for decisions |
| --- | --- |
| Log lines (JSON/structured logs) | No causal links, no outcome linkage, no confidence accounting; a log is not a ledger |
| Generic metrics/timeseries | Loses the *reasoning* and the option set; can't answer "what were the alternatives?" |
| Relational audit tables | Schema churn with every new agent; no integrity guarantee against a compromised writer |
| LLM self-reporting | The model that made the decision grading its own decision is the failure mode, not the control |

What is needed is a purpose-built record: the decision, its assessed options, the confidence behind the choice, the reasoning, the causal parents it inherited, and — later — the actual outcome. That record must be append-only and verifiable, because an agent that can rewrite its own history is not accountable.

## The solution

`agent-decision-tracker` is a zero-dependency TypeScript library + CLI + HTTP service built around one primitive: a **decision record** linked into a **causal graph** and stored in a **hash-chained journal**.

- **Decisions with full context** — the assessed options and scores, the chosen option, a confidence in `[0,1]` with an explicit basis (`calibrated`, `observed`, `heuristic`, `speculative`), reasoning (summary, assumptions, evidence), tags, and structured context.
- **Causal parents** — every decision can declare its parent decisions, forming a DAG. `attribute` walks the chain behind a decision; `influence` counts what a decision affected downstream.
- **Final outcomes** — one terminal outcome per decision (`success` / `failure` / `partial` / `aborted`), with the actual result, deviations, and metrics. Outcomes close the loop between confidence and reality.
- **Calibration** — buckets decisions by stated confidence and compares stated vs. observed success rates, so "the agent is overconfident in the 80–99% bucket" becomes a measurable claim.
- **Tamper-evident storage** — an append-only JSONL journal where each envelope is hashed over `seq | prevHash | canonical(record)`; `verify` re-hashes every line and reports the file and line number of any tampering.

The causal graph is the part most tools skip, and it is the part that matters: a bad retry policy propagates into every decision that inherited it, and only a linked record can show the blast radius.

## How it works

```
 ┌─────────────┐  record()   ┌──────────────┐  append()   ┌────────────────┐
 │ Decision-    │────────────▶│ Decision-     │────────────▶│ journal.jsonl  │
 │ Tracker      │◀────────────│ graph         │             │ (hash-chained  │
 │ (engine)     │  absorb()   │ decisions,    │             │  JSONL)        │
 │              │             │ outcomes,     │             └────────────────┘
 │ attribute /  │             │ parent index  │                    ▲
 │ influence /  │             └──────────────┘                     │ append-only,
 │ calibration  │                                                  │ seq|prev|hash
 └─────────────┘                                                  ▼
        ▲                                   ┌──────────────────────────────┐
        └──── verify() ────────────────────│  adt CLI / HTTP API (adt serve) │
                                           └──────────────────────────────┘
```

- **Journal** (`src/store.ts`) — JSONL, one envelope per line: `{ seq, prevHash, hash, record }`. `hash = sha256(seq | prevHash | canonicalJson(record))`, where `canonicalJson` sorts object keys recursively so hash verification is key-order independent. The first `prevHash` is `GENESIS`. Writes are append-only (`O_APPEND`), and reopening repositions the append head at the last recorded hash.
- **Engine** (`src/engine.ts`) — validation, id derivation, and the graph. Ids are content-derived (`dec-…`, `out-…`): two identical decision drafts produce the same id, which is how **replays are detected** — recording an identical decision twice is rejected, not double-logged.
- **Attribution** — `attribute(id)` returns the full ancestor chain via BFS with depth and the path taken (`via`); `influence(id)` returns descendant counts and the outcome status tally across the subtree (including the decision's own final outcome).
- **Calibration** — decisions with a scoreable outcome (`success`=1, `partial`=0.5, `failure`=0; `aborted` is excluded) land in confidence buckets `00-19` … `80-99` with observed rate and the signed delta against mean stated confidence.
- **Surfaces** — `adt` CLI, an HTTP API (`adt serve`, bearer-token writes via a constant-time comparison), and a typed library.

## Getting started

**Requirements:** Node >= 18 (or Bun >= 1.1). No runtime dependencies.

The package is installed from GitHub (it is not published to the npm registry):

```bash
npm install github:Retsumdk/agent-decision-tracker
# or: bun add github:Retsumdk/agent-decision-tracker
```

Or clone and run:

```bash
git clone https://github.com/Retsumdk/agent-decision-tracker.git
cd agent-decision-tracker
bun install        # dev dependencies only; the library itself has none
bun test
```

## CLI walkthrough

Every command below is real output from a live run (journal at `.adt/journal.jsonl`).

```console
$ adt record \
    --agent scheduler \
    --task "choose backoff cap for the retry policy" \
    --option cap-30s:0.75 --option cap-300s:0.50 \
    --chosen cap-30s --confidence 0.55 --basis speculative \
    --reason "caps beyond 30s stall the pipeline; guessed" \
    --parent dec-7976f731ca60d7321a1aec53 \
    --tag retries
recorded dec-6337146a5d2aada883e0fe55 (seq 2) — agent=scheduler chosen=cap-30s confidence=0.55

$ adt outcome --decision dec-7976f731ca60d7321a1aec53 \
    --status success --actual "webhook success rate 99.4% after one sprint" \
    --metric success_rate=0.994
outcome out-5748285487509589276afaf5 — decision=dec-7976f731ca60d7321a1aec53 status=success

$ adt attribute dec-6337146a5d2aada883e0fe55
causal chain for dec-6337146a5d2aada883e0fe55:
    -> dec-7976f731ca60d7321a1aec53 (exponential, confidence 0.8)

$ adt show dec-6337146a5d2aada883e0fe55
decision dec-6337146a5d2aada883e0fe55 (seq 2)
  agent:      scheduler
  task:       choose backoff cap for the retry policy
  chosen:     cap-30s (confidence 0.55, speculative)
  options:    cap-30s(0.75), cap-300s(0.5)
  reasoning:  caps beyond 30s stall the pipeline; guessed
  parents:    dec-7976f731ca60d7321a1aec53
  tags:       retries
  outcome:    failure — cap-30s starved slow providers; rolled back to 300s
    deviation: cap was too aggressive for slow providers

$ adt influence dec-7976f731ca60d7321a1aec53
influence of dec-7976f731ca60d7321a1aec53:
  descendants: 1 (1 with outcomes)
  statuses:    success=1 failure=1 partial=0 aborted=0

$ adt calibrate
calibration (2 scored outcomes, aborted excluded):
  bucket   n   mean-conf  observed  delta
  00-19    0          -         -        -
  20-39    0          -         -        -
  40-59    1     0.5500    0.0000  -0.5500
  60-79    0          -         -        -
  80-99    1     0.8000    1.0000  +0.2000
  overall: mean 0.675 vs observed 0.5 (delta -0.175)

$ adt verify
ok: 4 records, hash chain intact
```

Tamper evidence — flip one field in the journal and the chain breaks with a file and line number:

```console
$ # edit journal line 1: change "agentId" to "tampered"
$ adt verify
error: line 1: hash mismatch (record tampered)
$ echo $?
5
```

### Commands and exit codes

| Command | Purpose |
| --- | --- |
| `adt record` | Log a decision (`--agent --task --option label:score[:rationale] --chosen --confidence --basis --reason --assumption --evidence --parent --tag --context key=value --expect-desc --criterion`) |
| `adt outcome` | Record the final outcome (`--decision --status --actual --deviation --metric key=value`) |
| `adt show <id>` | Print one decision with its outcome |
| `adt list` | List decisions (`--agent --tag --limit`) |
| `adt attribute <id>` | Walk the causal chain behind a decision |
| `adt influence <id>` | Count descendants and their outcome statuses |
| `adt calibrate` | Stated confidence vs. observed outcomes |
| `adt stats` | Aggregate counts (JSON) |
| `adt verify` | Re-hash the journal and verify the chain |
| `adt serve` | Serve the HTTP API (`--port`, token via `ADT_TOKEN`) |
| `adt demo` | Run the deterministic demo (`--journal <path>`) |

Exit codes: `0` ok · `2` usage · `3` not found · `4` validation · `5` store error.

## HTTP API

```bash
ADT_TOKEN=<token> adt serve --port 8080
```

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness + journal counts |
| GET | `/stats` | — | Aggregate stats |
| GET | `/calibration` | — | Calibration report |
| GET | `/verify` | — | Journal integrity report |
| GET | `/decisions?agent=&tag=&limit=` | — | List decisions |
| GET | `/decisions/:id` | — | One decision + its outcome |
| GET | `/decisions/:id/attribution` | — | Ancestor chain (`{id, depth, via}` entries) |
| GET | `/decisions/:id/influence` | — | Descendant + outcome tally |
| GET | `/decisions/:id/children` | — | Direct children |
| POST | `/decisions` | Bearer | Record a decision → `201` |
| POST | `/decisions/:id/outcome` | Bearer | Record the final outcome → `201` |

Live probes against a running server (real output):

```console
$ curl -s localhost:8080/health
{"ok":true,"decisions":2,"outcomes":2}
$ curl -s -X POST localhost:8080/decisions -d @decision.json -o /dev/null -w '%{http_code}\n'   # no token
401
$ curl -s -X POST localhost:8080/decisions -H "authorization: Bearer $ADT_TOKEN" \
    -H "content-type: application/json" -d @decision.json -o /dev/null -w '%{http_code}\n'
201
$ # posting the identical body again:
$ curl -s -X POST localhost:8080/decisions -H "authorization: Bearer $ADT_TOKEN" \
    -H "content-type: application/json" -d @decision.json -o /dev/null -w '%{http_code}\n'
409
$ curl -s -X POST localhost:8080/stats -o /dev/null -w '%{http_code}\n'
405
```

Error responses are `{"error": "<code>", "message": "..."}` with codes `unauthorized`, `validation_error`, `not_found`, `replay`, `already_recorded`, `payload_too_large`, `bad_json`, `method_not_allowed`, `unavailable` (writes when `ADT_TOKEN` is unset), `internal`.

## Library usage

```ts
import { DecisionTracker } from "agent-decision-tracker";

const tracker = DecisionTracker.create(".adt/journal.jsonl");

const root = tracker.record({
  agentId: "planner",
  task: "choose retry policy for outbound webhooks",
  options: [
    { option: "exponential", score: 0.82 },
    { option: "fixed", score: 0.45 },
  ],
  chosen: "exponential",
  confidence: 0.8,
  confidenceBasis: "calibrated",
  reasoning: { summary: "tail-heavy failure distribution favors backoff" },
  tags: ["retries"],
});

const child = tracker.record({
  agentId: "scheduler",
  task: "choose backoff cap for the retry policy",
  parents: [root.id],
  options: [{ option: "cap-30s", score: 0.75 }, { option: "cap-300s", score: 0.5 }],
  chosen: "cap-30s",
  confidence: 0.55,
  confidenceBasis: "speculative",
  reasoning: { summary: "caps beyond 30s stall the pipeline; guessed" },
});

tracker.recordOutcome({ decisionId: root.id, status: "success", actual: "99.4% success" });
tracker.recordOutcome({ decisionId: child.id, status: "failure", actual: "starved slow providers" });

tracker.attribute(child.id);   // { decisionId, totalAncestors: 1, chain: [{ id, depth: 1, via: null }], ... }
tracker.calibration();         // buckets + overall stated-vs-observed delta
tracker.stats();               // { decisions, outcomes, agents, byStatus, meanConfidence, ... }
```

Replay protection in action — an identical draft is rejected, not double-logged:

```ts
tracker.record(draft);                              // dec-7976…
tracker.record(draft);                              // ValidationError REPLAY: an identical
                                                    // decision is already recorded
```

Sub-package import for server-only code: `import { startServer } from "agent-decision-tracker/server"`.

## Journal integrity

Each line is an envelope:

```json
{"seq":1,"prevHash":"GENESIS","hash":"9f2a…","record":{ "id":"dec-…", "task":"…", … }}
```

- `hash = sha256(seq | prevHash | canonicalJson(record))` — key-order independent, chain-linked.
- `verify()` / `adt verify` reports every problem with its line number: `sequence gap`, `hash chain mismatch (record tampered or reordered)`, `hash mismatch (record tampered)`, `duplicate record id`.
- Reopening a journal repositions the append head at the last hash; new records extend the same chain.
- Records with a `dec-`/`out-` id but a malformed body are rejected with a store error naming the line, never silently loaded.

## Deterministic demo

`adt demo` (or `bun src/demo.ts`) runs a fixed scenario on a manual clock — two linked decisions, two outcomes, attribution, influence, calibration, verification. Ids are content-derived and the clock is pinned, so output is byte-identical across machines; CI diffs against `demo-output.txt`.

## Design notes & limits

- **Single-process, single-file.** The journal is an append-only file guarded by the caller's deployment, not a distributed log. For multi-writer setups, put `adt serve` in front (writes are serialized by the Node event loop).
- **Content-derived ids.** Ids hash the record's content (not its timestamp), so replays are detectable but legitimately-identical-but-separate decisions need a differing field (a tag or context entry) to coexist.
- **One final outcome per decision.** Re-outcoming a decision is `already_recorded`; superseded decisions should be marked `aborted` with a deviation note, and the replacement decision linked via `parents`.
- **Partial outcomes count half.** Calibration weights `partial` at 0.5; `aborted` is excluded from scoring entirely.
- **HTTP auth is single-token.** `ADT_TOKEN` gates writes with a constant-time comparison; reads are public by design (the journal contains no secrets — keep it that way).

## License

[MIT](LICENSE) — built by [Retsumdk](https://github.com/Retsumdk).
