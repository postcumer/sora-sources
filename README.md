# Sora modules

JavaScript modules for [Sora](https://github.com/cranci1/Sora) (the iOS/macOS media player
published as *Sulfur*). A module teaches Sora how to search a provider, describe a title, list
its episodes, and resolve an episode to a playable stream.

These are modules **for** Sora's module engine. They are not a scraping framework: there is no
`UniversalScraperEngine`, no provider factory, no abstract media layer, and no shared runtime
beyond the single `fetchv2` normaliser.

**Read [`COMPATIBILITY.md`](COMPATIBILITY.md) first.** It is the module contract, derived from
the Sora and SoraCore source rather than from community examples, and it is what every module
here is written against.

---

## Layout

```
modules/<provider>/
    manifest.json   metadata Sora fetches when the module is added
    module.js       the four entry points Sora calls
    README.md       endpoints, provider quirks, maintenance notes
tests/
    harness.js      the Sora runtime, reproduced closely enough to catch real bugs
    fixtures/       recorded provider responses; the suite never touches the network
shared/
    net.js          the fetchv2 normaliser: the canonical, separately tested copy
                    of the helper each module.js inlines
```

Provider directories are self-contained. Reading one module and its README should be enough to
understand the provider end to end. `shared/` holds nothing that is not genuinely common: if a
second module can be written without it, it does not belong there.

**Why `net.js` is duplicated into each module.** Sora evaluates exactly one script per module
(`loadScript`), so there is no `require` and no import — a module *cannot* load a shared file at
runtime. `shared/net.js` is the version that is reviewed and tested on its own; each `module.js`
carries a copy and says so in a comment. It is about 50 lines, and it exists only because the
`fetchv2` failure modes are genuinely identical for every provider.

---

## Installing a module

1. Host `manifest.json` and `module.js` at public HTTPS URLs.
2. In Sora, add the module by pasting the manifest URL.
3. Sora downloads the manifest, then downloads `scriptUrl` and saves the script locally.

Two files, not a folder — the manifest references the script by URL.

**Bump `version` on every change.** Sora re-downloads a script only when the manifest's
`version` changes. A fixed script under an unchanged version is never delivered to anyone who
already has the module installed.

---

## The four entry points

Defined in `module.js`, called by the host:

```js
searchResults(keyword)   → [{ title, image, href }]
extractDetails(url)      → [{ description, aliases, airdate }]
extractEpisodes(url)     → [{ number, title, href, duration }]
extractStreamUrl(url)    → JSON string of { stream | streams, subtitles }
```

In **async mode** (the manifest sets `asyncJS` / `streamAsyncJS`) each returns a Promise and
receives a URL, and the module does its own networking with `fetchv2`.

> **The one thing that silently breaks every async module:** in async mode the host does
> `JSON.parse(result.toString())`. Resolve with `JSON.stringify(rows)`, not `rows`. A resolved
> array stringifies to `"[object Object],[object Object]"`, which is not JSON, and the user
> sees an empty search with no error. `tests/harness.js` reproduces this coercion so the suite
> catches it.

In **sync mode** the host performs the HTTP request and passes HTML in; the module only parses
and returns a plain array synchronously.

---

## Rules

The constraints these modules are written to, and why the short answer is "no":

- **No `eval`, no `Function`, no running provider JavaScript.** Obfuscated payloads get a
  purpose-written decoder inside the provider that needs it.
- **No defeating access controls.** No Cloudflare, age-gate, paywall, or anti-bot workarounds.
  Sora ships `networkFetch`, a WebView that masks `navigator.webdriver` and auto-clicks "play"
  buttons; these modules do not use it. Providers that need it are not candidates.
- **No personal cookies, tokens, or credentials** — not in code, not in logs, not in fixtures.
- **No invented metadata.** A field the provider does not state is omitted, not guessed. An
  "HD" badge is not "1080p".
- **No caching of resolved media URLs.** They are tokenised and expire.
- **Adapters stay inside one provider.** A failure in one module cannot affect another, and
  there is no `if (site === …)` chain.

---

## Tests

```sh
node tests/run.js            # everything
node tests/pornmz.test.js    # one file
```

No dependencies. `tests/harness.js` reproduces the Sora runtime — `fetchv2` with its real
failure shapes, the injected globals, and the host's Swift parsing transcribed — so tests
assert what Sora will actually do with the module's output, not merely that it looks
reasonable.

Every case runs against recorded fixtures in `tests/fixtures/<provider>/`. The suite never
makes a network request, so it does not rot when a provider changes and does not send the
user's IP to an adult site on every run.

Coverage per provider: search, details, episodes, sources, and the error paths — HTTP 200 /
403 / 429 / 500, transport failure, malformed JSON, a 200 that serves HTML instead of JSON, an
empty result set, a post with no thumbnail, and a page publishing no stream.

---

## Status

- **[pornmz.com](modules/pornmz/)** — built and tested.
- **hanime.tv, sxyprn.com, pornhub.com** — assessed, not built, and why:
  [`PROVIDERS.md`](PROVIDERS.md).

---

## Scope

Modules here target providers whose content is lawfully accessible without circumventing
access controls. For adult providers that means publicly reachable, unauthenticated endpoints
only, and no minors' content.
