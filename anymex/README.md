# pornmz — AnymeX / Mangayomi source

A source extension for [AnymeX](https://github.com/RyanYuuki/AnymeX), for pornmz.com.

Same provider as the Sora module in [`../modules/pornmz`](../modules/pornmz), written against
a different contract. The two are separate programs with separate entry points and no shared
loader, so the parsers are deliberately duplicated rather than factored out.

Targets the **JavaScript** extension format, not the Dart one. AnymeX runs both; JavaScript is
the better fit here because it is the format the harness in `../tests/anymex-harness.js` can
actually execute, so this source is tested offline rather than only reasoned about.

## Install

The install path documented by the extension project
([`CONTRIBUTING-JS.md`](https://github.com/PerryEiji/anymex-extensions/blob/main/CONTRIBUTING-JS.md))
is to add a source by hand and paste its code:

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

**A repository catalogue is deliberately not shipped.** AnymeX can also load sources from an
`index.json` catalogue, and the format is in the same repository as the sources. It is not
included here because each entry's `id` is a Dart `String.hashCode`, which this environment
cannot reproduce and no test here can verify — an entry with a wrong id silently fails to
dedupe. The model's own default is to derive the id when the field is absent, so adding one is a
small job once it can be checked against a real install.

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

Browsing parses a **theme**, not an API contract, so theme markup can change in ways an API
will not. Both listing shapes and a full video page are recorded as fixtures under
`tests/fixtures/pornmz-anymex/`, so a change fails `node ../tests/run.js` rather than reaching a
user as an empty screen.

**Before replacing the fixtures**, run the suite. The fixtures are real captured responses, so a
regenerated diff shows exactly what the provider changed.
