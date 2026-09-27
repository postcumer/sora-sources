# pornmz

A module for [pornmz.com](https://pornmz.com), for [Sora](https://github.com/cranci1/Sora).

Targets Sora. It also runs on Luna's SoraCore video path — the same engine, the same four entry
points — but Luna is **not** a supported target right now; see `../../COMPATIBILITY.md` §0.

## What it does

| | |
|---|---|
| Search | WordPress REST API, one request |
| Browse | All four of the site's own sorts, all 67 categories — see *Browsing* |
| Episodes | One post = one standalone video |
| Sources | The HLS playlist published in the page's own microdata |
| Quality | Up to 1080p (measured — see below) |
| Auth | None. No keys, cookies or tokens anywhere in the module. |
| asyncJS | `true` |

## Browsing

There are two ways in, and they compose: type a keyword for a one-off browse, or pin a listing
once in the settings screen and have the search box browse it from then on.

**Both use the site's own listing pages**, not the REST API. Each of the four sorts is a real
ordering the provider computed, and `?filter=most-viewed` is a real view-count ranking — not the
module sorting an approximation on top of data the site never exposed.

| Sort | URL | What the site does |
|---|---|---|
| Latest | `?filter=latest` | Newest first |
| Popular | `?filter=most-viewed` | The site's own view counts, descending |
| Longest | `?filter=longest` | By runtime |
| Random | `?filter=random` | See the honest note below |

### By keyword

| Type this | You get |
|---|---|
| `latest`, `newest`, `new`, `new videos`, `recent`, `recently`, `fresh`, `newest first` | Newest first |
| `popular`, `most viewed`, `most-viewed`, `top`, `best`, `trending`, `hot`, `most watched` | Most viewed |
| `longest`, `long`, `longest videos` | Longest runtime |
| `random`, `shuffle`, `surprise` | The `?filter=random` listing |
| `cat:<slug>` or `category:<slug>` | That category's listing |

Keywords are matched **whole**, so `latest milf` is an ordinary search rather than a browse.

**`?filter=random` does not appear to randomise.** Three consecutive requests returned
byte-identical pages (identical md5, 55,450 bytes each) — a set that is stable across requests,
and distinct from both `latest` and `most-viewed`, so it is a real listing rather than a
fallthrough. Whether the page is order-randomised and then cached, or is seeded per session,
cannot be told from outside. The keyword is kept because the endpoint is real and the intent is
right; the result may well be the same 20 videos twice. Verified, not assumed, and recorded
here so nobody later reports it as a bug in the module.

### By category

The site has **67 categories**. They live at `/pmvideo/c/{slug}` — *not* `/category/{slug}` —
and use the same card markup as the sorts, so they parse the same way. A category needs the
`cat:` prefix deliberately: the slugs are ordinary words, and a bare-word match would silently
turn a text search into a category listing.

The `/categories` page in the site's own menu only renders **19** of them. The complete list is
in the REST API and is stable:

```
GET https://pornmz.com/wp-json/wp/v2/categories?per_page=100
```

```
amateur anal analmom asian bangbros bdsm best big-ass big-dick big-tits blacked blowjob
brattysis brazzers brother-sister-porn caughtfapping celebrity christmas creampie dadcrush
deep-throat deeper digitalplayground ebony facial fakehostel faketaxi familystrokes
father-daughter-porn freeuse freeusefantasy gangbang hardcore hornypervmom incest
instagram-models interracial latina lesbian massage milf milkyperu missax mofos
mother-daughter-porn mom-son-porn mommysboy momsteachsex mypervyfamily nurumassage onlyfans
orgy pervmom pov puretaboo reality realitykings sexmex sislovesme squirting
stepsiblingscaught sweetsinner taboo teen threesome valentines-day
```

Slugs are normalised rather than pasted: `cat:Big Tits!` becomes `/pmvideo/c/big-tits`.

### The settings screen

**The main way to browse: one setting, set once.** Go to **Settings → Modules → pornmz** and
set `BROWSE_ORDER` to any of the words above, or to `cat:<slug>`. From then on the search box
browses that listing, whatever you type. Set it back to an empty value to return to ordinary
search.

That field is a **real control rendered by the app**, and it is the only kind of control a
module can have (see *Why the control is a text field* below). A value the module does not
recognise is ignored rather than honoured, so a typo leaves normal search working instead of
silently browsing nothing.

### No buttons in the search bar — and no way to add any

"There are no options for home / latest / oldest / popular in Sora" is a platform limit, not a
gap in this module. Verified against the source:

- A module is a **script**. `setupJavaScriptEnvironment()`
  (`JavaScriptCore+Extensions.swift:383-392`) injects `console`, `fetch`, `base64` and some
  string helpers — no DOM, no view, no way to contribute a control.
- All 17 fields of `ModuleMetadata` (`Modules.swift:10-33`) are descriptive or player flags.
  Not one renders anything.
- Sora has no home tab — `ContentView.swift` defines exactly Library, Downloads, Settings,
  Search — and `SearchView.swift:243` guards on `!searchQuery.isEmpty`, so the module is not
  even called until something is typed.
- The only two call sites for `searchResults` in the entire app are `SearchView.swift:269/281`
  and `AniListLibraryMatchView.swift:243`. Both need a keyword.

So every listing is reachable two ways — a typed keyword, or the setting — and the setting is
the one that turns the search box into a browser. `../../COMPATIBILITY.md` §3.1.1 has the full
mechanism and the file references.

### Why the control is a text field and not a list of buttons

`ModuleSettingsView` infers a control type from the literal it finds, and only `true`/`false`
becomes a switch — so the value is a string, and the row is labelled by the `const` name with my
comment underneath as the caption.

There *is* a `Menu`-of-buttons branch in that view (`ModuleSettingsView.swift:189-203`) that
would be exactly right for a browse list of eleven listings. But `parseSettingsSchema` is the
only code that builds those settings and it hardcodes `options: nil` (`ModuleSettings.swift:161`),
so the branch is unreachable. That is a host bug, reported in `../../UPSTREAM-REPORT.md`; it is
the one change that would turn this section from a text field into buttons.

## Downloads

Downloads needed a separate fix from playback, and this is the one part of the module's
correctness that the JavaScript cannot influence.

Sora's download path builds its request headers from `module.metadata.baseUrl` and **never
consults a source's own headers**. The `Referer` that `extractStreamUrl` attaches — which is
what makes playback work at all — is simply dropped. With `baseUrl` left at the provider's own
domain, the CDN answered 403 to the download:

```
Using legacy download method for queued download (no module available)
HTTP 403 for M3U8 request
CoreMediaErrorDomain error -12660
```

So the manifest declares the **CDN origin** instead:

```json
"baseUrl": "https://video.twimg.com"
```

The app's info tile will display this as the module's "Base URL", which is now the CDN rather
than the site. That is the honest value for what this field now means: it is the origin the
player and downloader should claim to be talking to, and the provider's own domain still
appears in `searchBaseUrl` and in every page the module fetches.

**The trade, stated plainly.** This value is static, whereas the player's `Referer` is derived
from the playlist URL at runtime. If the provider moves its video to a different CDN, playback
keeps working and **downloads break** until this field is updated. That asymmetry is
unavoidable — `baseUrl` is the only lever the download path exposes. A test pins the two
origins together (`tests/pornmz.test.js`, *"downloads: the manifest baseUrl is the host the CDN
will answer"*) so a CDN change fails the suite rather than reaching a device.

**Luna is not fixed by this.** Luna's downloader injects no headers at all, so a pornmz video
cannot be downloaded there regardless of what the manifest says. Streaming still works.

## The one bug worth reading about

`extractStreamUrl` does **not** return a bare URL. It returns a `sources` object carrying a
`Referer`, and the reason is a real failure that looked like nothing at all.

The playlist is served from **Twitter's CDN**, not from the provider's domain. Both hosts
default the `Referer` to the module's own `baseUrl` when a source carries no headers — and
`video.twimg.com` answers:

| Request | Result |
|---|---|
| `Referer: https://pornmz.com` | **403 Forbidden** |
| `Referer: https://video.twimg.com` | 200 |
| no `Referer` at all | 200 |
| `Referer: https://twitter.com` | 200 |
| Chrome desktop User-Agent, no referer | 200 |
| `Origin: https://pornmz.com` | 200 |

So the `Referer` alone decides it. In the app this presents as a module that works perfectly —
search results, thumbnails, the details page, a play button — and then plays nothing, showing
a crossed-out play button. The UI never hints at a header.

The fix is to derive the referrer from the playlist URL's own origin rather than hardcoding
`video.twimg.com`, so a CDN change cannot silently reintroduce the failure:

```js
var origin = /^(https?:\/\/[^\/?#]+)/i.exec(streamUrl);
return { "Referer": origin ? origin[1] : BASE_URL };
```

Sora *replaces* its header set with whatever the module supplies. (SoraCore, which Luna also
uses, *merges* the module's headers over its own defaults instead — the same source object is
correct either way.) See `../../COMPATIBILITY.md` §0.2 and §6.1.

This fix covers **playback only**. Downloads are a separate code path with separate rules — see
*Downloads* below.

## Endpoints

All public and unauthenticated. Search and details go through the REST API; browsing uses the
site's own rendered listing pages, because the sorts and the view counts the sorts run on are
not in the API.

```
GET https://pornmz.com/wp-json/wp/v2/posts?search={kw}&per_page=20&_embed=wp:featuredmedia
GET https://pornmz.com/?filter={latest|most-viewed|longest|random}
GET https://pornmz.com/pmvideo/c/{category}
GET https://pornmz.com/wp-json/wp/v2/categories?per_page=100     ← full list of 67
GET https://pornmz.com/video/id={post}
```

`_embed=wp:featuredmedia` is what puts the thumbnail in the *search* response
(`_embedded["wp:featuredmedia"][0].source_url`), so a search is a single request
rather than one per result. This is why the module does not need any absolute
URL resolution: `post.link` and `source_url` are already absolute. The
injected `URL` global does not exist in JavaScriptCore, so a module that relied
on `new URL()` would throw on device.

**A correction kept in the module, so it is not repeated.** An earlier revision of this README
claimed the provider had no popularity signal, because the REST API rejects
`orderby=comment_count` and posts carry no view count. Both statements are true and neither
answers the question — the view counts live in the theme, not in the REST payload, and
`?filter=most-viewed` is that field sorted descending. Checking the API and concluding the
provider had no popularity data was the wrong inference. It is spelled out at the top of
`module.js` for the same reason.

## Page structure the module depends on

The video page publishes schema.org `VideoObject` microdata:

```html
<meta itemprop="name"        content="Pornmz" />          <!-- the SITE -->
<meta itemprop="name"        content="Wifey Mayalynn…" /> <!-- the VIDEO -->
<meta itemprop="description" content="… &quot;…&#039;…&quot; …" />
<meta itemprop="duration"    content="P0DT0H46M0S" />
<meta itemprop="thumbnailUrl" content="…-640x360.jpg" />
<meta itemprop="contentUrl"  content="https://video.twimg.com/…/LPYC0fG2Xdm6ncFL.m3u8" />
<meta itemprop="uploadDate"  content="2026-09-26T20:19:17+01:00" />
```

Three things about this shape are worth knowing before changing the parser:

1. **`itemprop="name"` appears twice** — the site name first, then the video
   title. Anything that reads "the first `itemprop=name`" labels every video
   "Pornmz". The module therefore never reads `name` at all: the host already
   holds the title from the search response, and `MediaItem` does not want it.

2. **The `contentUrl` is a real, directly playable HLS master playlist.** The
   playlist is a plain multi-bitrate variant list with no `EXT-X-KEY` tags —
   unencrypted, nothing to decrypt, no DRM handling. The page also embeds an
   `<iframe>` third-party player; the module deliberately never touches it,
   because the playable URL is already published in the open. Scraping the
   embed would be strictly more fragile for no benefit.

3. **A value may legitimately repeat.** The page is microdata, so a property
   like `actor` is one `<meta>` per person while `contentUrl` is published once.
   `META_REPEATS` records which properties are single-valued, and `metaContent`
   refuses (returns nothing and logs) if a single-valued property ever appears
   more than once — a wrong stream that looks valid is worse than no stream.

The published playlist is a **demuxed A/V master**: three `#EXT-X-MEDIA` audio renditions
(`audio-32000`, `audio-64000`, `audio-128000`) alongside four `EXT-X-STREAM-INF` video
variants, wired together by `AUDIO=` group references, with root-relative variant URIs. Both
hosts' players follow this without help, so the module passes the master through untouched
rather than trying to pick or pin a variant.

## Speed

This provider's WordPress server is **slow and highly variable** — the same page
request measured anywhere from 1.7 s to 18 s across repeated runs. Every design choice
here is about not asking it for more than necessary.

**Search embeds one relation, not all of them.** `&_embed=wp:featuredmedia` instead of
`&_embed=1`. Blanket `_embed` resolves every embeddable relation — author, terms,
featured media — and this server pays for each as an internal sub-request. Measured over
three runs each:

| Request | Median | Thumbnails |
|---|---|---|
| `per_page=20&_embed=1` | **7058 ms** | 20/20 |
| `per_page=20&_embed=wp:featuredmedia` | **2591 ms** | 20/20 |

Identical rows, 2.7× faster. The other two relations were pure latency, and load on
someone else's server.

**The page is fetched once, not three times.** The host dispatches `extractDetails` and
`extractEpisodes` concurrently on the same URL and then calls `extractStreamUrl` on it
again, so the in-flight promise is memoised. The cache TTL is **5 minutes**, up from 60 s.

**`extractEpisodes` does not wait for the page at all.** The episode list is the URL the
host is already holding — a post is one standalone video — so it resolves immediately and
starts the page fetch without awaiting it. This was a real failure, not a theory: the app
logged `Timeout for extractEpisodes` twice on videos that then played perfectly well. An
entry point that cannot fail should not sit behind the slowest request in the module.

**A dropped connection is retried once.** `get()` asks a second time when `fetchv2`
resolves with a transport fault, which is the one failure that means the request never
reached the provider — the app logged `Network error in fetchV2NativeFunction: The
network connection was lost` mid-search, and the host rendered that as an empty result
list. A status code is *not* retried: 403 and 429 will answer identically, and re-asking
only doubles the wait. One retry, never a loop.

That TTL is a deliberate trade against §25 (do not serve tokenised URLs stale), and it was
resolved with evidence rather than a guess: a playlist URL captured **over an hour**
earlier still returned **200** when re-checked, so the token is far more durable than it
looks. Against that, one extra page fetch before playback is exactly what turns a
two-second wait into a twenty-second blank screen on a server this variable. Five minutes
covers open-details-then-press-play and still refetches on a later revisit.

If playback ever starts failing with a stale-stream error, **this TTL is the first thing to
lower** — drop it to 60 s and re-test.

## Quality

`quality: "Up to 1080p"`, and that number is measured rather than taken from the
site's "HD" branding. Sampling the first eight search results and reading each
master playlist's `RESOLUTION` attributes:

| Ceiling | Titles |
|---|---|
| 1080p | 6 of 8 |
| 720p | 1 of 8 |
| 480p | 1 of 8 |

No playlist advertised above 1080p, and none carried an `EXT-X-KEY` tag. The
label is a *maximum*, matching what the provider actually publishes — it does not
promise that every title reaches it, and the module never reads a resolution at
runtime. It hands over the master playlist and lets the player choose.

An earlier single-video sample showed only a 720p ceiling, which is why the
manifest originally said 720p. That was under-sampling, not a change on the
provider's side — worth remembering if this field is ever revisited.

The module also never reads the `duration` meta: the host discards episode
duration in async mode (`EpisodeLink(…, duration: nil)`), so parsing it would be
work with no observable result.

## Deliberate omissions

- **`streamAsyncJS` is not in the manifest.** An earlier revision shipped
  `asyncJS: true, streamAsyncJS: true`. Reading the host source shows `asyncJS` is the master
  switch — Sora checks it first and routes search, details *and* streams to the Promise path
  (`MediaInfoView.swift:1877-1883`) — and `streamAsyncJS` is only consulted in the `else if`
  branch. With `asyncJS` true it is dead, and if the two checks were ever reordered it would
  send the module down the HTML-first path and break playback outright. Luna never reads
  either flag; it always uses the async path. Removed once the source was checked properly.
- **`aliases` is always empty.** The page's `og:title` is this same title with
  site marketing appended (`"… – Free HD Porn Video – Pornmz"`). That is not an
  alternate name, and writing it into the alias field would surface the site's
  advertising copy in the app. The provider publishes no real alias, so the
  field stays empty rather than being filled with something plausible.
- **No relative-URL resolver, no `pickArray`/`pickString` helpers.** A previous
  revision of `shared/net.js` carried those. Nothing here needs them: the
  provider returns absolute URLs under a single stable field name, and
  speculative helpers for shapes that do not occur are the "generic
  architecture for problems that don't exist" to avoid.
- **No `searchBaseUrl` round-trip.** The manifest carries a valid `%s` URL for
  Sora's own sync search path, but this module is async and builds the query
  itself.

## Maintenance

**`shared/net.js` is duplicated inside `module.js`.** Sora evaluates exactly one
script per module, so a shared file cannot be imported at runtime. `net.js` is
the canonical, separately tested version; `tests/net.test.js` covers it and
`tests/pornmz.test.js` covers the shipped copy. If you change one, change both.

Things that would break this module, and what the failure would look like:

| Change on the provider's side | Symptom | Where to fix |
|---|---|---|
| REST route moved or `search` param renamed | Search logs `HTTP 404` or `not a list`, returns empty | `SEARCH_ENDPOINT` / `searchResults` |
| `itemprop` names changed | `extractStreamUrl` logs `no contentUrl` | `metaContent`, `META_REPEATS` |
| Thumbnail moved out of `_embedded` | Search rows show a blank image | `featuredImage` |
| Attribute quoting changes | `metaContent` finds nothing | the two patterns in `metaContent` |
| **`?filter=` renamed or dropped** | **Every browse word returns nothing; only text search works** | `BROWSE_KEYWORDS` |
| **Cards stop being `<article>`** | **All browsing empties; the log says `no cards`** | `parseCards` |
| **Categories move off `/pmvideo/c/`** | **Every `cat:` browse returns nothing** | `CATEGORY_PATH` |
| **Video moved to a different CDN** | **Playback still fine; downloads fail 403** | `manifest.json` `baseUrl` — see *Downloads* |

The last row is the asymmetric one. Everything else the module degrades on its own and says so
in the log; a CDN migration shows up in exactly one place, and the test that pins the two
origins together will fail as soon as the playlist fixture is recaptured.

Browsing is the fragile half, because it parses a WordPress **theme** rather than an API. Theme
markup can change in a way an API contract will not. The two listing pages are recorded as
fixtures (`tests/fixtures/pornmz/listing.json`, `category.json`) so a change is caught by
`node ../../tests/run.js` rather than by a user seeing an empty search.

**Before replacing the fixtures**, run the suite (`node ../../tests/run.js`). The
fixtures under `tests/fixtures/pornmz/` are real captured responses, so a
regenerated fixture diff shows exactly what the provider changed.

**The `contentUrl` is tokenised and expires.** The 5-minute page cache (`PAGE_TTL_MS`) is a
deliberate trade — see *Speed* above for the evidence behind it. If streams ever start
failing to play, lower it before looking anywhere else.
