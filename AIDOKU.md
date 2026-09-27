# The Aidoku sources in Mangayomi

**They do not need porting. They already work, and the catalogue that repo publishes is
already the format the app parses.** Add the repository URL and the seven sources appear:

```
https://raw.githubusercontent.com/postcumer/aidoku-sources/main/sources.json
```

That is the whole install. The rest of this file is the evidence, because "no port
needed" is a claim about an app we do not control and it should not have to be taken on
trust.

## Install

These are manga sources, so it is the manga repository screen:

1. Mangayomi → **Settings** → **Manga extensions repo** (labelled *Manage Manga Repo URLs* on
   the way in)
2. The **+** button, which asks for a **Repo URL**
3. Paste the URL above. The app answers *Source repository added!*
4. The seven sources appear under Manga, flagged NSFW

## Why no port is needed

The chain was traced in the app's own source, not inferred from community examples. Each
link below is a file and line in Mangayomi.

| Step | What happens | Where |
|---|---|---|
| The URL is fetched | `getRepoInfos` tries `index.min.json`, `repo.json`, `index.json`, `index_v2.json`, then the literal URL | `fetch_sources_list.dart` |
| The catalogue is recognised | `jsonMap['sources'] is List` routes to the Aidoku parser | `extension_store_service.dart:186` |
| Entries are read | `downloadURL`/`file`, `iconURL`/`icon`, `languages`/`lang`, `contentRating`/`nsfw`, `baseURL`/`url` | `extension_store_service.dart:234` |
| The source is typed | `sourceCodeLanguage = aidoku`, `itemType = manga` | `extension_store_service.dart:298` |
| The id is derived | `'aidoku-<id>-<lang>'.hashCode.abs()` | `extension_store_service.dart:302` |
| It survives the filter | aidoku and lnreader short-circuit *before* `appMinVerReq` is read | `fetch_sources_list.dart:53-57` |
| It is installed | the `.aix` body is base64-encoded and handed to `AidokuExtensionService` | `fetch_sources_list.dart:168-192` |
| It runs | `AidokuRustRunner` executes the WASM with **wasmi** | `rust_runner.dart` |
| It updates | only when the catalogue version rises | `fetch_sources_list.dart:142-145` |

Two things make this work that are worth stating plainly, because both are the kind of
detail that is easy to assume the other way round:

**Mangayomi has a native Aidoku runner.** The app ships a wasmi-based interpreter for
`.aix` packages, so the seven Rust sources are executed as the WebAssembly they already
are. Nothing is transpiled, wrapped or reimplemented. A port would not be a version of
these sources; it would be seven different programs that happened to scrape the same
sites, with their own bugs and their own update cycle.

**The catalogue is already in the format the app reads.** `postcumer/aidoku-sources/sources.json`
is the Aidoku v0.3 store — `{"name": …, "sources": [{id, name, version, iconURL,
downloadURL, languages, contentRating, baseURL}]}` — and that is the shape
`_parseAidokuJsonStore` consumes. A second catalogue, written for Mangayomi, would install
the *same seven sources under the same derived ids*, because the id comes from the entry's
own `id` and language rather than from the catalogue it arrived in. It would be a copy with
a second thing to keep in sync.

## What was verified, and how

The catalogue was fetched live and the seven packages downloaded and opened:

| Check | Result |
|---|---|
| `sources.json` over HTTPS | 200, seven entries, well-formed |
| Each `downloadURL` | 200, 47–91 KB |
| Each `.aix` is a zip of `Payload/icon.png`, `Payload/main.wasm`, `Payload/source.json` | all seven |
| Each `main.wasm` begins `\0asm` | all seven — real WebAssembly, not a renamed file |
| Each `source.json` parses, and its `info.id` matches the catalogue `id` | all seven |
| Every `downloadURL` and `baseURL` is `https` | all seven — cleartext would fail on iOS |

The last row is why this works on iOS unchanged: App Transport Security refuses cleartext,
and nothing here is cleartext. Sideload the app first — it is not on the App Store — then
add the repository exactly as above.

Two of the seven carry more than one listing, so they arrive as extra filters rather than a
single Latest: one offers Latest and Archive, the other Latest, Raw and Completed.

## What the tests pin

`tests/aidoku-store.test.js` and `tests/aidoku-harness.js` exist because "no port needed"
is only worth anything if something notices when it stops being true. The harness
transcribes `_parseAidokuJsonStore` and the item-type filter from the app's source, and
the suite runs the real catalogue through it — offline, with no device and no request to
any provider.

The interesting part is that the tests were checked for biting rather than passing. Eleven
mutations were applied to the transcribed host behaviour — moving the NSFW threshold,
dropping the `.0.0` from the version, changing the id derivation, removing the icon
fallback, inverting the update comparison — and ten were caught. The suite was extended
until they were.

The eleventh is a genuine redundancy in the host, and is recorded rather than papered over:
the parser hardcodes `appMinVerReq` to `''` **and** the filter short-circuits on Aidoku, so
removing either guard on its own is invisible. Removing both drops all seven sources, and
that mutation is caught. The honest claim is about the pair, not either part of it.

One trap found while building the check, worth recording because it looks like a test
failure and is not: a mutation that renamed a variable declared *later* in the function
throws into the parser's `catch` and returns `null`, which is the same answer the correct
code gives. The mutation is a no-op and the suite is right to ignore it. The check reports
those separately instead of counting them as holes.

## Maintenance

| Change | Symptom | Where |
|---|---|---|
| The catalogue stops being a `sources` list | **All seven vanish at once**, silently — the legacy parsers return nothing rather than erroring | `sources.json` |
| A `downloadURL` 404s | That one source installs and then fails to load | `build.py` output not committed |
| A version is not bumped | A rebuilt `.aix` is never delivered to anyone who already has it | `sources.json` |
| An entry is renamed or its `id` changed | A **new** source appears beside the old one, with its own library and history | `sources.json` |
| The app drops `_parseAidokuJsonStore` | The repository loads and offers nothing | Mangayomi, not us |

The first row is the one that matters. A catalogue that stops parsing does not produce
broken sources; it produces an empty list, and the app's own wording for a repository it
cannot use is *You’ve tried to add an unsupported repository*. If the sources ever
disappear together, that is where to look.
