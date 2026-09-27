# pornmz — AnymeX / Mangayomi source

A source extension for [AnymeX](https://github.com/RyanYuuki/AnymeX), for pornmz.com.

Same provider as the Sora module in [`../modules/pornmz`](../modules/pornmz), written against
a different contract. The two are separate programs with separate entry points and no shared
loader, so the parsers are deliberately duplicated rather than factored out.

Targets the **JavaScript** extension format, not the Dart one. AnymeX runs both; JavaScript is
the better fit here because it is the format the harness in `../tests/anymex-harness.js` can
actually execute, so this source is tested offline rather than only reasoned about.

## Install

**By repository URL.** [`index.json`](index.json) is an extension catalogue, and
[`repo.json`](repo.json) names the repository, so the source can be added the way the app adds
any other extension repository:

1. AnymeX → **Settings** → **Sources** (the manage-repositories screen for the item type)
2. **Add repository**, and paste
   `https://raw.githubusercontent.com/postcumer/sora-sources/main/anymex/index.json`
3. The app fetches the catalogue, and the source appears in the list.

Point it at a folder instead of the file and it will find the catalogue on its own — the URL
normaliser tries `index.min.json`, `repo.json`, `index.json` and `index_v2.json` in that order
before falling back to the literal URL. Use the full URL so the first attempt succeeds.

**By hand.** The path documented by the extension project
([`CONTRIBUTING-JS.md`](https://github.com/PerryEiji/anymex-extensions/blob/main/CONTRIBUTING-JS.md))
is to add a source directly and paste its code:

1. Open AnymeX → **Extensions** tab → **+**
2. Fill in the fields with the values from the `mangayomiSources` block at the top of
   [`pornmz.js`](pornmz.js):

   | Field | Value |
   |---|---|
   | Name | `Pornmz` |
   | Base URL | `https://pornmz.com` |
   | Lang | `en` |
   | Icon URL | `https://www.google.com/s2/favicons?sz=128&domain=https://pornmz.com` |
   | Type | single |
   | Version | `1.0.0` |
   | Is anime | yes (not manga) |
   | NSFW | yes |
   | ApiUrl | leave empty |

3. Save, then open the source's settings → **edit code**, and paste the whole of
   [`pornmz.js`](pornmz.js) over the template.

Both paths read the same metadata. `index.json` is the same block plus the fields only a
catalogue has, and a test asserts the two agree field by field — so the two installs cannot
drift apart.

### The `id` field, and why it is 2086949404

An `id` is a source's identity, and it has to be **stable**: it is what a reinstall recognises
the source by, and what a device syncing its library matches against. So it cannot be a number
invented per build. The extension project's model derives it when the catalogue omits it:

```dart
id = (json['id'] ??
        (sourceCodeLang == 0
            ? 'mangayomi-"${json['lang']}"."${json['name"]}"'
            : 'mangayomi-js-"${json['lang"]}"."${json["name"]}"'))
    .hashCode;
```

which is Dart's `String.hashCode` — Jenkins one-at-a-time over the UTF-16 code units, masked to
31 bits, with 0 promoted to 1. That is a published algorithm, so it can be reproduced, and
`tests/anymex.test.js` does reproduce it: it re-derives the id from the entry's own `lang` and
`name` and fails if the stored value disagrees. Renaming the source therefore changes the id, and
the suite catches the stale value.

**The id is a convenience, not a dependency.** Omit it and the app derives the same number; omit
it *and* use a name outside this derivation and the database assigns a local auto-increment
instead, which is stable for the life of an install but not across a reinstall. Shipping it means
the source behaves identically to one from the main catalogue, including deduplicating against
another repository that ships the same source — which is the point of deriving it from the name
rather than choosing it.

Worth knowing about the upstream catalogue: only about 43% of its published ids match its own
documented formula, because entries are renamed without being regenerated. A derivation is a
convention here, not a guarantee — so a mismatch is not a load failure, and this test pins *our*
value rather than trying to agree with everyone else's.


## iOS

**This source is already the iOS source.** There is no separate file, and adding one would be a
mistake rather than an improvement — see below.

Mangayomi is one codebase for Android, iOS, macOS, Linux and Windows, and the extension
contract is identical on all of them. Checked in the app's own source rather than assumed:

| Question | Answer | Where |
|---|---|---|
| Does the JavaScript engine build for iOS? | Yes — an Objective-C and a Swift plugin | `flutter_qjs/ios/Classes/` |
| Is JavaScript gated off on iOS? | No — the runtime is chosen by `sourceCodeLanguage` alone | `lib/eval/lib.dart` |
| Does the HTTP bridge work on iOS? | Yes — it is `dart:io` and `MClient`, not a platform plugin | `lib/eval/javascript/http.dart` |
| Do per-stream `headers` reach the player? | Yes — they become media_kit's `httpHeaders`, i.e. mpv's header fields | `anime_player_view.dart` |
| Are the URLs App Transport Security clean? | Yes — every one is `https` | this source |

The last row is why the Referer fix travels: `video.twimg.com` is a third-party CDN, it rejects
a referer from the provider's own domain with a 403, and the stream therefore carries one
derived from the playlist URL's origin. On iOS a missing referer is not a soft failure the way
it is on Android — AVFoundation simply refuses the request — so this matters more there, not
less.

**Why there is deliberately no `pornmz-ios.js`.** A second file would be a different source, not
a variant of one. The catalogue's `id` is derived from the source's `lang` and `name`, so a
renamed copy gets a different id, the app has no way to tell it is the same provider, and the
user ends up with two entries for one site — each with its own history, its own library and its
own settings. The iOS build shares the id, so the app recognises it as the source already
installed and updates it in place.

**Installing on iOS.** Sideload the app first; it is not on the App Store. The project's own
README lists AltStore, SideStore and Feather, and notes that only releases after 0.5.2 are
signed. Then install the source exactly as on any other platform — the repository URL is the
same:

```
https://raw.githubusercontent.com/postcumer/sora-sources/main/anymex/index.json
```

**If it works on Android and not on iOS**, the source is almost certainly not the cause. The
three things that differ are the app build, the sideload's signing, and the player, and the
first two are host-side. A source that loads and lists items is working; a source that lists but
plays nothing is a header or codec question, and the log in the app's extension detail screen
says which.

The `portability` tests in `../tests/anymex.test.js` exist to keep this true. The engine has no
`URL`, no `fetch`, no `TextDecoder`, no `Buffer` and no timers, and the harness supplies nothing
that is missing at runtime — so an edit that reached for one would pass every other test here and
then fail only on a device. Those tests ban the globals an edit would plausibly reach for, and
one asserts the network is touched only through the injected `Client`.

## What it does

| | |
|---|---|
| Popular | The site's own view-count ranking, `?filter=most-viewed` |
| Latest | `?filter=latest` |
| Search | WordPress REST API, paginated, or a listing when a filter is set |
| Filters | The site's four sorts and all 67 of its categories |
| Detail | Description, thumbnail, genres, one chapter per video |
| Video | The HLS master plus its variants and audio renditions, with a Referer |
| Auth | None. No keys, cookies or tokens anywhere in the source. |
| `isNsfw` | `true` — flagged, not disguised |

## The browse choice is better here than it was in Sora

This is the part worth knowing about, because it is the one capability the Sora module had to
fake.

A Sora module cannot own any UI: the engine injects no view, all 17 fields of `ModuleMetadata`
render nothing, and the search screen has no module-driven surface. So the browse choice had to
be a **free-text field** in the module's settings screen, where the user types `popular` and
gets it right only if they spell it as the module expects. It is described in
`../COMPATIBILITY.md` §3.1.1.

AnymeX has native surfaces for exactly this, so the same four sorts and the same 67 categories
arrive as real controls:

| | Sora module | This source |
|---|---|---|
| Browse choice | A text field: `BROWSE_ORDER = "popular"` | The **Popular** button |
| Newest | Type `latest` | The **Latest** button |
| By runtime | Type `longest` | Sort filter → Longest |
| By category | Type `cat:brazzers` | Category filter → Brazzers |

The Sora module also cannot offer a *complete* category list, because it can only describe one
in prose. Here the Category filter is all 67, taken from the site's own REST API.

## The two things that had to be got right

**"Popular" has to mean popular.** An earlier revision of the Sora module asserted this provider
had no popularity signal, on the grounds that the WordPress REST API rejects
`orderby=comment_count` and posts carry no view count. Both statements are true and neither
answers the question: the view counts live in the theme, on the card itself, and
`?filter=most-viewed` is that field sorted descending. Measured live, twenty cards running
629K → 414K → 398K → … → 174K.

So `getPopular` asks the site for its own ranking. It is not the newest posts wearing a
confident label, and it is not an approximation sorted on the source's side.

**The playlist needs a Referer, and the provider's own domain is the wrong one.** The playlist
lives on a third-party CDN which answers **403** to a referer from pornmz.com and **200** to
one from the CDN origin. Without this the source looks perfect and plays nothing. Every stream
therefore carries a `Referer` derived from the playlist URL's own origin:

```js
const origin = (master.match(/^(https?:\/\/[^/?#]+)/i) || [])[1] || this.source.baseUrl;
```

Mangayomi accepts `headers` per stream, which is what makes this expressible here at all. Deriving
it from the URL rather than hardcoding the CDN means a CDN migration cannot silently reintroduce
the failure.

## Page structure the source depends on

A listing page is a run of `<article>` cards:

```html
<article data-main-thumb="https://pornmz.com/wp-content/uploads/2019/10/one.jpg"
         class="thumb-block video-preview-item post-83103" data-post-id="83103">
  <a href="https://pornmz.com/video/id=pm2505492683103" title="Brazzers – Making Assmends">
    <img class="video-main-thumb" src="…one.jpg">
    <span class="duration">37:00</span>
    <span class="title">Brazzers – Making Assmends</span>
    <span class="views"><i class="fa fa-eye"></i> 629K</span>
  </a>
</article>
```

A video page publishes schema.org `VideoObject` microdata:

```html
<meta itemprop="name"          content="Pornmz" />          <!-- the SITE -->
<meta itemprop="name"          content="Wifey Mayalynn…" /> <!-- the VIDEO -->
<meta itemprop="description"   content="… &quot;…&#039;…&quot; …" />
<meta itemprop="thumbnailUrl"  content="…-640x360.jpg" />
<meta itemprop="contentUrl"    content="https://video.twimg.com/…/LPYC0fG2Xdm6ncFL.m3u8" />
<meta itemprop="uploadDate"    content="2026-09-26T20:19:17+01:00" />
```

Four things about that shape are worth knowing before changing a parser:

1. **`itemprop="name"` appears twice** — the site name first, then the video title. Reading the
   first match labels every video "Pornmz". `metaValues` returns a list and `getDetail` takes
   index 1.
2. **The playlist is a demuxed A/V master.** Three `#EXT-X-MEDIA` audio renditions
   (`audio-32000` / `64000` / `128000`) alongside four video variants, wired by `AUDIO=` group
   references. Variants are paired to the audio group they name rather than to the first track
   found.
3. **HLS attribute values are usually unquoted**, and `CODECS` contains commas *inside* quotes.
   Splitting the attribute list on commas would cut that value in half and shift every
   attribute after it, which is why `hlsAttributes` exists rather than a naive split.
4. **The tag block mixes two kinds of link**, told apart by icon: `fa-folder` links are
   categories, `fa-tag` links are content tags ("HD", "Cowgirl"). Only the categories become
   genres; the tags restate them often enough to fill the list with near-duplicates.

## What this source will not do

- **Group videos into series.** A pornmz post is a standalone video, not an episode. The site
  publishes no series or studio listing — its 67 categories are tags, not shows — so `getDetail`
  returns one chapter. Grouping would mean inventing a show per post, which the app would then
  treat as real.
- **Fill in an author.** The page's own `itemprop="author"` is a `Person` scope whose only name
  is the site itself, and performers are published in no machine-readable place. The field is
  empty rather than "Pornmz" or a guess.
- **Paginate the listings.** Verified against the site: `?filter=latest&page=2` returns page one
  again, and `/page/2/?filter=latest` returns nothing. `hasNextPage` is `false` rather than
  optimistic, because a wrong "has more" scrolls the user through an endless page one. **Search
  does paginate**, and follows the API's `x-wp-totalpages` header.
- **Fetch the category list at runtime.** The 67 slugs are in the source so the filter panel is
  populated the instant the source is added, with no request to a host that is slow to answer
  and sometimes does not answer at all.

## Endpoints

All public and unauthenticated.

```
GET https://pornmz.com/?filter={latest|most-viewed|longest|random}
GET https://pornmz.com/pmvideo/c/{category}
GET https://pornmz.com/wp-json/wp/v2/categories?per_page=100     ← full list of 67
GET https://pornmz.com/wp-json/wp/v2/posts?search={kw}&per_page=20&page={n}&_embed=wp:featuredmedia
GET https://pornmz.com/video/id={post}
```

`_embed=wp:featuredmedia` rather than `_embed=1`: the blanket form resolves every embeddable
relation as a server-side sub-request, and this host is slow. Measured 7058 ms vs 2591 ms for
the same 20 rows.

## Speed

This provider's WordPress server is **slow and highly variable** — the same page measured
anywhere from 1.7 s to 18 s across repeated runs. Every choice here is about not asking it for
more than necessary: one relation embedded rather than all of them, one request per listing, and
no request at all for an empty search query or a second page of a listing that has no second
page.

## Maintenance

Things that would break this source, and what the failure would look like:

| Change on the provider's side | Symptom | Where to fix |
|---|---|---|
| Cards stop being `<article>` | Every listing empties; the log says `no cards` | `parseCards` |
| `?filter=` renamed or dropped | The sort filters return nothing; text search still works | `getPopular`, `getLatestUpdates`, `getFilterList` |
| Categories move off `/pmvideo/c/` | Every category filter returns nothing | the two URLs in `search` |
| `itemprop` names changed | `getVideoList` offers nothing | `metaText` |
| The tag block changes shape | Genres go empty | `parseGenres` |
| A property becomes repeatable | `getDetail`/`getVideoList` throw rather than guess | `metaText` |
| **The CDN moves** | **Playback 403s; the Referer is now wrong** | the `origin` derivation in `getVideoList` |

And two that are ours rather than the provider's:

| Change on our side | Symptom | Where to fix |
|---|---|---|
| The repository or branch is renamed | The catalogue 404s and no source is offered | `sourceCodeUrl` in `index.json` |
| `version` is not bumped | An update is never delivered to anyone who already has the source | both `index.json` and the `mangayomiSources` block — the test compares them |
| The source is renamed | The derived id changes, so it installs as a second source | the `id` in `index.json` — the test re-derives it |


Browsing parses a **theme**, not an API contract, so theme markup can change in ways an API
will not. Both listing shapes and a full video page are recorded as fixtures under
`tests/fixtures/pornmz-anymex/`, so a change fails `node ../tests/run.js` rather than reaching a
user as an empty screen.

**Before replacing the fixtures**, run the suite. The fixtures are real captured responses, so a
regenerated diff shows exactly what the provider changed.
