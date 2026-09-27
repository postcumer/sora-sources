# Fixtures

Recorded provider responses, one file per provider. The suite never makes a network request.

## Format

Each fixture is a JSON document whose only required key is `__routes`, mapping an **exact
request URL** to the response the module will see:

```json
{
  "__note": "why these URLs and what they were recorded from",
  "__routes": {
    "https://example.com/api/search?q=test": { "status": 200, "body": "…" },
    "https://example.com/api/search?q=zzz": { "status": 404, "body": "" },
    "https://example.com/api/item/1":      { "transportError": "connection lost" }
  }
}
```

A route is matched on the **full URL including query string**, because that is the level at
which a module makes a real decision. Recording only the bare path would hide bugs in query
construction, which is where the `%s`-substitution and `urlEncode` mistakes live.

### Route fields

| Field | Meaning | Mirrors |
|---|---|---|
| `status` | HTTP status | `res.status` |
| `body` | Response body, verbatim | `res._data` / `.text()` |
| `headers` | Response headers | `res.headers` |
| `transportError` | Simulates a connection failure | `fetchv2` resolving `{error}` |
| `invalidUrl` | Resolves the bare string `"Invalid URL"` | `fetchv2`'s string-resolve bug |
| `undecodable` | 200-shaped with an empty body | undecodable-response branch |

The last three exist because they are the branches community modules get wrong. A fixture for
each is not decoration — they are the cases the code review cannot see.

## What to record

Per provider, enough to exercise the whole pipeline and every documented failure state:

- a search returning several results, and one returning none
- a details page with full metadata, and one with a field missing
- an episode list including one with a **non-numeric number** (sync mode drops it silently)
- a playable source, and a provider that returns a source with no URL
- 403, 429, 500, a transport failure, and a malformed body

## Rules

- **Redact before committing.** Sessions, cookies, tokens, `Set-Cookie` values, and any
  request header carrying a credential are removed. If a recording cannot be cleaned, it does
  not go in the repository (§19, §37).
- **No live minors' content** in fixtures. Use titles and IDs; keep bodies to the minimum that
  makes the test meaningful.
- **Record, then hand-write the expected output** in the test rather than snapshots of the
  module's own output — a snapshot only proves the module is consistent with itself, not that
  it is right.
- Fixtures go stale when a provider changes. That is the point: a failing fixture is the early
  warning that the provider moved, which is far better than an empty search on a user's device.
