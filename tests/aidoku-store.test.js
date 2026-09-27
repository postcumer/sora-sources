'use strict';
/*
 * Does the Aidoku catalogue work in Mangayomi without being ported?
 *
 * The answer this file pins is yes, and the reason it needs a test at all is
 * that "no port needed" is a claim about a host we do not control. If a future
 * version of the app drops _parseAidokuJsonStore, or the aidoku repo renames a
 * field, this suite is what notices — offline, without a device and without a
 * request to any provider.
 *
 * Run: node tests/aidoku-store.test.js
 */

const test = require('./test');
const h = require('./aidoku-harness');

const catalogue = h.loadCatalogue();
const store = h.parseAidokuJsonStore(h.INDEX_URL, catalogue);
const sources = store.sources;

// --- routing: which parser runs ---------------------------------------------

test('the catalogue is routed to the Aidoku parser, not the legacy one', () => {
    // fetch_sources_list.dart:47 calls fetchStore; extension_store_service.dart:186
    // branches on `jsonMap['sources'] is List`. That single test is what decides
    // whether these are Aidoku sources or something else entirely.
    test.equal(Array.isArray(catalogue.sources), true, 'the catalogue has a sources list');
    test.equal(catalogue.sources.length, 7, 'and it carries all seven sources');
    test.ok(store !== null, 'the Aidoku parser accepted it');
});

test('a catalogue that is not a sources list is refused, not half-parsed', () => {
    // The failure mode worth naming: drop `sources` and the app does not produce
    // seven broken sources, it falls through to the legacy parsers and produces
    // none. An empty list in the app is this, not a stack trace.
    test.equal(h.parseAidokuJsonStore(h.INDEX_URL, { name: 'x' }), null, 'no sources list');
    test.equal(h.parseAidokuJsonStore(h.INDEX_URL, { sources: 'nope' }), null, 'not a list');
    test.equal(h.parseAidokuJsonStore(h.INDEX_URL, []), null, 'not an object');
});

// --- what comes out ---------------------------------------------------------

test('every source is Aidoku and manga', () => {
    for (const src of sources) {
        test.equal(src.sourceCodeLanguage, 4, src.name + ' is SourceCodeLanguage.aidoku');
        test.equal(src.itemType, 0, src.name + ' is ItemType.manga');
    }
});

test('one source per catalogue entry, since each is single-language', () => {
    test.equal(sources.length, catalogue.sources.length, 'no entry was dropped or duplicated');
    catalogue.sources.forEach((entry, i) => {
        test.equal(sources[i].name, entry.name, 'entry ' + i + ' keeps its name');
        test.equal(sources[i].baseUrl, entry.baseURL, 'entry ' + i + ' keeps its baseUrl');
    });
});

test('the repo name is read from the catalogue, not invented', () => {
    test.equal(store.name, catalogue.name, 'the store is named by its own name field');
    test.equal(store.name.endsWith('.json'), false, 'and is not a filename');
});

test('a catalogue with no name falls back rather than throwing', () => {
    const anon = h.parseAidokuJsonStore(h.INDEX_URL, { sources: catalogue.sources });
    test.equal(anon.name, 'Aidoku Sources', 'the default name is used');
    test.equal(anon.sources.length, 7, 'and the sources still parse');
});

test('one malformed entry is skipped, and the rest of the catalogue still loads', () => {
    // :247 `continue`s past an entry that is not an object, rather than
    // throwing and taking the whole store down. The difference matters: a
    // single bad entry in a hand-edited catalogue should cost one source, not
    // all seven, and it should not surface as an empty screen with no reason.
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [
            null,
            'not an object',
            ['an', 'array'],
            { id: 'x.good', name: 'Good', downloadURL: 'https://e/good.aix', languages: ['en'] }
        ]
    });
    test.ok(parsed !== null, 'the store still parsed');
    test.equal(parsed.sources.length, 1, 'only the well-formed entry survived');
    test.equal(parsed.sources[0].name, 'Good', 'and it is the right one');
});

test('an entry with no download URL still appears, rather than vanishing', () => {
    // The parser does not require downloadURL — it falls back to `file`, and
    // then to an empty string. So a source missing both is still *listed*, and
    // only fails when the app tries to install it. Worth pinning: the
    // alternative reading, that it is dropped here, would silently hide it.
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.nourl', name: 'NoUrl', languages: ['en'] }]
    });
    test.equal(parsed.sources.length, 1, 'the entry is not dropped at parse time');
    test.equal(parsed.sources[0].sourceCodeUrl, '', 'it carries an empty download URL');
    test.equal(parsed.sources[0].name, 'NoUrl', 'and is still named');
});

test('an entry with no name falls back to its id', () => {
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.noname', downloadURL: 'https://e/x.aix', languages: ['en'] }]
    });
    test.equal(parsed.sources[0].name, 'x.noname', 'the id is used as the name');
});

test('a single-language entry can be written as lang rather than languages', () => {
    // Both spellings reach the same place; `languages` is a list, `lang` is the
    // single-value form, and the parser wraps the latter.
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [
            { id: 'x.a', name: 'A', downloadURL: 'https://e/a.aix', languages: ['en'] },
            { id: 'x.b', name: 'B', downloadURL: 'https://e/b.aix', lang: 'es' }
        ]
    });
    test.equal(parsed.sources.length, 2, 'both entries load');
    test.equal(parsed.sources[0].lang, 'en', 'languages form');
    test.equal(parsed.sources[1].lang, 'es', 'lang form');
});

test('an entry with neither spelling defaults to all', () => {
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.nolang', name: 'NoLang', downloadURL: 'https://e/x.aix' }]
    });
    test.equal(parsed.sources[0].lang, 'all', 'the default is all');
});

// --- the version string -----------------------------------------------------

test('the version becomes <n>.0.0, which is what the update gate compares', () => {
    catalogue.sources.forEach((entry, i) => {
        test.equal(sources[i].version, entry.version + '.0.0', entry.name + ' version');
        test.equal(sources[i].versionLast, entry.version + '.0.0', entry.name + ' versionLast');
    });
});

test('a source with no version still gets a valid one', () => {
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.y', name: 'X', downloadURL: 'https://e/x.aix' }]
    });
    test.equal(parsed.sources[0].version, '1.0.0', 'defaults rather than producing null');
});

test('an unchanged version means a rebuilt package is never delivered', () => {
    // fetch_sources_list.dart:142-145. The Aidoku sources are WASM, so this is
    // the whole update story: no version bump, no update, however good the build.
    const installed = { isAdded: true, version: '4.0.0' };
    const rebuilt = { version: '4.0.0' };
    const bumped = { version: '4.1.0' };
    test.equal(h.shouldUpdate(installed, rebuilt), false, 'same version does not update');
    test.equal(h.shouldUpdate(installed, bumped), true, 'a higher version does');
    test.equal(h.shouldUpdate({ isAdded: false, version: '0.0.1' }, bumped), false,
        'and an unadded source is not updated either');
});

// --- the id -----------------------------------------------------------------

test('the id re-derives from the catalogue id and the language', () => {
    catalogue.sources.forEach((entry, i) => {
        // extension_store_service.dart:302
        const derived = h.dartStringHash('aidoku-' + entry.id + '-' + entry.languages[0]);
        test.equal(sources[i].id, derived, entry.name + ' id re-derives');
    });
});

test('the .abs() in the host derivation is a no-op, so the id is positive', () => {
    // src.id = '...'.hashCode.abs(). hashCode is masked to 0x7fffffff and so is
    // never negative, which makes the .abs() dead code. Pinned because an id
    // that went negative would be a silent, permanent identity change on every
    // install that already has the source.
    for (const src of sources) {
        test.ok(src.id > 0, src.name + ' id is positive, got ' + src.id);
        test.ok(src.id <= 0x7fffffff, src.name + ' id fits in 31 bits');
    }
});

test('every id is distinct, so no two sources collide in the database', () => {
    const seen = new Set(sources.map((s) => s.id));
    test.equal(seen.size, sources.length, 'no two sources share an id');
});

test('a multi-language entry becomes one source per language, each with its own id', () => {
    // The catalogue is all `["en"]` today, so this path is untested by the real
    // file. It is the one place a source count and an entry count legitimately
    // diverge, and a source added to two languages must not collapse into one.
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.multi', name: 'Multi', downloadURL: 'https://e/x.aix', languages: ['en', 'es'] }]
    });
    test.equal(parsed.sources.length, 2, 'one source per language');
    test.equal(parsed.sources[0].lang, 'en', 'first language');
    test.equal(parsed.sources[1].lang, 'es', 'second language');
    test.ok(parsed.sources[0].id !== parsed.sources[1].id, 'and the ids differ, so both are kept');
});

// --- the filter that could have dropped them --------------------------------

test('an Aidoku source is never filtered out for being too old', () => {
    // fetch_sources_list.dart:53-57 tests aidoku and lnreader *before* it reads
    // appMinVerReq, so the age check cannot apply; the parser also hardcodes
    // appMinVerReq to '' at :277. The two are redundant, and which one is doing
    // the work was settled by mutation rather than by reading: removing either
    // guard on its own changes nothing for this catalogue, and removing both
    // drops all seven. So the safe statement is about the pair, not either part.
    for (const src of sources) {
        test.equal(src.appMinVerReq, '', src.name + ' declares no minimum app version');
        test.equal(
            h.filterForItemType([src], 0, '0.0.1').length, 1,
            src.name + ' survives even on the oldest app version'
        );
    }
});

test('the age filter still bites for the formats it is written for', () => {
    // Negative control. Without this, filterForItemType could return everything
    // unconditionally and every assertion above would still pass.
    const js = { sourceCodeLanguage: 1, itemType: 0, appMinVerReq: '9.9.9' };
    const old = { sourceCodeLanguage: 1, itemType: 0, appMinVerReq: '' };
    test.equal(h.filterForItemType([js], 0, '1.0.0').length, 0, 'too new a minimum is dropped');
    test.equal(h.filterForItemType([old], 0, '1.0.0').length, 1, 'no minimum is kept');
    test.equal(h.filterForItemType([old], 1, '1.0.0').length, 0, 'the wrong item type is dropped');
});

test('these are manga sources, so they belong to the manga item type', () => {
    // fetch_sources_list is called once per item type. A source whose itemType
    // does not match the screen being built is not offered there at all.
    test.equal(h.filterForItemType(sources, 0, '1.0.0').length, sources.length, 'all offered for manga');
    test.equal(h.filterForItemType(sources, 1, '1.0.0').length, 0, 'none offered for anime');
    test.equal(h.filterForItemType(sources, 2, '1.0.0').length, 0, 'none offered for novel');
});

// --- the download URL -------------------------------------------------------

test('the download URL survives resolution unchanged, being absolute', () => {
    catalogue.sources.forEach((entry, i) => {
        test.equal(sources[i].sourceCodeUrl, entry.downloadURL, entry.name + ' download URL is untouched');
    });
});

test('every download URL is an https .aix package', () => {
    // The install step base64-encodes the response body (fetch_sources_list.dart:168)
    // and AidokuExtensionService unzips it. A URL that is not https, or that does
    // not end in .aix, fails at install rather than at parse, which is why the
    // shape is checked here and not just assumed.
    for (const src of sources) {
        test.equal(src.sourceCodeUrl.indexOf('https://'), 0, src.name + ' is https');
        test.equal(/\.aix$/.test(src.sourceCodeUrl), true, src.name + ' ends in .aix');
    }
});

test('a relative download URL resolves against the catalogue URL', () => {
    // Not how this catalogue is written, but the host supports it, and getting
    // it wrong would resolve against the wrong base and 404 at install.
    const parsed = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.rel', name: 'Rel', file: 'dist/x.aix' }]
    });
    test.equal(
        parsed.sources[0].sourceCodeUrl,
        'https://raw.githubusercontent.com/postcumer/aidoku-sources/main/dist/x.aix',
        'resolved against the catalogue, not the root'
    );
});

test('the icon URL is absolute too, and has a documented fallback', () => {
    for (const src of sources) {
        test.equal(src.iconUrl.indexOf('https://'), 0, src.name + ' icon is https');
    }
    // :257-258 — with no icon field, the host asks for icons/<id>.png beside the
    // catalogue. This repo ships icons under sources/<name>/res/, so that
    // fallback would 404 here; it is pinned as a fact about the host, not a
    // recommendation.
    const noIcon = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'x.noicon', name: 'NoIcon', downloadURL: 'https://e/x.aix' }]
    });
    test.equal(
        noIcon.sources[0].iconUrl,
        'https://raw.githubusercontent.com/postcumer/aidoku-sources/main/icons/x.noicon.png',
        'falls back to icons/<id>.png'
    );
});

// --- the rating -------------------------------------------------------------

test('contentRating 2 marks every source NSFW, and it is not disguised', () => {
    // extension_store_service.dart:265-268. The catalogue states 2, which is
    // above the line, so all seven are flagged.
    for (const src of sources) {
        test.equal(src.isNsfw, true, src.name + ' is flagged NSFW');
    }
});

test('the two rating spellings are read differently, and the test proves it', () => {
    // contentRating is an int scale where >= 2 is flagged; nsfw is a bool or
    // 0/1 where 1 already means flagged. Reading them with one rule would either
    // hide rated sources or over-flag everything.
    const rated = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'a', name: 'A', downloadURL: 'https://e/a.aix', contentRating: 2 }]
    });
    const one = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'b', name: 'B', downloadURL: 'https://e/b.aix', contentRating: 1 }]
    });
    const flagged = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'c', name: 'C', downloadURL: 'https://e/c.aix', nsfw: true }]
    });
    const clean = h.parseAidokuJsonStore(h.INDEX_URL, {
        sources: [{ id: 'd', name: 'D', downloadURL: 'https://e/d.aix' }]
    });
    test.equal(rated.sources[0].isNsfw, true, 'contentRating 2 is flagged');
    test.equal(one.sources[0].isNsfw, false, 'contentRating 1 is not');
    test.equal(flagged.sources[0].isNsfw, true, 'nsfw true is flagged');
    test.equal(clean.sources[0].isNsfw, false, 'no rating is not flagged');
});

// --- hygiene ----------------------------------------------------------------

test('the catalogue carries no credentials of any kind', () => {
    const text = JSON.stringify(catalogue);
    for (const pattern of [/api[_-]?key/i, /bearer\s/i, /authorization/i, /cookie/i, /password/i, /token\s*[:=]/i]) {
        test.equal(pattern.test(text), false, 'no ' + pattern + ' in the catalogue');
    }
});

test('the install URL is the published catalogue on the main branch', () => {
    test.equal(h.INSTALL_URL.indexOf('https://'), 0, 'https');
    test.includes(h.INSTALL_URL, 'raw.githubusercontent.com', 'served raw by GitHub');
    test.includes(h.INSTALL_URL, '/main/', 'on the main branch');
    test.equal(/\/master\//.test(h.INSTALL_URL), false, 'not a stale branch name');
    test.equal(/\/sources\.json$/.test(h.INSTALL_URL), true, 'and points at sources.json');
});

test('the base URLs are https, since iOS refuses anything else', () => {
    // Same reason the Sora side sends headers: a cleartext URL is a soft failure
    // on Android and a hard one under App Transport Security.
    for (const src of sources) {
        test.equal(src.baseUrl.indexOf('https://'), 0, src.name + ' baseUrl is https');
    }
});

test.run();
