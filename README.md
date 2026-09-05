# SHAR public monitor

Independent, public, black-box monitoring of https://sharprod.com and https://mcp.sharprod.com/public. Node 24 built-ins only; no package install, production source, private knowledge snapshot, credentials, build, crawl, or deployment access.

The original stabilization light monitor is reused in `scripts/engine.mjs`; its ten fixed requests retain their twelve-attempt transport ceiling. `scripts/monitor.mjs` extends these observations and adds a fixed discovery/RPC checklist.

## Checks and bounds

- Fast: website home, contact/alias, lead GET guard, sitemap, robots, public discovery lineage; MCP home, robots, server card, A2A card, initialize, exact fifteen read-only tools, three deterministic tool calls, Official Registry active/latest and canonical contact/lineage. 17 requests, at most 19 attempts per pass.
- Full: same checks plus the remaining twelve tools, covering all fifteen once. Service and case IDs come from public list/search responses. 29 requests, at most 31 attempts per pass. No website crawl.
- Each request: 15-second timeout, 1 MiB body limit, no redirect following. Failed passes receive one complete confirmation pass, for a maximum of 38 fast / 62 full attempts. Persistent failures return exit code 2 and remain visibly failed in Actions.
- Tool calls use protocol `2026-07-28` transport metadata and require explicit `isError:false`, structured `ok:true`, and frozen public lineage. Initialize verifies the separately supported `2025-11-25` handshake contract.
- MCP discovery requires public cache policy with max-age. Missing A2A cache headers fail without waiver. Website metadata accepts an explicit revalidation/no-cache policy. Media types, canonical contact, tool boundary, and public lineage are validated.
- Full response bodies are not saved in reports. Reports contain check status, public URLs, selected response headers, lineage, and timings.

## Running

```
npm test
node scripts/monitor.mjs fast
node scripts/monitor.mjs full
```

Workflow **SHAR public monitor**, file `public-monitor.yml`, dispatch input `mode`: `fast`, `full`, `fixture-failure`, `fixture-recovery`. Default schedules never select fixtures. Fixtures make no endpoint requests and use separate incident/state markers with an explicit TEST body. For local fixture output only, set `MONITOR_LOCAL_FIXTURE=1`.

Fast schedule: minutes 7, 22, 37, 52 every UTC hour. Full schedule: 03:43 UTC daily. GitHub schedule delivery can be delayed; only an actual `schedule` event proves scheduled execution. Public repositories may have schedules disabled after inactivity; check Actions operational status.

## Incidents and state

Confirmed failure creates **SHAR PUBLIC MONITOR ALERT** with UTC, expected/actual status or protocol, check URL/tool, run link, and last known good. The stable production marker deduplicates recurring failures. Changed failure fingerprints add a comment; recovery adds a comment and closes matching incidents. Fixture runs cannot close production incidents.

A fast success cannot close a full-only failed check it did not exercise. Such incidents remain open until a successful run covers the outstanding checks.

A separate **SHAR PUBLIC MONITOR STATE** issue preserves last known good and run status across clean runners. Its body is updated without repeated comments. A separate TEST state issue serves fixtures. Before the first observed success, last known good is explicitly unknown. The workflow serializes runs; reports remain as public artifacts for 30 days. Issue listing is bounded to 2,000 entries and fails visibly rather than losing dedup state.

The check job has only contents-read. The alert job adds issues-write using the repository `GITHUB_TOKEN`; no PAT or external secrets. No pull-request trigger. Official checkout/setup-node/upload-artifact/download-artifact actions are pinned to commits verified against their official GitHub v4 tag refs on 2026-09-05. Checkout does not persist credentials.

Infrastructure failures before report creation remain failed workflow runs and may prevent an issue notification. GitHub Issues notification delivery also depends on repository watch/subscription settings. This monitor does not prove owner-console, deployment, private analytics, or runtime-image provenance that public endpoints do not expose.
