# Sora / SoraCore module compatibility reference

Derived by reading the source of:

- `cranci1/Sora` (the app, GPLv3.0 — **the primary target**) — `Sora/Utlis & Misc/JSLoader/*`, `Sora/Utlis & Misc/Extensions/JavaScriptCore+Extensions.swift`, `Sora/Utlis & Misc/Modules/*`, `Sora/Views/MediaInfoView/*`
- `cranci1/SoraCore` (the module engine, custom license) — `Sources/Models/Items.swift`, `Sources/Manager/Services.swift`, `Sources/JSLoader/JSController-{Search,Details,Streams}.swift`
- `cranci1/Luna` (**secondary, paused** — see §0.1) — `Luna/Views/MediaDetailView.swift`, `Luna/Views/View Elements/ServicesResultsSheet.swift`, `Kanzen/KanzenEngine/**`

This is the authoritative contract for these modules. Where a community module, guide, or
this project's own assumptions disagree with this document, the source wins.

---

## 0. Hosts

These modules target **Sora**. The two apps share a module engine, so one module serves both —
but the differences below are the ones that change what a module must emit, and a module cannot
fix either difference from JavaScript.

### 0.1 Target status: Sora primary, Luna paused

**Sora is the target.** Luna is a secondary host at **paused** status, deliberately, after
working against it and finding the remaining gaps are host-side rather than module-side.

Luna's video path does `import SoraCore` and pins it from `main` (rev `e82c920` at time of
writing), so search, details, episodes and stream parsing are SoraCore's — the same contract
derived below. The entry points, the `JSON.stringify` requirement, and the `sources` shape are
identical on both hosts, and a module written for Sora runs on Luna unchanged.

What is *not* fixable from a module:

- **The home screen cannot render.** `HomeView.swift:473-481` awaits seven TMDB calls inside a
  single `try await` with one `catch`; any single failure takes the whole home view down. Luna's
  home content is not a module's to supply in the first place.
- **Downloads carry no headers at all.** There is no equivalent of Sora's
  `generateDownloadHeaders`, so a provider needing a specific `Referer` streams but never
  downloads (§6.1).

Working against Luna further would mean patching the app, not the module, so it is set aside
until that changes. The differences are documented below and in §6.1 so the decision can be
revisited without re-deriving it.

Luna also ships a second, unrelated engine: `Kanzen`, for manga/webtoon. It uses
`extractChapters` and `extractImages` and knows nothing about video, streams or HLS.
**These modules target the SoraCore video path and have nothing to do with Kanzen.**

### 0.2 Where the two hosts differ

| | Sora | Luna |
|---|---|---|
| Search call | `searchResults(keyword)` | `searchResults(keyword, page)` — the extra argument is safely ignored by a one-parameter function |
| Sources | `MediaInfoView.streamOptions(fromSources:)` | `MediaDetailView.parseStreamOptions(streams:sources:)` — same keys, same fallbacks |
| Multi-stream path | entered when `streams.count > 0` | entered only when `streams.count > 1`; a single bare stream instead falls through to `extractSingleStreamURL` |
| **Custom headers** | **replaces** the default set: `if let headers, !headers.isEmpty { use them } else { Referer/Origin = baseUrl }` | **merges over** the defaults: builds `Origin`/`Referer`/`User-Agent` from `baseUrl`, then overrides each key the module supplies |
| **Download headers** | built from `metadata.baseUrl` — see §6.1 | **none at all** |
| Default UA | hardcoded desktop Chrome 134 | `URLSession.randomUserAgent` |
| Empty search query | module not called | module not called |

Two of these are the ones that bite. A module that emits a bare URL gets **the module's own
`baseUrl` as the `Referer`** on both hosts, because neither can invent a better one; and
`baseUrl` is the only lever the *download* path exposes, since the per-source headers that fix
playback are never consulted there. For a provider whose media lives on a third-party CDN, that
referer is rejected outright — see §6.1, which is a real bug this repository hit and fixed.

Emitting `sources` with an explicit `headers` object is correct on both hosts: Sora uses it
in place of its defaults, Luna merges it over its own.

---

## 1. Runtime

| Property | Value | Source |
|---|---|---|
| JS engine | **JavaScriptCore** (`JSContext`) | `Sora/.../JSLoader/JSController.swift` |
| DOM available | **No.** No `window`, `document`, `localStorage` | engine is a bare `JSContext` |
| Node available | **No.** No `require`, `fs`, `process` | same |
| One context per script | Yes — `loadScript` rebuilds the `JSContext` each time | `JSController.loadScript` |
| Module type | `typealias Module = ScrapingModule`, declared in **SoraCore**, not in the app | `JSController.swift:14` |

`loadScript(_:)` creates a fresh context and re-runs `setupJavaScriptEnvironment()`, so a
module may not rely on state surviving a reload. **Modules must be re-runnable and stateless
across loads** — module-level caches that assume a single lifetime are a leak, not an
optimisation.

---

## 2. Injected globals

Everything below is injected by `setupJavaScriptEnvironment()` and is available to every module.

### 2.1 Networking

**`fetchv2(url, headers = {}, method = "GET", body = null, redirect = true, encoding)`**
Returns a **Promise** resolving to a **response object**, *not* a string.

```
{ status: Number, headers: {String:String}, _data: String,
  text(): Promise<String>, json(): Promise<Object> }
```

**This is the trap that most community modules get wrong.** The object returned by `fetchv2`
is not text, and it is not a plain `Response`. Call `.text()` or `.json()`.

Critically, **`fetchv2` resolves on failure rather than rejecting.** Inspect the Swift source
(`JavaScriptCore+Extensions.swift`, `setupFetchV2`): every failure path calls `callResolve`
with a dictionary that has an `error` key and **no `status`**:

| Condition | Sora resolves with | Luna (SoraCore) resolves with |
|---|---|---|
| `URL(string:)` returned nil | the bare **string** `"Invalid URL"` (not an object) | `{error: "Invalid URL"}` — an object |
| transport failure | `{error: "<localizedDescription>"}` | same |
| no data | `{error: "No data"}` | same |
| body > 10 MB | `{error: "Response exceeds maximum size"}` | same |
| decode failed under all encodings | `{status, headers, body: ""}` — a **200-shaped** result with an empty body | same |
| GET with a non-empty body | the bare string `"GET request must not have a body"` | same |

**The two hosts differ on exactly one case: an unusable URL.** Sora resolves the bare string
`"Invalid URL"`; SoraCore resolves `{error: "Invalid URL"}`. This was verified by reading both
copies of `setupFetchV2`, not inferred — an earlier revision of this file documented only the
string form, which would have been wrong for Luna. A module must therefore branch on the
*type* before it branches on `error`, or it will miss one host.

Consequences a module must respect:

- Test `typeof res === "string"` **first**, then `res.error`, and only then `res.status`. In that
  order the same code is correct on both hosts.
- An empty `body` with a valid `status` is a *successful empty response*, not a network error.
  Distinguish it (§8).
- An empty `body` with a valid `status` is a *successful empty response*, not a network error.
  Distinguish it (§8).
- `res.json()` **rejects** on malformed JSON (`Promise.reject("JSON parse error: ...")`), it does
  not throw synchronously and it does not return a rejected value in the body. Await it.
- `encoding` accepts `utf-8`, `windows-1251`, `windows-1252`, `iso-8859-1`, `ascii`, `utf-16`.
  Anything else logs a warning and silently falls back to UTF-8.
- Default `redirect = true`.

**`fetch(url, headers)`** (from `setupNativeFetch`) also exists and returns a **Promise of a
plain String**. It is the older, blunter API: it sends no method, no body, no redirect
control, and it does **not** expose the status code. Prefer `fetchv2`; use `fetch` only where
a body string is sufficient and status is irrelevant. Using `fetch` where a 404 must be
distinguished from an empty page is a bug.

**`networkFetch` / `networkFetchSimple` / `networkFetchWithHTML` / `networkFetchFromHTML`…**
These drive a `WKWebView`, inject `navigator.webdriver` masking, auto-click anything
matching a "play" selector, and hook `jwplayer`/`videojs`/XHR/`fetch`. They are browser
automation aimed at sites that gate access.

**These modules do not use them.** They are excluded by the project's own rules: no
anti-bot circumvention (§12), no browser automation (§35), and no need — every provider
here is reachable over plain HTTP. Reach for them only if a provider is genuinely
HTML-execution-bound, and then treat it as a last resort with a comment saying why.

### 2.2 Encoding, logging, HTML

- `btoa(string)` / `atob(string)` — UTF-8 base64 round trip.
- `console.log(msg)`, `console.error(msg)`, `log(msg)` → `Logger.shared.log`. **Only a single
  String argument is accepted**; passing an object logs something useless. Stringify first.
- `getElementsByTag(html, tag)` — inner content of every `<tag>`.
- `getAttribute(html, tag, attr)` — first match of `attr` on `<tag>`.
- `getInnerText(html)`, `stripHtml(html)`, `normalizeWhitespace(str)`.
- `extractBetween(str, start, end)`, `urlEncode`, `urlDecode`, `htmlEntityDecode`.
- `transformResponse(response, fn)`.

These helpers are **regex-based, not a DOM parser** (§13). They are fine for extracting a
field from a well-known fragment. They are not adequate for structural parsing of a whole
document, and relying on them for that is what produces brittle modules.

### 2.3 Other globals

- `extractChapters(href)` — Sora-provided; may return a Promise. The host bridges it with
  `extractChaptersWithCallback`, and **prefers callback-style completion** (see §5).
- `getGenres`, `getRelated`, etc. are **not** part of this contract and must not be assumed.

---

## 3. The manifest

The manifest is a **standalone JSON file referenced by URL**. The user pastes that URL into
Sora, which downloads it, decodes it, then downloads `scriptUrl` and saves the script locally
(`ModuleManager.addModule`). So a module is **two files**: a manifest and a script, both served
over plain HTTPS.

The struct the app actually decodes is `ModuleMetadata` in `Sora/Utlis & Misc/Modules/Modules.swift`
— the app's own copy. SoraCore carries a `ServiceMetadata` that has drifted from it (see the
drift note below). All fields below are **required** (non-optional `let`); the trailing group
is optional with defaults.

```json
{
  "sourceName":  "Example",
  "author":      { "name": "…", "icon": "…" },
  "iconUrl":     "https://…",
  "version":     "1.0.0",
  "language":    "en",
  "baseUrl":     "https://example.com",
  "streamType":  "HLS",
  "quality":     "1080p",
  "searchBaseUrl": "https://example.com/search?q=%s",

  "asyncJS":      true,
  "softsub":      false,
  "type":         "…",
  "novel":        false
}
```

An async module needs only `asyncJS: true`. `streamAsyncJS`, `multiStream` and `multiSubs`
are omitted because nothing reads them — see the field table below.

**Drift note.** The app's `ModuleMetadata` ends with `novel: Bool?`; SoraCore's
`ServiceMetadata` has `settings: Bool?` and **no** `novel`. `JSONDecoder` silently ignores
unknown keys, so shipping a `settings` key satisfies neither and a `novel` key is invisible to
SoraCore. **Ship `novel`**, because the app is what decodes the manifest. Do not ship
`settings`.

| Field | Meaning |
|---|---|
| `searchBaseUrl` | **Must contain the literal `%s`.** The host replaces `%s` with the percent-encoded keyword and fetches the result itself. |
| `asyncJS` | The master switch. `true` → the host calls the module's functions directly and awaits Promises, for **search, details and streams alike**. `false` → the host fetches the HTML itself and calls synchronous functions. |
| `streamAsyncJS` | **Only consulted when `asyncJS` is `false`.** Sora's dispatch is `if asyncJS {…} else if streamAsyncJS {…} else {…}`, so with `asyncJS: true` this field is dead. It exists for a module whose *search* is synchronous but whose *streams* are not. Do not ship it as `true` alongside `asyncJS: true`: it is inert today, and if the two checks were ever reordered it would route the module to the HTML-first path and break playback outright. |
| `softsub` | Whether the module returns baked-in subtitles. |
| `multiStream` / `multiSubs` | **Declared in both apps' models and read by neither.** An earlier revision of this file described a "multi-stream threshold" in the player; no such check exists in Sora or Luna. Harmless to omit, wrong to rely on. |
| `streamType` / `quality` | **Display strings for the module info tile** (`ModuleAdditionSettingsView.swift:132-138`). They are metadata shown to the user, *not* a declaration enforced by the player, and not a guarantee about any stream. |
| `type` | Free-text tile label; `nil` renders as `-`. |

`quality` in the manifest describes the *provider's advertised ceiling*. It must never be
invented (§54). If the module cannot state it honestly, it is better to describe the provider
in the README and leave the tile minimal — but note the field is non-optional, so it must be
present; use the provider's own stated maximum, never a guess.

### 3.1 User-configurable settings

`ModuleManager.writeSettingsToFile` rewrites the module script on disk, substituting saved
overrides into top-level `const` declarations:

```
^(\s*)const\s+KEY\s*=\s*.*?;(.*)$
```

The first saved override whose key matches a `const KEY = …;` line replaces that line, and the
value is emitted as a bare number, `true`/`false`, or a double-quoted string.

This is the **only** settings mechanism, and it constrains how a module may be written:

- A user-tunable value **must** be a top-level `const NAME = …;` ending in a semicolon.
  `let`, `var`, a `const` without a semicolon, or a value built from another expression will
  not be replaced — the override silently does nothing.
- It is a **regex over raw text**, not an AST. The pattern is `.*?;(.*)$` — non-greedy up to
  the first `;`. A `const` initialised with a string containing `;` is cut in half and the
  script becomes syntactically invalid.
- Substitution is **line-anchored**, so an indented `const` inside a function is still
  matched. Nothing stops the host from rewriting a constant the author did not intend to be
  configurable.
- Values are re-emitted with only `\` and `"` escaped. A newline or `${` in a user-supplied
  value is not escaped.

**Consequence for these modules:** keep configuration constants in one block at the very top
of the file, one per line, each ending in `;`, none containing a `;` inside the value. Never
place a `const` with a semicolon-bearing value elsewhere in the file.

### 3.2 Updates

`refreshModules` re-fetches each manifest and re-downloads the script **only if
`newMetadata.version != module.metadata.version`**. A changed script with an unchanged version
is never delivered to an installed module — the user keeps the old file. Bump `version` on
every behavioural change; treat it as the deployment mechanism, not decoration (§46).

---

## 4. The three JS entry points

Which are called depends on the manifest flags.

| Function | Sync mode | Async mode |
|---|---|---|
| `searchResults` | `(html) => Array` | `(keyword) => Promise` |
| `extractDetails` | `(html) => Array` | `(url) => Promise` |
| `extractEpisodes` | `(html) => Array` | `(url) => Promise` |
| `extractStreamUrl` | `(html) => [String]` | `(url or html) => Promise` |

In sync mode the host performs the HTTP request; the module only parses. In async mode the
module owns the whole request.

### 4.1 Sync-mode return shapes

All three return **plain arrays of plain objects**, synchronously. The host casts to
`[[String: String]]`, so every value must be a string or omitted.

```js
searchResults(html)    → [{ "title": String, "image": String, "href": String }]
extractDetails(html)   → [{ "description": String, "aliases": String, "airdate": String }]
extractEpisodes(html)  → [{ "number": String|Int, "title": String, "href": String, "duration": Int }]
```

`extractDetails` returns an **array**, and Sora maps *all* of its elements into `MediaItem`s.
Returning a single object works, but returning several produces several descriptions in the UI.
One content item per details page → one-element array.

Episode `number` must parse as `Int` in sync mode or the episode is **silently dropped**:
`guard let numberString = ep["number"], let number = Int(numberString), let href = ep["href"]
else { return nil }`. A missing or non-numeric number loses the episode with no error.

`extractStreamUrl` (sync) returns a **string**, which the host parses as JSON:

```json
{ "stream": "https://…" }                                  // single
{ "streams": ["https://…", "https://…"] }                 // several
["https://…", "https://…"]                                 // bare array
"https://…"                                                // bare URL
```

---

## 5. Async mode: resolve with a JSON **string**

This is the single most important and least obvious requirement in the whole contract.

```swift
let jsonString = result.toString()
let array = try JSONSerialization.jsonObject(with: jsonString.data(using: .utf8))
```

The host takes the resolved value, calls `toString()` on it, and parses **that text** as JSON.
It does not bridge the object. A resolved JS array stringifies to comma-joined elements
(`"[object Object],[object Object]"`), which is not JSON and yields zero results with only a
generic log line.

Therefore, in async mode, every entry point must resolve with `JSON.stringify(...)`:

```js
async function searchResults(keyword) {
    return JSON.stringify(rows);        // NOT rows
}
```

The same applies to `extractDetails` and `extractEpisodes` in async mode. `extractStreamUrl` is
already a JSON string in every documented shape, so it is unaffected.

This is why the host prefers callbacks: handing a string back is a lossy, awkward contract,
and `extractChaptersWithCallback` exists in the app specifically to smooth it over.

---

## 6. `sources`: per-server objects with headers

`extractStreamUrl` may return `sources`, an array of objects, to carry per-server headers.
`parseStreamResult` recognises these, in this order:

1. `{ "streams": [ {...}, {...} ] }` → `sources`
2. `{ "stream":  {...} }`             → `sources` (single)
3. `{ "streams": ["url", …] }`         → `streams` (plain URLs, **no headers**)
4. `{ "stream":  "url" }`              → `streams`

Keys read by `MediaInfoView.streamOptions(fromSources:)` (`MediaInfoView.swift:1965`) and by
the download paths (`EpisodeCell.swift:689`, `MediaInfoView.swift:2260`, `:2624`):

| Key | Required | Notes |
|---|---|---|
| `streamUrl` | yes | `url` is accepted as a fallback. Both are read, in that order. |
| `title` | no | Server label. Falls back to `"Stream N"`. **Name the server honestly** — "Server 2 (backup)" not "4K Server". |
| `headers` | no | `{String:String}`. Applied to playback and to the download request. |
| `subtitle` | no | Per-source subtitle URL. Downloads read it; the top-level `subtitles` array is used for the player. |

Top-level `subtitles` is `[String]` or a single string, and is what the player path uses.

**Headers are the only way to express referer/UA requirements** (§19). This is the
Sora-supported structure; there is no other. Cookies belong here only if a provider sets them
anonymously. No personal cookies, no tokens, ever (§37).

### 6.1 Emitting a bare URL means your `baseUrl` becomes the `Referer`

This is the failure mode in §0.2, written up because it cost a real debugging session and is
easy to reintroduce.

When a module resolves a plain URL — form 3 or 4 above — the host has no header information
and supplies its own. On both hosts that default is `Referer: <module baseUrl>` (plus
`Origin`, plus a desktop User-Agent).

If the media is served from a **different host**, that referer is sent to a server that has no
reason to trust it. Twitter's CDN (`video.twimg.com`) answers **403 Forbidden** to
`Referer: https://pornmz.com` and **200** to the same URL with no referer, with a
`twitter.com` referer, or with a referer of its own origin. Chrome's User-Agent and the
`Origin` header are both innocent; the `Referer` alone decides it.

In the app this looks like a module that works perfectly — search, thumbnails, details, a
play button — and then plays nothing, showing a crossed-out play button. Nothing in the UI
points at a header.

**The rule: if a provider serves media from a host other than its own `baseUrl`, emit a
`sources` object with an explicit `Referer`, derived from the media URL's own origin.** Not
hardcoded — derived, so a CDN change cannot silently reintroduce the 403:

```js
var origin = /^(https?:\/\/[^\/?#]+)/i.exec(streamUrl);
return { "Referer": origin ? origin[1] : BASE_URL };
```

This is not circumventing an access control. The media is public and unauthenticated; the
referrer is an ordinary HLS request header, and pointing it at the host actually serving the
bytes is the accurate value rather than a fabricated one.

#### 6.1.1 The download path ignores those headers, so `baseUrl` must be the media origin

Fixing playback is not enough. Sora's downloader builds its request headers from
`module.metadata.baseUrl` and **never reads a source's own headers**, so the `Referer` above is
dropped on the way to disk and the download 403s:

```
Using legacy download method for queued download (no module available)
HTTP 403 for M3U8 request
CoreMediaErrorDomain error -12660
```

Measured against the same playlist: `Referer: https://pornmz.com` → **403**,
`Referer: https://video.twimg.com` → **200**, and the same for a real media segment fetched
from the variant playlist.

**The rule: when the media host is not the provider's own domain, set `baseUrl` to the media
origin.** That is the only module-side lever the download path exposes.

```json
"baseUrl": "https://video.twimg.com"
```

Three consequences worth stating rather than discovering:

- **The app displays this.** The module info tile shows `baseUrl` as "Base URL", so it will
  read as the CDN rather than the site. The provider's own domain still appears in
  `searchBaseUrl` and in every URL the module fetches.
- **`baseUrl` is static; the player's `Referer` is not.** If the provider migrates to another
  CDN, playback keeps working and downloads break. That asymmetry is unavoidable, and a module
  cannot cover both paths.
- **Luna is not fixed by this.** Its downloader injects no headers at all, so no manifest value
  helps (§0.1).

Pin the two origins together in a test so a CDN change fails the suite rather than reaching a
device.

---

## 7. Behaviour the host imposes

- **Episodes have a 15-second timeout** in async mode. `fetchDetailsJS` schedules a
  `DispatchWorkItem` for 15 s; if `extractEpisodes` has not settled, the (empty) result is
  delivered. A module that hangs costs the user 15 s per episode page. Always settle.
- **Streams never time out on their own** and a null/undefined resolve is logged as an error.
- **Any pending `context.exception` poisons the next call.** `preflightContext` and
  `fetchDetailsJS` check `context.exception` *before* invoking the function and bail out
  immediately. A module must not throw at top level during load, or every subsequent call in
  that context fails. `loadScript` itself checks `context.exception` right after evaluation.
- **Every host failure mode returns an empty array, never an error** — `completion([])` for
  search, `completion([], [])` for details, `(nil, nil, nil)` for streams. A module therefore
  **cannot** signal "provider is down" through its return value; only logs distinguish it.
  Log the reason (§52) and return the empty shape. This is the host's design, not something a
  module can change.
- Search items require all three of `title`, `image`, `href` to be non-nil in async mode;
  malformed rows are skipped individually (`compactMap`) rather than failing the batch.

---

## 8. Error taxonomy a module must keep distinct

Because the host collapses everything to an empty array, the distinction exists only in logs
and in control flow. Collapse these and §8/§56 are violated:

1. **Success** — parsed, N results.
2. **Empty result** — provider answered, genuinely had nothing. Return `[]`.
3. **Transport failure** — `res.error` set. Return `[]`, log the error.
4. **HTTP error** — `res.status >= 400`. Distinct from 3: 403 is an access condition, 429 is
   rate limiting, 5xx is the provider being down. Do not retry aggressively; do not mask.
5. **Malformed payload** — status 200, body present, `JSON.parse` or the parser failed.
6. **No playable source** — episodes found, stream resolution yielded nothing. Log distinctly
   from "parser broke".

`fetchv2` makes 3 and 4 easy to conflate, because transport failure resolves with no `status`
while a real error has one. The `res.error`-first check is what separates them.

---

## 9. Rules these modules hold themselves to

Not host requirements — project rules, recorded here so the reason survives.

- No `eval`, no `Function`, no execution of provider JavaScript. Obfuscated payloads are
  decoded with a deterministic function written for that exact provider, isolated in it (§33).
- No DRM, paywall, CAPTCHA, or access-control defeat. If a provider is not openly reachable,
  it is not a candidate (§12, §56).
- No personal cookies, credentials, or tokens in code, logs, or fixtures (§19, §37).
- No fabricated metadata. Omit a field rather than guess it (§31, §54).
- No caching of resolved media URLs — they are tokenised and expire (§25).
- Fixtures under `tests/fixtures/<provider>/`; the suite never touches the network (§41).
