# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zakariyasync-hash/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zakariyasync-hash/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only, no outside service, no proxy, no git binary. It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4, and MCP tools from a single in-memory store, and registers with the make.fun trial environment the way the [bounty](https://make.fun/bounty/github-core-clone-01) specifies.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The program binds an ephemeral port, `POST`s it to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the trial is over and exits 0. Without `MAKEFUN_ENV_URL` it exits 1 at once. The trial runs `node /bot/main.ts` on Node 22, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http` and its own modules only.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `/<owner>/<repo>.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` | git smart HTTP: v2 advertisement (`ls-refs`, `fetch=shallow`, `object-format=sha1`), v2 fetch with negotiation rounds, shallow/deepen/deepen-relative/deepen-since, v0 fetch and receive-pack with report-status |
| `GET /api/v3/` | API root with `X-OAuth-Scopes`; `/api/v3/meta` reports `installed_version` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, squash merges with conflict detection |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, `node(id:)`, cursor pagination, batched operations, `__type` introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (9 tools), `ping` |

Authentication is a bearer token (`MAKEFUN_SHOP_TOKEN` when set; any non-empty bearer token in local development, so a real git client can clone with the token as its password). The sealed trial scenario's viewer is `adaiversen`; a repository under any other owner is a 404 for this token, never a 403.

## How the git layer works

Objects are stored as raw bytes and round-trip byte-exactly: SHA-1 ids, pkt-line framing, pack v2 reading and writing with OFS/REF delta resolution, and reachability with depth, shallow and unshallow boundaries. A deepen walks through the held tip to the generations below the old shallow boundary — the client's shallow lines cut the have-closure, exactly as git's shallow grafts do — and a relative deepen (`git fetch --deepen=1`) is converted to the absolute depth below the current boundary, the way `upload-pack.c`'s `deepen()` computes it.

## Layout

- `main.ts`: the lifecycle (bind, register, wait for done). Kept as the starter wrote it.
- `app.ts`: the HTTP server and routing.
- `gitcore.ts`: SHA-1 ids, pkt-lines, commit/tree/tag parsing, pack v2 codec, reachability.
- `store.ts`: the in-memory forge state and every domain operation the surfaces share.
- `gitproto.ts`: info/refs, upload-pack v2/v0, receive-pack v0.
- `rest.ts`: REST v3. `graphql.ts`: the GraphQL lexer, parser and executor. `mcp.ts`: the MCP endpoint.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Verification

Local env trial against the kit's sealed suite: **120/120 conformance checks pass**, perf **132/200** (push p50 663.577 ms / 41 pts, clone p50 174.259 ms / 33 pts, read p50 1026.999 ms / 43 pts, write p50 601.783 ms / 15 pts). Real git CLI round-trips (clone v0/v2, push with delta packs, shallow clone and `--deepen=1`, annotated tags, non-fast-forward rejection) pass 26/26, and the REST + GraphQL + MCP smoke suite passes 37/37.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bj9tq8zt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
