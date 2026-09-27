# pornmz

A module for [pornmz.com](https://pornmz.com), for [Sora](https://github.com/cranci1/Sora).

Targets Sora. It also runs on Luna's SoraCore video path — the same engine, the same four entry
points — but Luna is **not** a supported target right now; see `../../COMPATIBILITY.md` §0.

## What it does

| | |
|---|---|
| Search | WordPress REST API, one request |
| Browse | Type `latest` or `oldest` — see *Browsing* below |
| Episodes | One post = one standalone video |
| Sources | The HLS playlist published in the page's own microdata |
| Quality | Up to 1080p (measured — see below) |
| Auth | None. No keys, cookies or tokens anywhere in the module. |
| asyncJS | `true` |

## Browsing

Search for a keyword and the module returns a listing instead of matching text:

| Type this | You get |
|---|---|
| `latest`, `newest`, `new`, `recent`, `recently`, `fresh` | The newest posts |
| `oldest`, `old`, `oldest first` | The oldest posts — the archive walked backwards |

One request either way:

```
GET https://pornmz.com/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc&_embed=wp:featuredmedia
GET https://pornmz.com/wp-json/wp/v2/posts?per_page=20&orderby=date&order=asc&_embed=wp:featuredmedia
```

**There are no on-screen buttons for this, and a module cannot add any.** This is worth being
blunt about, because "no options for home / latest / oldest / popular in Sora" is the symptom of
a platform limit rather than a gap in this module:

- A module is a **script**. The engine injects four functions and takes their return values. It
  has no DOM, no view, and no way to contribute a tab, a chip row, or a segmented control.
  Adding one would mean editing the app, not the module.
- Sora's `ContentView.swift` defines exactly four tabs — Library, Downloads, Settings, Search.
  There is no home tab for a module's front page to fill.
- `SearchView.swift:243` guards on `!searchQuery.isEmpty`, so the module is not even *called*
  until something is typed.

So the user-facing affordance is the search field itself, and the keyword is the option. That
is a workaround for a missing platform feature, not a design preference.

**Only recency words are mapped.** `popular`, `trending`, `top` and `best` deliberately fall
through to a real text search. This is checked rather than assumed — the REST API rejects
`orderby=comment_count` outright (HTTP 400, `Invalid parameter(s): orderby`), posts carry no
view count, and the only orderings it accepts are `date`, `modified`, `id` and `title`. There
is no popularity signal here at all, so answering "popular" with the newest posts would put a
confident label on data that does not mean it. A browse that lies is worse than no browse.

Words are matched **whole**, so `latest milf` is an ordinary search, not a browse.

Measured live: 20 posts, 20 thumbnails, newest first.

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

Three, all public and unauthenticated:

```
GET https://pornmz.com/wp-json/wp/v2/posts?search={kw}&per_page=20&_embed=wp:featuredmedia
GET https://pornmz.com/wp-json/wp/v2/posts?per_page=20&orderby=date&order={asc|desc}&_embed=wp:featuredmedia
GET https://pornmz.com/video/id={post}
```

`_embed=wp:featuredmedia` is what puts the thumbnail in the *search* response
(`_embedded["wp:featuredmedia"][0].source_url`), so a search is a single request
rather than one per result. This is why the module does not need any absolute
URL resolution: `post.link` and `source_url` are already absolute. The
injected `URL` global does not exist in JavaScriptCore, so a module that relied
on `new URL()` would throw on device.

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
| **Video moved to a different CDN** | **Playback still fine; downloads fail 403** | `manifest.json` `baseUrl` — see *Downloads* |

The last row is the asymmetric one. Everything else the module degrades on its own; a CDN
migration shows up in exactly one place, and the test that pins the two origins together will
fail as soon as the playlist fixture is recaptured.

**Before replacing the fixtures**, run the suite (`node ../../tests/run.js`). The
fixtures under `tests/fixtures/pornmz/` are real captured responses, so a
regenerated fixture diff shows exactly what the provider changed.

**The `contentUrl` is tokenised and expires.** The 5-minute page cache (`PAGE_TTL_MS`) is a
deliberate trade — see *Speed* above for the evidence behind it. If streams ever start
failing to play, lower it before looking anywhere else.
