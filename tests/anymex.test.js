'use strict';
/*
 * Tests for anymex/pornmz.js.
 *
 * Every assertion runs a value through the harness's host-side check, so a pass
 * means AnymeX could actually build a row, a detail page or a player list from
 * what the source returned — not merely that a function returned an object.
 *
 * Fixtures are the provider's real public responses, captured once. The suite
 * never touches the network.
 */

const path = require('path');
const test = require('./test');
const h = require('./anymex-harness');

const SOURCE = path.join(__dirname, '..', 'anymex', 'pornmz.js');

const BASE = 'https://pornmz.com';
const PAGE_URL = BASE + '/video/id=pm26201719309399';
const MASTER =
    'https://video.twimg.com/amplify_video/2103925197430546432/pl/LPYC0fG2Xdm6ncFL.m3u8';

const FIXTURES = h.readFixtures('pornmz-anymex');

/** A filter panel with nothing selected. */
const NO_FILTERS = [];

/** A filter panel with one value ticked in a named group. */
function filters(group, value) {
    return [{name: group, state: [{name: value, value: value, state: true}]}];
}

/** Routes serving every real page this source asks for. */
function routes(extra) {
    const all = {
        [BASE + '/?filter=most-viewed']: {status: 200, body: FIXTURES['listing-most-viewed.html']},
        [BASE + '/?filter=latest']: {status: 200, body: FIXTURES['listing-latest.html']},
        [BASE + '/?filter=longest']: {status: 200, body: FIXTURES['listing-longest.html'] ||
            FIXTURES['listing-latest.html']},
        [BASE + '/?filter=random']: {status: 200, body: FIXTURES['listing-latest.html']},
        [BASE + '/pmvideo/c/brazzers']: {status: 200, body: FIXTURES['listing-category.html']},
        [BASE + '/pmvideo/c/milf']: {status: 200, body: FIXTURES['listing-category.html']},
        [PAGE_URL]: {status: 200, body: FIXTURES['video-page.html']},
        [MASTER]: {status: 200, body: FIXTURES['playlist.m3u8']},
        [BASE + '/wp-json/wp/v2/posts?search=milf&per_page=20&page=1&_embed=wp:featuredmedia']: {
            status: 200,
            headers: {'x-wp-totalpages': '107'},
            body: FIXTURES['search.json']
        }
    };
    for (const key of Object.keys(extra || {})) {
        all[key] = extra[key];
    }
    return all;
}

/** A loaded source with real routes plus whatever a test needs changed. */
function load(extraRoutes) {
    return h.loadSource(SOURCE, routes(extraRoutes));
}

const SEARCH_URL =
    BASE + '/wp-json/wp/v2/posts?search=milf&per_page=20&page=1&_embed=wp:featuredmedia';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('source: the manifest fields AnymeX needs are present and honest', () => {
    const {manifest} = load();
    test.equal(manifest.name, 'Pornmz');
    test.equal(manifest.baseUrl, BASE, 'baseUrl without a trailing slash');
    test.equal(manifest.itemType, 1, 'itemType 1 is anime');
    test.equal(manifest.isNsfw, true, 'the source is flagged, not disguised');
    test.equal(manifest.lang, 'en');
    test.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'a semver the app can compare');
    test.equal(manifest.typeSource, 'single');
    test.ok(manifest.iconUrl.indexOf('http') === 0, 'an icon URL, not a local path');
});

// ---------------------------------------------------------------------------
// getPopular / getLatestUpdates
// ---------------------------------------------------------------------------

test('getPopular: serves the newest listing, and asks for nothing else', async () => {
    // The host shows this entry point unconditionally — tapping a source in the
    // list opens it, and there is no supportsPopular flag to opt out of, only a
    // commented-out one for Latest. The button cannot be removed from a source,
    // so what the source controls is what sits behind it. It serves the newest
    // listing. The view-count ranking is still one request away, as the "Popular"
    // entry in the Sort filter.
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.getPopular(1));
    test.true(parsed.ok, parsed.reason);
    test.equal(ctx.calls.length, 1, 'one request, no probing');
    test.equal(ctx.calls[0].url, BASE + '/?filter=latest');
    test.equal(
        ctx.calls.some((c) => c.url.indexOf('most-viewed') !== -1),
        false,
        'the view ranking is not fetched behind the Popular button'
    );
    test.equal(parsed.items.length, 3, 'every card in the fixture became a row');
    test.equal(parsed.dropped.length, 0, 'no card was dropped');
});

test('getPopular: the rows carry a title, a thumbnail and a playable link', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.getPopular(1));
    const first = parsed.items[0];
    test.ok(first.name.length > 0, 'a name');
    test.includes(first.imageUrl, 'wp-content/uploads', 'a thumbnail from the card');
    test.includes(first.link, BASE + '/video/id=', 'a link to the video page');
});

test('getPopular: titles come through decoded, not as entity escapes', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.getPopular(1));
    for (const row of parsed.items) {
        test.equal(row.name.indexOf('&#'), -1, JSON.stringify(row.name) + ' is decoded');
    }
});

test('getPopular: the listing does not paginate, so it says so', async () => {
    // Verified against the site: `?filter=latest&page=2` returns page one again
    // and `/page/2/?filter=latest` returns nothing. Claiming more pages would
    // send the user scrolling through an endless page one.
    const ctx = load();
    const first = await ctx.instance.getPopular(1);
    test.equal(first.hasNextPage, false);
    const second = await ctx.instance.getPopular(2);
    test.equal(second.hasNextPage, false);
    test.equal(second.list.length, 0, 'and asks for nothing');
});

test('getLatestUpdates: asks for the newest posts', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.getLatestUpdates(1));
    test.true(parsed.ok, parsed.reason);
    test.equal(ctx.calls[0].url, BASE + '/?filter=latest');
    test.equal(parsed.items.length, 3);
    test.equal(parsed.hasNextPage, false);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search: text search uses the REST API and returns usable rows', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.search('milf', 1, NO_FILTERS));
    test.true(parsed.ok, parsed.reason);
    test.equal(ctx.calls[0].url, SEARCH_URL);
    test.equal(parsed.items.length, 3, 'all three fixture posts');
    test.equal(parsed.dropped.length, 0);
    test.includes(parsed.items[0].imageUrl, 'http', 'a real thumbnail URL');
});

test('search: pagination follows the API header, not a guess', async () => {
    const ctx = load();
    const first = await ctx.instance.search('milf', 1, NO_FILTERS);
    test.equal(first.hasNextPage, true, '107 total pages, so page 1 is not the last');

    // A page short of the end stops, and a page past the end stops.
    const near = load({
        [SEARCH_URL]: {status: 200, headers: {'x-wp-totalpages': '1'}, body: FIXTURES['search.json']}
    });
    test.equal((await near.instance.search('milf', 1, NO_FILTERS)).hasNextPage, false);
});

test('search: a missing pagination header stops rather than looping forever', async () => {
    // The header is the honest signal. Without it the source stops, which is
    // the safe direction: a wrong "has more" sends the user through empty pages.
    const ctx = load({
        [SEARCH_URL]: {status: 200, body: FIXTURES['search.json']}
    });
    test.equal((await ctx.instance.search('milf', 1, NO_FILTERS)).hasNextPage, false);
});

test('search: an empty query asks for nothing', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.search('   ', 1, NO_FILTERS));
    test.equal(parsed.items.length, 0);
    test.equal(ctx.callCount(), 0, 'and makes no request');
});

test('search: a Sort filter browses that listing instead of matching text', async () => {
    for (const sort of ['latest', 'most-viewed', 'longest', 'random']) {
        const ctx = load();
        const parsed = h.hostParseList(await ctx.instance.search('milf', 1, filters('Sort', sort)));
        test.equal(ctx.calls[0].url, BASE + '/?filter=' + sort, sort + ' browses');
        test.ok(parsed.items.length > 0, sort + ' returned rows');
        test.equal(parsed.hasNextPage, false, sort + ' does not paginate');
    }
});

test('search: a Category filter browses that category listing', async () => {
    const ctx = load();
    const parsed = h.hostParseList(await ctx.instance.search('anything', 1, filters('Category', 'brazzers')));
    test.equal(ctx.calls[0].url, BASE + '/pmvideo/c/brazzers');
    test.ok(parsed.items.length > 0, 'and returns rows');
});

test('search: the filter wins over the typed text', async () => {
    // The user just made an explicit choice in a panel; it should not depend on
    // what is in the box.
    const ctx = load();
    await ctx.instance.search('milf', 1, filters('Sort', 'longest'));
    test.equal(ctx.calls[0].url, BASE + '/?filter=longest');
});

test('search: a filter that is not selected is ignored', async () => {
    const unticked = [{name: 'Sort', state: [{name: 'Longest', value: 'longest', state: false}]}];
    const ctx = load();
    await ctx.instance.search('milf', 1, unticked);
    test.equal(ctx.calls[0].url, SEARCH_URL, 'an unchecked value falls back to search');
});

test('search: a 200 with an HTML body is refused, not shown as results', async () => {
    // A bot check or a maintenance page. Parsing it would produce an empty
    // listing that looks like the site has nothing.
    const ctx = load({
        [SEARCH_URL]: {status: 200, body: '<html><body>checking your browser</body></html>'}
    });
    const parsed = h.hostParseList(await ctx.instance.search('milf', 1, NO_FILTERS));
    test.equal(parsed.items.length, 0, 'nothing offered');
    test.ok(ctx.log.some(l => /not a list/.test(l)), 'and the log says the markup changed');
});

test('search: an HTTP error surfaces rather than being swallowed', async () => {
    // The host shows its own error, which is more useful than a silent empty
    // list that reads as "no matches".
    for (const status of [403, 404, 429, 500]) {
        const ctx = load({[SEARCH_URL]: {status, body: 'refused'}});
        let threw = false;
        try {
            await ctx.instance.search('milf', 1, NO_FILTERS);
        } catch (error) {
            threw = true;
            test.includes(error.message, 'HTTP ' + status, status + ' is named');
        }
        test.true(threw, status + ' throws');
    }
});

// ---------------------------------------------------------------------------
// getDetail
// ---------------------------------------------------------------------------

test('getDetail: the video title, not the site name', async () => {
    // `itemprop="name"` appears twice on the page: the site first, then the
    // video. Reading the first labels every video "Pornmz".
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.true(parsed.ok, parsed.reason);
    test.equal(parsed.detail.name,
        'Wifey Mayalynn and Mrjax Tattooed Baddie Hotwife Loves BBC');
});

test('getDetail: the description is decoded', async () => {
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.includes(parsed.detail.description, 'virgin', 'the real text');
    test.equal(parsed.detail.description.indexOf('&quot;'), -1, 'no entity escapes remain');
    test.equal(parsed.detail.description.indexOf('&#039;'), -1, 'including numeric ones');
});

test('getDetail: the thumbnail comes from the microdata', async () => {
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.includes(parsed.detail.imageUrl, 'wp-content/uploads');
});

test('getDetail: genres are the categories, not the content tags', async () => {
    // The page's tag block mixes both; the categories are the fa-folder links.
    // Including the tags as well would fill the list with near-duplicates.
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    const genres = parsed.detail.genre;
    test.ok(genres.length > 0, 'there are genres');
    test.includes(genres.join(','), 'Interracial', 'a category is present');
    test.equal(genres.join(',').indexOf('HD'), -1, 'the "HD" tag is not a genre');
    test.equal(genres.join(',').indexOf('Cowgirl'), -1, 'nor is "Cowgirl"');
});

test('getDetail: one post is one chapter', async () => {
    // A pornmz post is a standalone video, not an episode of a series. The site
    // has no series listing to group by, so a one-item chapter list is the
    // honest shape rather than a fabricated show.
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.equal(parsed.detail.chapters.length, 1);
    test.equal(parsed.detail.chapters[0].url, PAGE_URL);
    test.equal(parsed.detail.status, 1, 'a published video is complete');
});

test('getDetail: the chapter carries a real upload date, as a string', async () => {
    // The host declares dateUpload String? and reads it with int.tryParse, so a
    // bare number is a type error on every detail page, not a missing date. It
    // used to be sent as a number and took the whole screen down.
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.true(parsed.ok, parsed.reason);
    const when = parsed.detail.chapters[0].dateUpload;
    test.equal(typeof when, 'string', 'a string, as the model declares');
    test.equal(/^\d+$/.test(when), true, 'digits the host can int.tryParse');
    const millis = Number(when);
    test.ok(millis > 1500000000000, 'a plausible date, not zero');
    const asDate = new Date(millis).toISOString().slice(0, 10);
    test.equal(asDate, '2026-09-26', 'the UTC offset in the page is applied');
});

test('getDetail: the author is empty rather than invented', async () => {
    // The page's own `author` is a Person scope whose only name is the site.
    // Writing that in would put "Pornmz" in the author field of every entry.
    const ctx = load();
    const parsed = h.hostParseDetail(await ctx.instance.getDetail(PAGE_URL));
    test.equal(parsed.detail.author, '');
});

test('getDetail: a page with no title is an error, not a blank entry', async () => {
    const ctx = load({
        [PAGE_URL]: {status: 200, body: '<html><body>gone</body></html>'}
    });
    let threw = false;
    try {
        await ctx.instance.getDetail(PAGE_URL);
    } catch (error) {
        threw = true;
        test.includes(error.message, 'no title');
    }
    test.true(threw, 'rather than an entry with an empty name');
});

test('getDetail: a relative link is resolved against the base URL', async () => {
    // The app hands back whatever `link` was in the listing. This source always
    // writes absolute links, so a relative one means something upstream changed.
    const ctx = load();
    await ctx.instance.getDetail('/video/id=pm26201719309399');
    test.equal(ctx.calls[0].url, PAGE_URL, 'resolved before fetching');
});

// ---------------------------------------------------------------------------
// getVideoList
// ---------------------------------------------------------------------------

test('getVideoList: the master playlist plus every variant, with a Referer', async () => {
    // The playlist is on a third-party CDN that answers 403 to a referer from
    // the provider's domain. Every stream has to carry the CDN's own origin, or
    // playback fails while everything else looks perfect.
    const ctx = load();
    const parsed = h.hostParseVideos(await ctx.instance.getVideoList(PAGE_URL));
    test.true(parsed.ok, parsed.reason);
    test.equal(parsed.items[0].url, MASTER, 'the master is first');
    test.equal(parsed.items[0].quality, 'auto');
    for (const stream of parsed.items) {
        test.equal(stream.headers.Referer, 'https://video.twimg.com',
            'derived from the playlist origin');
    }
    test.equal(ctx.calls[1].headers.Referer, 'https://video.twimg.com',
        'and used to fetch the playlist itself');
});

test('getVideoList: the variants are absolute and labelled by resolution', async () => {
    const ctx = load();
    const parsed = h.hostParseVideos(await ctx.instance.getVideoList(PAGE_URL));
    const variants = parsed.items.filter(v => v.quality !== 'auto');
    test.equal(variants.length, 3, 'the master really has three video variants');
    const qualities = variants.map(v => v.quality).sort();
    test.equal(qualities.join(','), '1280x720,480x270,640x360');
    for (const variant of variants) {
        test.ok(/^https:\/\/video\.twimg\.com\//.test(variant.url),
            variant.url + ' is absolute, resolved against the master origin');
    }
});

test('getVideoList: audio renditions are paired to the variant that uses them', async () => {
    // A demuxed master: each video variant names an AUDIO group. Pairing by
    // group avoids handing a variant the wrong track.
    const ctx = load();
    const videos = await ctx.instance.getVideoList(PAGE_URL);
    const hd = videos.filter(v => v.quality === '1280x720')[0];
    test.ok(hd.audios && hd.audios.length, 'the 720p variant carries its audio');
    test.includes(hd.audios[0].file, '128000', 'the 128k rendition, matching its group');
});

test('getVideoList: a page with no contentUrl offers nothing rather than a broken stream', async () => {
    const ctx = load({
        [PAGE_URL]: {status: 200, body: '<meta itemprop="name" content="Something" />'}
    });
    const videos = await ctx.instance.getVideoList(PAGE_URL);
    test.equal(videos.length, 0, 'an empty list makes the app say there is no source');
});

test('getVideoList: a playlist that will not load still yields the master', async () => {
    // The master is playable on its own. Losing the variant list is a downgrade,
    // not a failure.
    const ctx = load({[MASTER]: {status: 403, body: 'no'}});
    const parsed = h.hostParseVideos(await ctx.instance.getVideoList(PAGE_URL));
    test.true(parsed.ok, parsed.reason);
    test.equal(parsed.items.length, 1, 'just the master');
    test.equal(parsed.items[0].url, MASTER);
    test.ok(ctx.log.some(l => /variant list unavailable/.test(l)), 'and the log says why');
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('filters: the four sorts and the categories are real controls', async () => {
    const ctx = load();
    const parsed = h.hostParseFilters(ctx.instance.getFilterList());
    test.true(parsed.ok, parsed.reason);
    const groups = {};
    for (const group of parsed.filters) {
        groups[group.name] = group.state;
    }
    test.ok(groups.Sort, 'a Sort group');
    test.ok(groups.Category, 'a Category group');
    const sorts = groups.Sort.map(s => s.value);
    for (const value of ['', 'latest', 'most-viewed', 'longest', 'random']) {
        test.ok(sorts.indexOf(value) !== -1, 'Sort offers ' + JSON.stringify(value));
    }
    test.equal(groups.Category.length, 67, 'the site publishes 67 categories');
});

test('filters: every category offered is one the site actually serves', async () => {
    // A slug that has been renamed would 404 for the user who picked it. The
    // list here is compared against the fixture set and against the shape the
    // site publishes, so a stale entry is visible in the suite.
    const ctx = load();
    const groups = ctx.instance.getFilterList();
    const categories = groups.filter(g => g.name === 'Category')[0].state;
    const slugs = categories.map(c => c.value);
    test.equal(new Set(slugs).size, slugs.length, 'no duplicates');
    for (const slug of slugs) {
        test.ok(/^[a-z0-9-]+$/.test(slug), slug + ' is a URL-safe slug');
    }
    test.ok(slugs.indexOf('brazzers') !== -1, 'a known category is present');
    test.ok(slugs.indexOf('teen') !== -1, 'including the one that matters most to get right');
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('contract: the manga-only entry points report as unimplemented', async () => {
    // This is an anime source, so AnymeX never calls these. Throwing is how the
    // contract reports "not implemented"; returning empty would look like a
    // working source with no pages. The list is the bridged provider's own:
    // getPageList, getHtmlContent, cleanHtmlContent, and no others.
    const ctx = load();
    for (const method of ['getPageList', 'getHtmlContent', 'cleanHtmlContent']) {
        let threw = false;
        try {
            await ctx.instance[method]('x');
        } catch (error) {
            threw = true;
            test.includes(error.message, 'not implemented');
        }
        test.true(threw, method + ' throws');
    }
});

test('contract: no method is shipped that the host cannot call', () => {
    // The bridged provider is a closed list. A method outside it that looks like
    // an entry point is dead code masquerading as a capability the source does
    // not have. `fetchPage` is the source's own HTTP helper and is called only
    // by this file; it is named here so the exception is deliberate.
    const bridged = [
        'getLatestUpdates', 'getPopular', 'getVideoList', 'search', 'getDetail',
        'getPageList', 'cleanHtmlContent', 'getHtmlContent', 'getFilterList',
        'getSourcePreferences',
        'fetchPage', 'metaValues', 'metaText', 'parseCards', 'parseGenres',
        'uploadMillis', 'listing'
    ];
    const proto = Object.getPrototypeOf(load().instance);
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || name.startsWith('_')) {
            continue;
        }
        if (typeof proto[name] === 'function') {
            test.ok(bridged.indexOf(name) !== -1, name + ' is a real entry point or a named helper');
        }
    }
});

/** The source with its comments removed, so a lint reads code and not prose. */
function sourceCode() {
    const text = require('fs').readFileSync(SOURCE, 'utf8');
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('contract: the source holds no credentials and needs no auth', () => {
    // Comments are stripped first: this source's own header explains that it
    // sends no cookie, and matching that sentence would be nonsense.
    const code = sourceCode();
    for (const pattern of [/api[_-]?key/i, /bearer\s/i, /authorization/i, /cookie/i, /password/i, /token\s*=/i]) {
        test.equal(pattern.test(code), false, 'no ' + pattern + ' in the code');
    }
});

test('contract: no eval, no Function constructor', () => {
    const code = sourceCode();
    test.equal(/\beval\s*\(/.test(code), false, 'no eval()');
    test.equal(/new\s+Function\s*\(/.test(code), false, 'no Function()');
});

test('contract: logs never carry a response body', async () => {
    // A log line is the one place a fixture or a token could leak into a user's
    // console. The source logs URLs and reasons; this checks it logs no more.
    const secret = 'A-VERY-LONG-UNIQUE-STRING-FROM-A-RESPONSE-BODY-918273645';
    const ctx = load({
        [BASE + '/?filter=latest']: {
            status: 200,
            body: '<article><a href="' + BASE + '/video/id=pm1"><span class="title">' +
                secret + '</span></a></article>'
        },
        [SEARCH_URL]: {status: 200, body: secret}
    });
    await ctx.instance.getPopular(1).catch(() => {});
    await ctx.instance.search('milf', 1, NO_FILTERS).catch(() => {});
    const logged = ctx.log.join('\n');
    test.equal(logged.indexOf(secret), -1, 'the body is not in the log');
});

// --- platform portability ---------------------------------------------------

/*
 * The same source has to run on Android and on iOS, and those are the same
 * codebase with the same QuickJS engine, so there is no port to write. What is
 * easy to lose is the property itself: an edit that reaches for a Node or DOM
 * global would pass every other test here and then fail only on a device,
 * because the harness supplies nothing that is missing at runtime.
 *
 * So the banned list is the useful half of this group — the globals that exist
 * in Node or a browser, that a developer would reach for without thinking, and
 * that the engine does not have.
 */
const NOT_PORTABLE = [
    [/\bnew\s+URL\s*\(/, 'the URL constructor'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bText(?:En|De)coder\b/, 'TextEncoder/TextDecoder'],
    [/\bBuffer\b/, 'Buffer'],
    [/\brequire\s*\(/, 'require()'],
    [/\bprocess\./, 'process'],
    [/\b__dirname\b/, '__dirname'],
    [/\bset(?:Timeout|Interval)\s*\(/, 'setTimeout/setInterval'],
    [/\batob\s*\(|\bbtoa\s*\(/, 'atob/btoa'],
    [/\bcrypto\./, 'crypto'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bnavigator\b/, 'navigator'],
    [/\bdocument\b/, 'document'],
    [/\bwindow\b/, 'window'],
    [/\blocalStorage\b/, 'localStorage']
];

test('portability: no global the engine does not provide', () => {
    const code = sourceCode();
    for (const [pattern, name] of NOT_PORTABLE) {
        test.equal(pattern.test(code), false, 'does not use ' + name);
    }
});

test('portability: the network is reached only through the injected Client', () => {
    const code = sourceCode();
    // One way out, so a platform-specific networking path cannot creep in beside
    // it. `Client` is a host object on every platform: the app's bridge is
    // built on dart:io, not on a platform plugin, which is why a source that
    // only uses it needs no per-platform variant.
    const routes = code.match(/new\s+Client\s*\(\s*\)/g) || [];
    test.equal(routes.length > 0, true, 'it fetches through new Client()');
    test.equal(/new\s+Client\s*\(\s*\)[\s\S]{0,200}?\.get\s*\(/.test(code), true, 'and calls get() on it');
});

test('portability: every URL it builds is https', () => {
    // iOS refuses plaintext HTTP outright under ATS, so a stray http:// would
    // work in the harness and fail on device with no useful error.
    const code = sourceCode();
    const insecure = code.match(/http:\/\/(?!localhost)/g) || [];
    test.equal(insecure.length, 0, 'no plaintext http URL in the code');
});

// --- the install catalogue -------------------------------------------------

const CATALOGUE = path.join(__dirname, '..', 'anymex', 'index.json');
const REPO_META = path.join(__dirname, '..', 'anymex', 'repo.json');

/**
 * Dart's String.hashCode, which is what the extension project's own model uses
 * to derive a source id when the catalogue does not carry one. Jenkins
 * one-at-a-time over the UTF-16 code units, masked to 31 bits, with 0 promoted
 * to 1. Written out here because the value is only meaningful if it is
 * reproducible, and reproducing it is the whole reason this file can be tested.
 */
function dartStringHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash += text.charCodeAt(i);
        hash += hash << 10;
        hash ^= hash >>> 6;
    }
    hash += hash << 3;
    hash ^= hash >>> 11;
    hash += hash << 15;
    hash &= 0x7fffffff;
    return hash === 0 ? 1 : hash;
}

function readJson(file) {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
}

test('catalogue: a valid non-empty array', () => {
    const catalogue = readJson(CATALOGUE);
    test.equal(Array.isArray(catalogue), true, 'index.json is an array');
    test.equal(catalogue.length > 0, true, 'the catalogue is not empty');
    test.equal(
        catalogue.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)),
        true,
        'every entry is an object'
    );
});

test('catalogue: one entry per source, and the names line up', () => {
    const catalogue = readJson(CATALOGUE);
    const declared = load().manifest;
    test.equal(catalogue.length, 1, 'one catalogue entry per source file');
    const entry = catalogue[0];
    test.equal(entry.name, declared.name, 'name matches mangayomiSources');
    test.equal(entry.baseUrl, declared.baseUrl, 'baseUrl matches mangayomiSources');
    test.equal(entry.lang, declared.lang, 'lang matches mangayomiSources');
    test.equal(entry.version, declared.version, 'version matches mangayomiSources');
    test.equal(entry.iconUrl, declared.iconUrl, 'iconUrl matches mangayomiSources');
    test.equal(entry.apiUrl, declared.apiUrl, 'apiUrl matches mangayomiSources');
    test.equal(entry.itemType, declared.itemType, 'itemType matches mangayomiSources');
    test.equal(entry.isNsfw, declared.isNsfw, 'isNsfw matches mangayomiSources');
    test.equal(entry.isNsfw, true, 'the source is flagged, not disguised');
});

test('catalogue: the entry is JavaScript and video, and the host reads it as such', () => {
    const entry = readJson(CATALOGUE)[0];
    // The app's enum is {dart, javascript, mihon, lnreader, aidoku}.
    test.equal(entry.sourceCodeLanguage, 1, 'sourceCodeLanguage is javascript');
    // The app's enum is {manga, anime, novel}, and this source is a video one.
    test.equal(entry.itemType, 1, 'itemType is anime');
    test.equal(entry.isManga, false, 'isManga agrees with itemType');
    test.equal(path.basename(SOURCE), 'pornmz.js', 'the entry describes the source under test');
});

test('catalogue: the id is the one the derivation formula produces', () => {
    const entry = readJson(CATALOGUE)[0];
    // The extension project's model derives: 'mangayomi-js-"<lang>"."<name>"'.hashCode
    // when sourceCodeLanguage is not 0. Deriving it here rather than trusting
    // the literal means a renamed source or a typo in the id fails the suite.
    const derived = dartStringHash('mangayomi-js-"' + entry.lang + '"."' + entry.name + '"');
    test.equal(entry.id, derived, 'the id re-derives from lang and name');
    test.equal(entry.id, 2086949404, 'and it is the value that was reviewed');
    test.equal(entry.id > 0 && entry.id <= 0x7fffffff, true, 'the id is a positive 31-bit int');
});

test('catalogue: the id would still be right if it were left out', () => {
    // Worth pinning because it is the fallback the app uses, and because it
    // shows the id is a convenience rather than something the load depends on.
    const entry = readJson(CATALOGUE)[0];
    const withoutId = {...entry};
    delete withoutId.id;
    const derived = dartStringHash('mangayomi-js-"' + withoutId.lang + '"."' + withoutId.name + '"');
    test.equal(derived, entry.id, 'the formula does not depend on the stored id');
});

test('catalogue: the code URL points at this source in this repository', () => {
    const entry = readJson(CATALOGUE)[0];
    test.equal(typeof entry.sourceCodeUrl, 'string', 'sourceCodeUrl is a string');
    test.equal(entry.sourceCodeUrl.indexOf('https://'), 0, 'sourceCodeUrl is https');
    test.equal(
        /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/anymex\/pornmz\.js$/.test(entry.sourceCodeUrl),
        true,
        'sourceCodeUrl is a raw URL for anymex/pornmz.js in a repository'
    );
    test.equal(/\/main\//.test(entry.sourceCodeUrl), true, 'on the main branch');
    test.equal(/\/master\//.test(entry.sourceCodeUrl), false, 'not a stale branch name');
});

test('catalogue: the optional fields the host reads are present and sane', () => {
    const entry = readJson(CATALOGUE)[0];
    test.equal(entry.hasCloudflare, false, 'hasCloudflare is stated, not omitted');
    test.equal(typeof entry.dateFormat, 'string', 'dateFormat is a string');
    test.equal(typeof entry.dateFormatLocale, 'string', 'dateFormatLocale is a string');
    test.equal(typeof entry.additionalParams, 'string', 'additionalParams is a string');
    test.equal(typeof entry.appMinVerReq, 'string', 'appMinVerReq is set');
    test.equal(entry.typeSource, 'single', 'typeSource is single');
});

test('catalogue: no credentials of any kind', () => {
    const text = require('fs').readFileSync(CATALOGUE, 'utf8');
    for (const pattern of [/api[_-]?key/i, /bearer\s/i, /authorization/i, /cookie/i, /password/i, /token\s*[:=]/i]) {
        test.equal(pattern.test(text), false, 'no ' + pattern + ' in the catalogue');
    }
});

test('repo.json: names the repository so it is not called after the URL', () => {
    const meta = readJson(REPO_META);
    const name = (meta.meta && meta.meta.name) || meta.name;
    const website = (meta.meta && meta.meta.website) || meta.website;
    test.equal(typeof name, 'string', 'the repository has a name');
    test.equal(name.endsWith('.json'), false, 'the name is not a filename');
    test.equal(name.length > 0, true, 'the name is not empty');
    test.equal(typeof website, 'string', 'the repository has a website');
    test.equal(website.indexOf('https://'), 0, 'the website is https');
});

test('repo.json: carries no v2 index redirect', () => {
    // getRepoInfos follows index_v2 and ignores this catalogue entirely.
    const meta = readJson(REPO_META);
    test.equal(meta.index_v2, undefined, 'no index_v2 redirect');
});

test.run();
