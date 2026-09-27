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

**Worked around in this repository, not fixed.** Since `baseUrl` is the only field the download
path reads, the pornmz module sets it to the CDN origin (`https://video.twimg.com`) rather than
the provider's own domain. That does resolve the 403, and it is a genuine workaround rather
than a fix: the value is static, so a CDN migration breaks downloads while playback continues,
and the app now displays the CDN as the module's "Base URL". Details and the reasoning are in
`COMPATIBILITY.md` §6.1.1; the two origins are pinned together by a test so a CDN change fails
the suite rather than reaching a device.

Luna cannot be worked around this way at all — its downloader injects no headers, so no
manifest value helps.

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

## 7. The settings screen can render a menu of options, but nothing can ever produce one

**Where:** `Utlis & Misc/Modules/ModuleSettingsView.swift:189-203` (the consumer) and
`Utlis & Misc/Modules/ModuleSettings.swift:161` (the only producer).

A module's settings screen is the only user-facing surface a module has — Sora builds it from
`const` declarations between `// Settings start` and `// Settings end` in the module script,
renders one control per entry, and writes the user's choice back into that script
(`ModuleManager.swift:266`). So it is worth being precise about what it can render.

`ModuleSetting` carries `options: [String]?`, and `ModuleSettingRow.control` renders it as a
`Menu` of tappable buttons:

```swift
if let options = setting.options, !options.isEmpty {
    Menu {
        ForEach(options, id: \.self) { option in
            Button(option) { setting.value = option }
        }
    } label: { … }
}
```

That is exactly the right control for a module offering a fixed list of choices — a browse
menu of "Latest / Newest / Oldest", for instance. It can never appear.
`getModuleSettings` is the only caller, and the only `ModuleSetting` in the codebase is built
at `ModuleSettings.swift:71` from `parseSettingsSchema`, which hardcodes:

```swift
let entry = ModuleSettingSchemaEntry(
    key: key, type: type, comment: comment,
    defaultValue: defaultValue,
    options: nil            // <-- never populated
)
```

`ModuleSettingSchemaEntry` is `Codable` and has an `options` field that nothing ever decodes
into it, so the wiring was clearly intended and the producer was left unfinished.

**Consequence:** a module can only ever get a `Toggle` or a text field. A fixed set of
options is inexpressible, and the workaround every module is pushed into is to make the user
type a keyword. That is why the pornmz module's browse control is a string setting
(`BROWSE_ORDER = "newest" | "oldest"`) rather than a menu — see `modules/pornmz/README.md` and
`COMPATIBILITY.md` §3.1.1.

**Suggested fix:** parse the trailing `//` comment of a settings line for a delimited option
list, e.g. `const BROWSE_ORDER = "newest"; // newest | oldest`, and pass it through as
`options`. The comment is already parsed and already reaches the UI as a caption, so this
needs no manifest change and no new file.

---

## Observed but not diagnosed

- `PiP failed to start: Failed to start picture in picture.` — repeated throughout a session.
  Luna declares `UIBackgroundModes: [audio]` correctly and contains no PiP call site at all, so
  this comes from Sora. Not investigated further; unrelated to modules.
- `Error loading translations for en: The file couldn't be opened because it isn't in the
  correct format.` — a localisation bundle problem, unrelated to modules.
