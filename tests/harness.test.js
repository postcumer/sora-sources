'use strict';
/*
 * Tests for the test harness.
 *
 * A suite that cannot detect the failure modes it exists to catch is worse than
 * no suite, so the host-parsing functions are checked against the exact inputs
 * they are supposed to reject. These are the assertions that make the provider
 * tests meaningful.
 */

const test = require('./test');
const h = require('./harness');

test('jsValueToString reproduces JSC coercion', () => {
    // These four are the whole reason async modules silently return nothing.
    test.equal(h.jsValueToString([{ a: 1 }]), '[object Object]', 'array of objects');
    test.equal(h.jsValueToString(['a', 'b']), 'a,b', 'array of strings');
    test.equal(h.jsValueToString({ a: 1 }), '[object Object]', 'plain object');
    test.equal(h.jsValueToString(null), 'null', 'null');
});

test('hostParseSearch rejects a resolved array (the async-mode trap)', () => {
    const bad = h.hostParseSearch([{ title: 't', image: 'i', href: 'h' }]);
    test.false(bad.ok, 'an array must NOT be accepted as a search result');
    test.equal(bad.items.length, 0, 'no items extracted');

    const good = h.hostParseSearch(JSON.stringify([{ title: 't', image: 'i', href: 'h' }]));
    test.true(good.ok, 'a JSON string must be accepted');
    test.equal(good.items.length, 1, 'one item extracted');
});

test('hostParseSearch skips malformed rows without failing the batch', () => {
    const res = h.hostParseSearch(JSON.stringify([
        { title: 'ok', image: 'i', href: 'h' },
        { title: 'missing href', image: 'i' },
        { title: 'ok2', image: 'i', href: 'h2' }
    ]));
    test.true(res.ok, 'batch survives');
    test.equal(res.items.length, 2, 'only complete rows survive (compactMap)');
});

test('hostParseSearch rejects non-JSON scalars', () => {
    test.false(h.hostParseSearch(undefined).ok, 'undefined');
    test.false(h.hostParseSearch(null).ok, 'null');
    test.false(h.hostParseSearch('not json at all').ok, 'bare string');
    test.false(h.hostParseSearch(JSON.stringify({ not: 'an array' })).ok, 'object, not array');
});

test('hostParseEpisodes models the async branch (coerce, not drop)', () => {
    // Swift async mode: `number: $0["number"] as? Int ?? 0` — kept and zeroed.
    // Sync mode does Int(numberString) and drops the row entirely.
    const res = h.hostParseEpisodes(JSON.stringify([
        { number: '3', href: '/e/3' },
        { number: 'abc', href: '/e/bad' }
    ]));
    test.true(res.ok, 'parsed');
    test.equal(res.episodes.length, 2, 'async mode keeps the row');
    test.equal(res.episodes[0].number, 3, 'numeric string parsed');
    test.equal(res.episodes[1].number, 0, 'non-numeric coerced to 0');
    test.equal(res.episodes[1].href, '/e/bad', 'the episode is still reachable');
});

test('hostParseStream prefers sources (headers) over bare streams', () => {
    const parsed = h.hostParseStream(JSON.stringify({
        streams: [{ streamUrl: 'https://cdn/a.m3u8', headers: { Referer: 'https://x/' } }],
        subtitles: 'https://cdn/a.vtt'
    }));
    test.equal(parsed.sources.length, 1, 'sources used');
    test.equal(parsed.streams, null, 'streams not also set');

    const options = h.hostStreamOptions(parsed);
    test.equal(options.length, 1, 'one playable option');
    test.deepEqual(options[0].headers, { Referer: 'https://x/' }, 'headers carried through');
    test.equal(options[0].title, 'Stream 1', 'untitled source gets a generated label');
});

test('hostParseStream accepts a single stream object', () => {
    const parsed = h.hostParseStream(JSON.stringify({ stream: { streamUrl: 'https://cdn/b.m3u8' } }));
    test.equal(parsed.sources.length, 1, 'single object wrapped into sources');
    test.equal(h.hostStreamOptions(parsed)[0].url, 'https://cdn/b.m3u8', 'playable');
});

test('hostParseStream falls back to url when streamUrl is absent', () => {
    const parsed = h.hostParseStream(JSON.stringify({ stream: { url: 'https://cdn/c.mp4' } }));
    test.equal(h.hostStreamOptions(parsed)[0].url, 'https://cdn/c.mp4', 'url key honoured');
});

test('hostParseStream keeps a source title when given', () => {
    const parsed = h.hostParseStream(JSON.stringify({
        stream: { streamUrl: 'https://cdn/d.m3u8', title: '  Mirror A  ' }
    }));
    test.equal(h.hostStreamOptions(parsed)[0].title, 'Mirror A', 'title trimmed and used');
});

test('hostParseStream handles the bare-array and bare-URL forms', () => {
    const arr = h.hostParseStream(JSON.stringify(['https://cdn/e.m3u8', 'https://cdn/f.m3u8']));
    test.equal(arr.streams.length, 2, 'bare array of strings');
    test.equal(h.hostStreamOptions(arr).length, 2, 'both playable');

    const bare = h.hostParseStream('https://cdn/g.m3u8');
    test.equal(bare.streams.length, 1, 'bare URL accepted as a single stream');
    // Note this lands in the same branch as a module bug, because Swift
    // JSON.parse fails on a bare URL and falls through to "raw string as URL".
    // A module returning a bare URL is therefore indistinguishable from one
    // returning garbage — a reason to always emit an explicit JSON object.
    test.true(bare.fellBack, 'bare URL goes through the raw-string branch');
});

test('hostParseStream ignores an unknown top-level "sources" key', () => {
    // parseStreamResult only reads `streams` and `stream`. A module that emits
    // `sources` gets nothing, silently. Guarded because it is an easy typo.
    const parsed = h.hostParseStream(JSON.stringify({
        sources: [{ streamUrl: 'https://cdn/ok.m3u8' }]
    }));
    test.equal(parsed.sources, null, 'no sources');
    test.equal(parsed.streams, null, 'no streams');
    test.equal(h.hostStreamOptions(parsed).length, 0, 'nothing playable');
});

test('hostStreamOptions ignores sources with no URL', () => {
    const parsed = h.hostParseStream(JSON.stringify({
        streams: [{ title: 'broken' }, { streamUrl: 'https://cdn/ok.m3u8' }]
    }));
    const options = h.hostStreamOptions(parsed);
    test.equal(options.length, 1, 'entry without a URL is dropped');
    test.equal(options[0].url, 'https://cdn/ok.m3u8', 'the usable one survives');
});

test.run();
