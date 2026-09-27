# Upstream report: issues found in Sora / Luna / SoraCore

Found while building a module against both apps. Every claim below was read out of the
source, with file and line references, and each one is reproducible from the app's own log.

**Not a criticism of the projects** — the module contract is small and works well. These are
places where a module author is actively misled, or where a module works perfectly in one app
and silently fails in the other.

Revisions this was checked against:

| | |
|---|---|
| SoraCore | `e82c920` ("Fixed Service Settings") — the revision Luna pins |
| Sora | local checkout, `Sulfur.xcodeproj` |
| Luna | local checkout, `Luna.xcodeproj` |

---

## 1. Luna's home screen dies if any single TMDB request fails

**Where:** `Luna/Views/HomeView.swift:473-507`

Seven requests are started with `async let` and then awaited together:

```swift
async let trending = tmdbService.getTrending()
async let popularM = tmdbService.getPopularMovies()
// …five more
let (trendingResult, popularMoviesResult, /* … */) =
    try await (trending, popularM, popularTV, popularA, topRatedM, topRatedTV, topRatedA)
```

One `try await` on all seven, one `catch`. If **any one** endpoint times out, the `catch` at
line 501 sets `errorMessage`, and the home screen is empty with an error — the six that
succeeded are thrown away. Reproduced live: `api.themoviedb.org` unreachable from the test
network (30 s, no response) produces exactly this.

**Why it matters:** the user sees a completely dead app and has no way to tell that one
third-party API is down. The screens a user actually needs — search, the module browser — are
reachable and working; only the landing page is bricked.

**Suggested fix:** await each result independently and treat a failure as an empty section
rather than a screen-level error, e.g.

```swift
async let trending = optionalResult { try await tmdbService.getTrending() }
// …then render whichever sections came back, and only show an error if none did
```

This home screen contains no module code at all, so no module can work around it.

---

## 2. A late `extractEpisodes` result is discarded, not used

**Where:** `SoraCore/Sources/JSLoader/JSController-Details.swift:186-190` (Luna)
and `Sora/Utlis & Misc/JSLoader/JSController-Details.swift:170-180` (Sora)

Both hosts race the episodes promise against a hard 15-second timer:

```swift
let timeoutItem = DispatchWorkItem { [settleEpisodes] in
    Logger.shared.log("extractEpisodes timed out after 15 s", type: "Warning")
    settleEpisodes()
}
DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeoutItem)
```

When the timer fires, `settleEpisodes()` releases the `DispatchGroup`, so `group.notify`
fires and `completion` is called with **no episodes**. If the module's promise then resolves at
16 s, `thenEpisodes` still runs and still populates `episodeLinks` — into a local variable that
nobody reads any more. The work is done and thrown away.

Observed on a real device: two consecutive `Timeout for extractEpisodes` warnings, on videos
that then played correctly once the user opened them.

**Suggested fix:** either let the late result through, or state plainly that it is abandoned.
The current shape makes a module that was about to succeed look like one that failed, and gives
the module no way to tell which happened. Raising the timeout also helps, though the discards
would remain.

---

## 3. `streamAsyncJS` is dead whenever `asyncJS` is true — and hazardous

**Where:** `Sora/Views/MediaInfoView/MediaInfoView.swift:1877-1883` (also 2235/2243, 2600/2608)

```swift
if module.metadata.asyncJS == true {
    jsController.fetchStreamUrlJS(episodeUrl: href, /* URL passed straight to the module */ …)
} else if module.metadata.streamAsyncJS == true {
    jsController.fetchStreamUrlJSSecond(episodeUrl: href, /* host fetches, module gets HTML */ …)
} else {
    jsController.fetchStreamUrl(episodeUrl: href, /* synchronous, module gets HTML */ …)
}
```

`asyncJS` is checked first and gates **search, details and streams together**. So for an async
module, `streamAsyncJS` is never read. The field only means anything for a module whose search
is synchronous but whose streams are not.

Two consequences worth acting on:

- Module authors reasonably read `streamAsyncJS: true` as "streams are async" and set it
  alongside `asyncJS: true`. It does nothing.
- If the two checks were ever reordered, `streamAsyncJS: true` would send the module down the
  **HTML-first** path — `extractStreamUrl(html)` instead of `extractStreamUrl(url)`. For most
  modules that is a silent, total playback failure.

**Suggested fix:** either drop `streamAsyncJS` in favour of one switch, or document that it is
only meaningful when `asyncJS` is false.

---

## 4. The download path ignores per-source headers, so module streams 403

**Where:** `Sora/Views/MediaInfoView/MediaInfoView.swift:2392-2423` (`generateDownloadHeaders`)
and Luna's downloader.

Sora's `generateDownloadHeaders` builds headers entirely from `module.metadata.baseUrl`:

```swift
headers = [
    "Origin": module.metadata.baseUrl,
    "Referer": module.metadata.baseUrl,
    …
]
```

The per-source `headers` the module returned from `extractStreamUrl` — the only mechanism
there is for expressing a referer requirement — are never consulted. Luna's downloader goes
further and logs `Using legacy download method for queued download (no module available)`.

**Why it matters:** this is not hypothetical. When a module's video is served from a CDN on a
different host that rejects the module's own domain as a referer, **streaming works and
downloading does not**. Observed end to end:

```
[Download] Download process started for URL: https://video.twimg.com/…/knC5zrMqKpU5cdxM.m3u8
[Download] HTTP 403 for M3U8 request: https://video.twimg.com/…/knC5zrMqKpU5cdxM.m3u8
[Download] Download error: CoreMediaErrorDomain error -12660 - HTTP 403: Forbidden
```

The player is given the same URL with a different `Referer` and plays it fine. So the module is
correct and the download path is the thing dropping the one header that made it work.

**Suggested fix:** thread the resolved source's `headers` through the download request the same
way the player does.

---

## 5. `multiStream` and `multiSubs` are declared and never read

Declared optional in both `ModuleMetadata` (Sora) and `ServiceMetadata` (SoraCore), and
referenced nowhere except a `nil` placeholder in `DownloadView.swift:240`.

Worth removing, or documenting as reserved. A module author will reasonably assume a
`multiStream: false` manifest suppresses an extra server picker; it does not.

---

## 6. Minor: `fetchv2` reports an unusable URL differently in each app

| Host | `URL(string:)` returns nil |
|---|---|
| Sora | resolves the **bare String** `"Invalid URL"` |
| SoraCore (Luna) | resolves `{error: "Invalid URL"}` — an object |

Every other failure shape is identical between the two copies of `setupFetchV2`.

A module must therefore branch on the response *type* before it branches on `.error`, or it
will misread one of the two hosts. This is a small thing, but it is the kind that costs a
module author an afternoon, and aligning the two would remove the footgun entirely.

---

## Observed but not diagnosed

- `PiP failed to start: Failed to start picture in picture.` — repeated throughout a session.
  Luna declares `UIBackgroundModes: [audio]` correctly and contains no PiP call site at all, so
  this comes from Sora. Not investigated further; unrelated to modules.
- `Error loading translations for en: The file couldn't be opened because it isn't in the
  correct format.` — a localisation bundle problem, unrelated to modules.
