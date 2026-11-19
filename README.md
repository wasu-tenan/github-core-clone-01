# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wasu-tenan/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wasu-tenan/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, entered in make.fun's
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty
(“Build a GitHub-compatible git forge”). From one process and its own
in-memory store it serves:

- **git smart HTTP** — protocol v0 and v2 (`info/refs`, `ls-refs`, `fetch` with shallow /
  deepen / deepen-relative, `receive-pack` with report-status), pack read/write with
  OFS/REF delta resolution, fast-forward-only ref updates.
- **REST v3** — repositories (create/list/get/patch/delete), branches, git refs, commits,
  contents (get/put/delete with sha checks), labels, issues and comments, pull requests
  (create/list/get/files, squash/merge via `PUT /merge`), pagination via `Link: rel="next"`.
- **GraphQL** — `viewer`, `repository` (fields, issues connection with cursor pagination,
  pull requests), `node(id:)` global ids, introspection (`__type`, `__schema`), and the
  mutations `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`; batched documents answered in order.
- **MCP** — JSON-RPC 2.0 over streamable HTTP: modern `server/discover` plus the legacy
  `initialize` handshake, and tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `get_issue`, `create_pull_request`, `merge_pull_request`, `list_pull_requests` acting on
  the same store as REST and GraphQL.

Everything is Node's standard library — no dependencies, no git binary, no network at
runtime. State is deterministic: timestamps come from a logical clock, never the wall clock,
so two runs over the same scenario leave identical state.

Layout:

- `main.ts` — lifecycle (bind, register, poll `/done`, exit 0)
- `app.ts` — HTTP routing, REST v3, git smart HTTP, GraphQL/MCP endpoints
- `store.ts` — the forge store: repositories, refs, issues, pull requests, merges
- `gitstore.ts` — the git object model: SHA-1 objects, trees, commits, packs and deltas
- `graphql.ts` — a small GraphQL parser/executor for the forge schema
- `mcp.ts` — the MCP JSON-RPC endpoint and tool implementations

## Run it

```sh
MAKEFUN_ENV_URL=<env url> MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the entry↔env lifecycle: it requires `MAKEFUN_ENV_URL`, binds an ephemeral
port, registers it with the env, and serves until the env reports done. The API token is
read from `MAKEFUN_SHOP_TOKEN`; every surface except `/healthz` requires
`Authorization: Bearer <token>`. Needs Node 22 or newer.

## Reproduce

The entry is graded by the competition kit's own conformance suite (120 checks:
git 30, repos 15, issues 15, pulls 20, GraphQL 20, MCP 15, protocol 5). To reproduce
the local result:

1. Download the kit: `curl -sSL "https://make.fun/c/github-core-clone-01/kit" | tar xz`
2. Serve this repository's forge on a loopback port with a test token — a three-line
   throwaway server is enough: import `createApp` from `./app.ts`, call it, and
   `listen` on a port of your choice.
3. From the unpacked kit, run its runner against that server:
   `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token <token> --perf --json`
   Always run against a fresh server process — the suite assumes empty state.
4. Verified locally: **120/120 checks pass** (feature column 600/600, agent column
   200/200, performance column 144–152/200 on a shared VM; estimated total 944–952/1000).

## Notes

- **One store, four surfaces.** `store.ts` holds repositories (git objects + refs),
  issues, pull requests and labels; REST, GraphQL and MCP all read/write it, so ids
  and objects are identical across surfaces.
- **Git protocol.** Hand-written pkt-line/pack code (`gitstore.ts`): SHA-1 object
  model, pack writing without deltas, pack reading with OFS/REF delta resolution.
  Protocol v2 negotiation rounds without `done` are answered with a NAK-only
  acknowledgments section.
- **Determinism.** Wall-clock time is kept out of all state (logical clock: fixed
  epoch plus a per-forge sequence number), so replays match byte-for-byte.
- MIT licensed (see `LICENSE`, SPDX-License-Identifier: MIT).

---

<sub>Entered on [make.fun](https://make.fun/?ref=2mmz0hmg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
