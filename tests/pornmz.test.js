'use strict';
/*
 * Tests for modules/pornmz.
 *
 * The assertions deliberately do not check "did the function return an array".
 * They feed the resolved value to the harness's transcription of the host's
 * Swift parsing, so a pass means Sora will actually render something. That is
 * the only assertion that catches the async-mode trap, where a module resolves
 * a real array and the user sees an empty screen.
 *
 * Fixtures are the provider's real public responses, captured once. The suite
 * never touches the network (§41).
 */

const path = require('path');
const test = require('./test');
const h = require('./harness');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'pornmz');
const FIXTURE_DIR = 'pornmz';

const PAGE_URL = 'https://pornmz.com/video/id=pm26201719309399';
const STREAM_URL =
    'https://video.twimg.com/amplify_video/2103925197430546432/pl/LPYC0fG2Xdm6ncFL.m3u8';

/** Fresh module + fixtures. Each test gets its own context so the page cache
 *  and its TTL never leak between cases. `settings` is the value the user would
 *  have saved in the app's settings screen, applied through the real rewriter. */
function load(extraRoutes, settings) {
    const routes = h.readFixtures(FIXTURE_DIR);
    Object.keys(extraRoutes || {}).forEach((k) => { routes[k] = extraRoutes[k]; });
    return h.loadModule(MODULE_DIR, routes, settings);
}

/** Count of network calls actually issued — the anti-regression check for the
 *  page cache. */
function requestCount(ctx) {
    return ctx.calls.length;
}

// ---------------------------------------------------------------------------
// searchResults
// ---------------------------------------------------------------------------

test('search: the host receives rows with title, image and href', async () => {
    const ctx = load();
    const parsed = h.hostParseSearch(await ctx.context.searchResults('milf'));

    test.true(parsed.ok, 'the host could parse the result: ' + parsed.reason);
    test.equal(parsed.items.length, 2, 'both posts returned');

    const first = parsed.items[0];
    test.equal(first.title,
        'Wifey Mayalynn and Mrjax Tattooed Baddie Hotwife Loves BBC', 'title');
    test.equal(first.href, PAGE_URL, 'href is the canonical post link');
    test.includes(first.image, 'wp-content/uploads', 'thumbnail came from featured media');
});

test('search: numeric entities in titles are decoded, not left as &#8211;', async () => {
    // The second real post's title contains an en dash WordPress encodes as
    // &#8211;. Left encoded, Sora shows the escape in the results list.
    const ctx = load();
    const parsed = h.hostParseSearch(await ctx.context.searchResults('milf'));
    const second = parsed.items[1];
    test.includes(second.title, '–', 'en dash decoded');
    test.equal(second.title.indexOf('&#'), -1, 'no entity escapes remain');
});

test('search: a post with no featured media keeps its row with an empty image', async () => {
    // The host's compactMap drops a row whose image is not a String, so "" is
    // required — a missing key would delete the whole result.
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=nofm&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({
        [url]: {
            status: 200,
            body: JSON.stringify([{ id: 1, link: PAGE_URL, title: { rendered: 'No Thumbnail' } }])
        }
    });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('nofm'));
    test.equal(parsed.items.length, 1, 'the row survives');
    test.equal(parsed.items[0].image, '', 'thumbnail omitted rather than invented');
});

test('search: a post missing title or link is dropped, not emitted broken', async () => {
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=partial&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({
        [url]: {
            status: 200,
            body: JSON.stringify([
                { link: PAGE_URL, title: { rendered: 'Complete' } },
                { title: { rendered: 'No link' } },
                { link: PAGE_URL },
                { link: PAGE_URL, title: { rendered: '' } }
            ])
        }
    });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('partial'));
    test.equal(parsed.items.length, 1, 'only the complete row is emitted');
    test.equal(parsed.items[0].title, 'Complete', 'and it is the right one');
});

test('search: an empty result list is a valid answer, not a failure', async () => {
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=zzzznothing&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { status: 200, body: '[]' } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('zzzznothing'));
    test.true(parsed.ok, 'parses cleanly');
    test.equal(parsed.items.length, 0, 'no results');
});

test('search: an empty keyword short-circuits without a request', async () => {
    const ctx = load();
    const parsed = h.hostParseSearch(await ctx.context.searchResults('   '));
    test.true(parsed.ok, 'parses cleanly');
    test.equal(parsed.items.length, 0, 'no results');
    test.equal(requestCount(ctx), 0, 'no network call was made');
});

test('search: HTTP failures are logged and degrade to an empty list', async () => {
    // 403 and 429 are the provider answering, not being unreachable. The host
    // shows an empty list either way; the log is the only place the difference
    // is visible, so the log must exist and must not carry the body.
    for (const status of [403, 429, 500]) {
        const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=f' + status +
            '&per_page=20&_embed=wp:featuredmedia';
        const ctx = load({ [url]: { status: status, body: 'refused' } });
        const parsed = h.hostParseSearch(await ctx.context.searchResults('f' + status));
        test.equal(parsed.items.length, 0, status + ' yields no results');
        test.includes(ctx.log.join('\n'), 'HTTP ' + status, status + ' was logged as a status');
    }
});

test('search: a transport failure is logged as such, not as an HTTP error', async () => {
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=down&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { transportError: 'connection lost' } });
    await ctx.context.searchResults('down');
    test.includes(ctx.log.join('\n'), 'transport', 'transport failure distinguishable in the log');
});

test('search: a dropped connection is retried before giving up', async () => {
    // The shipped copy of the shared helper. The app logged "The network
    // connection was lost" mid-search, which the host turned into an empty
    // result list and its own "Failed to process items" error. One more ask
    // turns a momentary blip into results.
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=blip&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({
        [url]: {
            transportError: 'The network connection was lost.', failFirst: 1,
            status: 200,
            body: JSON.stringify([{ link: PAGE_URL, title: { rendered: 'Recovered' } }])
        }
    });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('blip'));
    test.equal(parsed.items.length, 1, 'the retry produced a result');
    test.equal(parsed.items[0].title, 'Recovered', 'and it is the right one');
    test.equal(requestCount(ctx), 2, 'at the cost of one extra request');
});

test('search: a 200 with an HTML body is reported as malformed, not as results', async () => {
    // A bot-check or maintenance page served with status 200. Treating it as
    // data is how a module ends up reporting a provider outage as "no matches".
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=html&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { status: 200, body: '<html>Just a moment...</html>' } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('html'));
    test.equal(parsed.items.length, 0, 'no results invented from HTML');
    test.includes(ctx.log.join('\n'), 'unreadable JSON', 'the real cause is logged');
});

test('search: a WordPress error object is not mistaken for a result list', async () => {
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=obj&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({
        [url]: { status: 200, body: '{"code":"rest_invalid_param","message":"bad param"}' }
    });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('obj'));
    test.equal(parsed.items.length, 0, 'no results');
    test.includes(ctx.log.join('\n'), 'not a list', 'the shape mismatch is logged');
});

test('search: the keyword is URL-encoded into the request', async () => {
    const ctx = load();
    await ctx.context.searchResults('a b&c');
    const url = ctx.calls[0].url;
    test.includes(url, 'search=a%20b%26c', 'special characters encoded, not injected raw');
});

// ---------------------------------------------------------------------------
// Browse — the provider's own listing pages
// ---------------------------------------------------------------------------

const FILTER_BASE = 'https://pornmz.com/?filter=';
const CATEGORY_BASE = 'https://pornmz.com/pmvideo/c/';
const CATEGORY_URL = CATEGORY_BASE + 'brazzers';

/** Routes for any listing URL, each answering with the recorded card markup. */
function listingRoutes() {
    return {
        [FILTER_BASE + 'most-viewed']: { status: 200, body: CARDS },
        [FILTER_BASE + 'latest']: { status: 200, body: CARDS },
        [FILTER_BASE + 'longest']: { status: 200, body: CARDS },
        [FILTER_BASE + 'random']: { status: 200, body: CARDS },
        [CATEGORY_URL]: { status: 200, body: CARDS }
    };
}

// Two cards, the shape the site's theme really emits: data-main-thumb on the
// article, a duration, a view count, and the title both as a span and an attribute.
const CARDS =
    '<article data-main-thumb="https://pornmz.com/wp-content/uploads/2019/10/one.jpg" ' +
    'class="thumb-block video-preview-item post-83103" data-post-id="83103">' +
    '<a href="https://pornmz.com/video/id=pm2505492683103" title="Brazzers &#8211; Making Assmends">' +
    '<div class="post-thumbnail"><div class="post-thumbnail-container">' +
    '<img class="video-main-thumb" width="300" height="168.75" ' +
    'src="https://pornmz.com/wp-content/uploads/2019/10/one.jpg" alt="Brazzers"></div>' +
    '<div class="video-overlay"></div><span class="hd-video">HD</span> ' +
    '<span class="duration">37:00</span></div>' +
    '<header class="entry-header"> <span class="title">Brazzers &#8211; Making Assmends</span>' +
    '<div class="under-thumb"> <span class="views"><i class="fa fa-eye"></i> 629K</span></div>' +
    '</header></a></article>' +
    '<article data-main-thumb="https://pornmz.com/wp-content/uploads/2026/09/two.jpg" ' +
    'class="thumb-block video-preview-item post-309435" data-post-id="309435">' +
    '<a href="https://pornmz.com/video/id=pm27084644309435" title="PervMom &#8211; Talisman">' +
    '<div class="post-thumbnail"><img class="video-main-thumb" ' +
    'src="https://pornmz.com/wp-content/uploads/2026/09/two.jpg" alt="PervMom">' +
    '<span class="duration">56:00</span></div>' +
    '<header class="entry-header"> <span class="title">PervMom &#8211; Talisman</span>' +
    '<span class="views"><i class="fa fa-eye"></i> 12K</span></header></a></article>';

test('browse: every sort the site publishes is reachable by keyword', async () => {
    // The provider's own front page: ?filter=most-viewed / latest / longest /
    // random. Each is the site computing a real ordering, including a real
    // view-count ranking — not the module approximating one from the REST API.
    const expected = {
        'latest': 'latest', 'popular': 'most-viewed', 'most viewed': 'most-viewed',
        'trending': 'most-viewed', 'top': 'most-viewed', 'best': 'most-viewed',
        'longest': 'longest', 'random': 'random', 'shuffle': 'random'
    };
    for (const [keyword, filter] of Object.entries(expected)) {
        const ctx = load(listingRoutes());
        await ctx.context.searchResults(keyword);
        test.equal(ctx.calls[0].url, FILTER_BASE + filter,
            JSON.stringify(keyword) + ' -> ?filter=' + filter);
    }
});

test('browse: a popular listing really is the site view counts, in order', async () => {
    // The claim that this provider has no popularity signal was wrong, and this
    // is the test that says so: the card carries <span class="views">629K</span>,
    // and ?filter=most-viewed is that field sorted descending by the theme.
    const ctx = load(listingRoutes());
    const parsed = h.hostParseSearch(await ctx.context.searchResults('popular'));
    test.true(parsed.ok, 'the host could parse the result');
    test.equal(parsed.items.length, 2, 'both cards returned');
    test.includes(ctx.calls[0].url, 'filter=most-viewed', 'asked the site for its view ranking');
    test.ok(CARDS.indexOf('629K') !== -1, 'the fixture really does carry view counts');
});

test('browse: cards become rows the host can render', async () => {
    const ctx = load(listingRoutes());
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    const first = parsed.items[0];
    test.equal(first.title, 'Brazzers – Making Assmends', 'title decoded from the card');
    test.equal(first.image, 'https://pornmz.com/wp-content/uploads/2019/10/one.jpg',
        'thumbnail taken from data-main-thumb');
    test.equal(first.href, 'https://pornmz.com/video/id=pm2505492683103',
        'href is the video page, so the row opens something playable');
    test.equal(requestCount(ctx), 1, 'one request for a whole listing');
});

test('browse: a card with no thumbnail at all yields a blank image, not a dropped row', async () => {
    // The host drops a row missing any of title/image/href, so a card with no
    // thumbnail anywhere still has to be offered. Same trade as the REST path.
    const body = CARDS
        .replace(/\s*data-main-thumb="[^"]*"/, '')
        .replace(/<img\b[^>]*>/i, '');
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: body } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items.length, 2, 'both cards still offered');
    test.equal(parsed.items[0].image, '', 'the first has no image rather than being lost');
});

test('browse: the thumbnail falls back from data-main-thumb to the <img src>', async () => {
    // data-main-thumb is the convenient source, but the same URL is in the img tag
    // and the two can disagree when a theme changes. Losing the image over that
    // would blank a card that has a perfectly good thumbnail.
    const body = CARDS.replace(/\s*data-main-thumb="[^"]*"/, '');
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: body } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items[0].image, 'https://pornmz.com/wp-content/uploads/2019/10/one.jpg',
        'taken from the img tag instead');
});

test('browse: a card missing its title span falls back to the link title attribute', async () => {
    const body = CARDS.replace(/<span class="title">[^<]*<\/span>/, '');
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: body } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items.length, 2, 'the card is not dropped');
    test.equal(parsed.items[0].title, 'Brazzers – Making Assmends', 'title from the attribute');
});

test('browse: a card with no href is dropped rather than sent to the host', async () => {
    const body = CARDS.replace(/href="https:\/\/pornmz\.com\/video\/id=pm2505492683103"/, 'href=""');
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: body } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items.length, 1, 'only the usable card is offered');
});

test('browse: a relative thumbnail is dropped rather than passed through', async () => {
    // JavaScriptCore has no URL global, so a root-relative path cannot be
    // resolved here. Passing it through would render as a broken image.
    const body = CARDS.replace('data-main-thumb="https://pornmz.com/wp-content/uploads/2019/10/one.jpg"',
        'data-main-thumb="/wp-content/uploads/2019/10/one.jpg"');
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: body } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items[0].image, '', 'relative URL refused');
});

test('browse: "cat:name" opens that category listing', async () => {
    // Categories live at /pmvideo/c/{slug}, not /category/{slug}, and use the
    // same card markup as the sorts.
    const ctx = load(listingRoutes());
    const parsed = h.hostParseSearch(await ctx.context.searchResults('cat:brazzers'));
    test.equal(ctx.calls[0].url, CATEGORY_URL, 'the category page');
    test.equal(parsed.items.length, 2, 'and it parses the same way');
    for (const prefix of ['cat:', 'category:', 'Category:', '  cat :  ']) {
        const c = load(listingRoutes());
        await c.context.searchResults(prefix + 'brazzers');
        test.equal(c.calls[0].url, CATEGORY_URL, JSON.stringify(prefix) + ' is accepted');
    }
});

test('browse: a category slug is normalised instead of pasted into the path', async () => {
    const ctx = load(listingRoutes());
    await ctx.context.searchResults('cat:Big Tits!');
    test.equal(ctx.calls[0].url, CATEGORY_BASE + 'big-tits',
        'spaced and punctuated slugs become the site\'s dash form');
});

test('browse: a bare word is a search, not a category', async () => {
    // The site has 67 categories and their slugs are ordinary words — milf,
    // anal, asian, bdsm. Matching bare words would turn ordinary text searches
    // into category listings, so a category needs its prefix.
    //
    // "best" is deliberately absent from this list: the site has a category
    // called "best" AND a browse word "best", and the browse word wins. That is
    // the better collision to lose — a user typing "best" wants the popular
    // listing, and "cat:best" still reaches the category.
    for (const word of ['milf', 'anal', 'asian', 'bdsm', 'blacked']) {
        const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=' + word +
            '&per_page=20&_embed=wp:featuredmedia';
        const ctx = load({ [url]: { status: 200, body: '[]' } });
        await ctx.context.searchResults(word);
        test.includes(ctx.calls[0].url, 'search=' + word,
            JSON.stringify(word) + ' is searched, not treated as a category');
    }
});

test('browse: a listing page with no cards is reported, not silently empty', async () => {
    const ctx = load({ [FILTER_BASE + 'latest']: { status: 200, body: '<html><body>gone</body></html>' } });
    const parsed = h.hostParseSearch(await ctx.context.searchResults('latest'));
    test.equal(parsed.items.length, 0, 'nothing offered');
    test.ok(ctx.log.some(l => /no cards/.test(String(l))),
        'and the log says the markup changed rather than claiming the site is empty');
});

test('browse: the keyword match ignores case and surrounding space', async () => {
    for (const keyword of ['LATEST', '  Latest  ', 'Newest', 'new', 'recent', 'fresh']) {
        const ctx = load(listingRoutes());
        const parsed = h.hostParseSearch(await ctx.context.searchResults(keyword));
        test.equal(parsed.items.length, 2, JSON.stringify(keyword) + ' browses');
    }
});

test('browse: a browse word inside a longer phrase is still a text search', async () => {
    // "latest milf" is a real query, not a browse intent. Matching whole words
    // only is what keeps the two apart.
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=latest%20milf&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { status: 200, body: '[]' } });
    await ctx.context.searchResults('latest milf');
    test.includes(ctx.calls[0].url, 'search=latest%20milf', 'searched as written');
});

test('browse: inherited object names are not mistaken for keywords', async () => {
    // hasOwnProperty, not a truthiness test. A bare lookup would match
    // "constructor", "toString" and friends on Object.prototype and turn a
    // perfectly ordinary search into a browse.
    for (const keyword of ['constructor', 'tostring', 'valueof', 'hasownproperty']) {
        const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=' + keyword +
            '&per_page=20&_embed=wp:featuredmedia';
        const ctx = load({ [url]: { status: 200, body: '[]' } });
        await ctx.context.searchResults(keyword);
        test.includes(ctx.calls[0].url, 'search=' + keyword,
            JSON.stringify(keyword) + ' is searched, not browsed');
    }
});

// ---------------------------------------------------------------------------
// extractDetails / extractEpisodes
// ---------------------------------------------------------------------------

test('details: the host receives description, aliases and airdate', async () => {
    const ctx = load();
    const parsed = h.hostParseDetails(await ctx.context.extractDetails(PAGE_URL));
    test.true(parsed.ok, 'the host could parse the result: ' + parsed.reason);
    test.equal(parsed.items.length, 1, 'one MediaItem');

    const item = parsed.items[0];
    test.includes(item.description, 'Mayalynn', 'description came from the page');
    // &#039; is U+0027 (a straight apostrophe), &quot; is a double quote — the
    // page carries both, so the decoder has to cover numeric and named forms.
    test.includes(item.description, 'let\'s call her a virgin', 'numeric + named entities decoded');
    test.includes(item.description, '"So when I met her', '&quot; decoded to a double quote');
    test.equal(item.description.indexOf('&#'), -1, 'no numeric entity escapes remain');
    test.equal(item.description.indexOf('&quot;'), -1, 'no named entity escapes remain');
    test.equal(item.airdate, '2026-09-26T20:19:17+01:00', 'airdate is the published uploadDate');
    test.equal(item.aliases, '', 'aliases empty — the provider publishes no alternate title');
});

test('details: the site-level itemprop="name" is not mistaken for the video title', async () => {
    // The page carries itemprop="name" twice: "Pornmz", then the video. A
    // module that read the first match would label every video "Pornmz". This
    // test pins that the module never emits that as metadata.
    const ctx = load();
    const parsed = h.hostParseDetails(await ctx.context.extractDetails(PAGE_URL));
    const serialised = JSON.stringify(parsed.items);
    test.ok(serialised.indexOf('"Pornmz"') === -1, 'the site name does not leak into details');
});

test('episodes: one post is one episode, reachable and numbered', async () => {
    const ctx = load();
    const parsed = h.hostParseEpisodes(await ctx.context.extractEpisodes(PAGE_URL));
    test.true(parsed.ok, 'the host could parse the result: ' + parsed.reason);
    test.equal(parsed.episodes.length, 1, 'exactly one episode');
    test.equal(parsed.episodes[0].number, 1, 'numbered 1');
    test.equal(parsed.episodes[0].href, PAGE_URL, 'points at the video page');
});

test('details and episodes share one page fetch', async () => {
    // fetchDetailsJS dispatches these concurrently on the same URL; the memoised
    // in-flight promise is what keeps that to a single request.
    const ctx = load();
    const both = await Promise.all([
        ctx.context.extractDetails(PAGE_URL),
        ctx.context.extractEpisodes(PAGE_URL)
    ]);
    test.true(h.hostParseDetails(both[0]).ok, 'details parsed');
    test.true(h.hostParseEpisodes(both[1]).ok, 'episodes parsed');
    test.equal(requestCount(ctx), 1, 'one network call served both entry points');
});

test('a page fetch failure degrades to empty rather than rejecting', async () => {
    const url = 'https://pornmz.com/video/id=pm-gone';
    const ctx = load({ [url]: { status: 404, body: 'not found' } });
    const details = h.hostParseDetails(await ctx.context.extractDetails(url));
    const episodes = h.hostParseEpisodes(await ctx.context.extractEpisodes(url));
    test.true(details.ok, 'details still parses');
    test.equal(details.items.length, 0, 'no invented metadata');
    test.true(episodes.ok, 'episodes still parse');
    test.includes(ctx.log.join('\n'), 'HTTP 404', 'the status was logged');
});

test('episodes resolve without waiting for the page at all', async () => {
    // The app logged "Timeout for extractEpisodes" twice on videos that then
    // played fine. The episode is the URL the host already holds, so awaiting
    // the page here bought nothing and cost the whole page timeout. A request
    // that never answers must not be able to stall this entry point.
    const url = 'https://pornmz.com/video/id=pm-hang';
    const ctx = load({ [url]: { hang: true } });

    const resolved = await Promise.race([
        ctx.context.extractEpisodes(url).then(r => r),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('extractEpisodes waited for the page')), 250))
    ]);

    const parsed = h.hostParseEpisodes(resolved);
    test.equal(parsed.episodes.length, 1, 'the episode is there anyway');
    test.equal(parsed.episodes[0].href, url, 'pointing at the page the host asked about');
    test.equal(requestCount(ctx), 1, 'the page is still being fetched, in the background');
});

test('episodes do not wait for a page that never answers, but details still do', async () => {
    // The two entry points are deliberately not symmetrical. Details genuinely
    // needs the page, so it keeps the timeout; episodes never needed it.
    const url = 'https://pornmz.com/video/id=pm-hang2';
    const ctx = load({ [url]: { hang: true } });
    const raced = await Promise.race([
        ctx.context.extractDetails(url).then(() => 'resolved'),
        new Promise(r => setTimeout(() => r('still waiting'), 250))
    ]);
    test.equal(raced, 'still waiting', 'details is correctly waiting on the page');
});

// ---------------------------------------------------------------------------
// extractStreamUrl
// ---------------------------------------------------------------------------

test('streams: the host yields a playable option with the real playlist URL', async () => {
    const ctx = load();
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(PAGE_URL));
    const options = h.hostStreamOptions(parsed);
    test.equal(options.length, 1, 'one playable source');
    test.equal(options[0].url, STREAM_URL, 'the contentUrl was used verbatim');
    // fellBack is only set on the raw-string branch, so absence is the pass.
    test.ok(!parsed.fellBack, 'not the raw-string fallback branch');
});

test('streams: the source carries a Referer the CDN will accept', async () => {
    // Regression guard for a real failure: both hosts default Referer to the
    // module's baseUrl when a source has no headers, and the CDN answers
    // 403 Forbidden to a pornmz.com referer. The player then shows a crossed-
    // out play button and nothing plays.
    const ctx = load();
    const options = h.hostStreamOptions(
        h.hostParseStream(await ctx.context.extractStreamUrl(PAGE_URL)));

    const referer = options[0].headers && options[0].headers.Referer;
    test.ok(referer, 'a Referer travels with the source');
    test.equal(referer, 'https://video.twimg.com',
        'pointed at the host actually serving the playlist');
    test.ok(referer.indexOf('pornmz.com') === -1,
        'and specifically not at the module baseUrl, which the CDN rejects');
});

test('streams: the Referer is derived from the playlist, not hardcoded', async () => {
    // If the provider moves its video to another CDN, the referer has to follow
    // it. Deriving it means a CDN change cannot silently reintroduce the 403.
    const url = 'https://pornmz.com/video/id=pm-othercdn';
    const ctx = load({
        [url]: {
            status: 200,
            body: '<meta itemprop="contentUrl" content="https://cdn.example.net/live/x.m3u8" />'
        }
    });
    const options = h.hostStreamOptions(
        h.hostParseStream(await ctx.context.extractStreamUrl(url)));
    test.equal(options[0].headers.Referer, 'https://cdn.example.net',
        'follows whatever host serves the playlist');
});

// ---------------------------------------------------------------------------
// Settings — the module's only user-facing control
// ---------------------------------------------------------------------------

test('settings: Sora finds a settings screen for this module', () => {
    // If this ever returns [], the module has no controls at all and every
    // browse claim in the README is false. Parsed with a transcription of
    // parseSettingsSchema, not a regex written to suit the module.
    const source = require('fs').readFileSync(path.join(MODULE_DIR, 'module.js'), 'utf8');
    const schema = h.parseSettingsSchema(source);
    test.equal(schema.length, 1, 'exactly one setting is exposed');
    test.equal(schema[0].key, 'BROWSE_ORDER', 'and it is the browse order');
    test.equal(schema[0].type, 'string',
        'a text field — the parser only makes a switch out of a literal true/false');
    test.equal(schema[0].defaultValue, '', 'empty by default, so shipping behaviour is unchanged');
    test.ok(schema[0].comment && schema[0].comment.length > 20,
        'it carries a comment, which is the only place the row can explain itself');
});

test('settings: the saved value reaches the running module', async () => {
    // The whole point of the settings screen: the user sets it once, the app
    // rewrites the const in the module's own script, and every later call sees
    // the new value. If the rewriter could not match the line this would fail.
    const ctx = load(listingRoutes(), { BROWSE_ORDER: 'popular' });
    await ctx.context.searchResults('anything at all');
    test.equal(ctx.calls[0].url, FILTER_BASE + 'most-viewed', 'the saved value is in effect');
});

test('settings: every listing the site publishes can be chosen there', async () => {
    // This is the part that does not require typing anything: the user picks a
    // listing once in the settings screen and from then on the search box
    // browses that listing, whatever is typed into it.
    const expected = {
        'latest': 'latest', 'popular': 'most-viewed', 'most-viewed': 'most-viewed',
        'trending': 'most-viewed', 'longest': 'longest', 'random': 'random'
    };
    for (const [setting, filter] of Object.entries(expected)) {
        const ctx = load(listingRoutes(), { BROWSE_ORDER: setting });
        const parsed = h.hostParseSearch(await ctx.context.searchResults('milf'));
        test.equal(parsed.items.length, 2, JSON.stringify(setting) + ' browses');
        test.equal(ctx.calls[0].url, FILTER_BASE + filter,
            JSON.stringify(setting) + ' -> ?filter=' + filter);
    }
});

test('settings: a category can be pinned there too', async () => {
    const ctx = load(listingRoutes(), { BROWSE_ORDER: 'cat:brazzers' });
    await ctx.context.searchResults('milf');
    test.equal(ctx.calls[0].url, CATEGORY_URL, 'the category listing, whatever was typed');
});

test('settings: the choice is case- and space-insensitive', async () => {
    // The user types into a free text field, so "  Popular " has to work.
    for (const [typed, url] of [['Popular', FILTER_BASE + 'most-viewed'],
                                ['  POPULAR  ', FILTER_BASE + 'most-viewed'],
                                ['Longest', FILTER_BASE + 'longest'],
                                ['Latest', FILTER_BASE + 'latest']]) {
        const ctx = load(listingRoutes(), { BROWSE_ORDER: typed });
        await ctx.context.searchResults('x');
        test.equal(ctx.calls[0].url, url, JSON.stringify(typed) + ' is understood');
    }
});

test('settings: an unrecognised value is ignored rather than breaking search', async () => {
    // The field accepts anything. A typo must not turn every search into a
    // browse of nothing — it falls back to normal text search instead.
    for (const typed of ['popuar', 'newestt', 'desc', '??', 'order=asc']) {
        const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=milf&per_page=20&_embed=wp:featuredmedia';
        const ctx = load({ [url]: { status: 200, body: '[]' } }, { BROWSE_ORDER: typed });
        await ctx.context.searchResults('milf');
        test.includes(ctx.calls[0].url, 'search=milf',
            JSON.stringify(typed) + ' leaves normal search working');
    }
});

test('settings: clearing the field restores ordinary search', async () => {
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=milf&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { status: 200, body: '[]' } }, { BROWSE_ORDER: '' });
    await ctx.context.searchResults('milf');
    test.includes(ctx.calls[0].url, 'search=milf', 'the shipped default is plain search');
});

test('settings: the setting wins over the typed word, predictably', async () => {
    // The two mechanisms compose rather than fight: the setting is an override
    // for the whole screen, so it decides, every time, rather than depending on
    // which one the module happens to look at first.
    const ctx = load(listingRoutes(), { BROWSE_ORDER: 'longest' });
    await ctx.context.searchResults('oldest');
    test.equal(ctx.calls[0].url, FILTER_BASE + 'longest',
        'the setting decides, not the typed keyword');
});

test('downloads: the manifest baseUrl is the host the CDN will answer', async () => {
    // The download path is the one part of playback the module cannot fix from
    // JS. Sora's generateDownloadHeaders builds Referer/Origin from
    // module.metadata.baseUrl and never consults a source's own headers, so
    // this static field is the only lever there is. Left as pornmz.com it sent
    // a referer the CDN answers 403 to, and the log said so:
    //   "Using legacy download method for queued download (no module available)"
    //   "HTTP 403 for M3U8 request"
    // which is why baseUrl points at the CDN origin rather than the site.
    //
    // The trade: this is static, so a CDN change breaks downloads while
    // playback keeps working — the player's Referer is derived from the playlist
    // at runtime, this one is not. That is the only asymmetry in the module, and
    // this test is what makes the failure loud when it happens.
    const manifest = JSON.parse(
        require('fs').readFileSync(path.join(MODULE_DIR, 'manifest.json'), 'utf8'));
    const origin = (url) => (/^(https?:\/\/[^\/?#]+)/i.exec(url) || [])[1];

    test.equal(manifest.baseUrl, origin(STREAM_URL),
        'baseUrl is the origin serving the published playlist');
    test.equal(origin(manifest.baseUrl), origin(STREAM_URL),
        'no path or trailing slash — the host compares it as an origin');
});

test('downloads: a manifest baseUrl change is caught, not silently shipped', async () => {
    // A negative control, so the assertion above is known to be load-bearing:
    // point baseUrl back at the site and the check must fail.
    const manifest = JSON.parse(
        require('fs').readFileSync(path.join(MODULE_DIR, 'manifest.json'), 'utf8'));
    const wrong = 'https://pornmz.com';
    const origin = (url) => (/^(https?:\/\/[^\/?#]+)/i.exec(url) || [])[1];
    test.ok(origin(wrong) !== origin(STREAM_URL),
        'the site origin and the CDN origin really do differ — the check is not vacuous');
});

test('streams: a source is emitted, not a bare URL string', async () => {
    // A bare URL cannot carry headers, which is the whole point of the fix.
    const ctx = load();
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(PAGE_URL));
    test.true(Array.isArray(parsed.sources), 'host read it as sources');
    test.equal(parsed.streams, null, 'not the bare-streams branch');
    test.ok(parsed.sources[0].headers, 'and the source has headers');
});

test('streams: the playlist URL is the one published by the page, not a guess', async () => {
    // The embed is an iframe to a third-party player that would yield a
    // different, expiring URL. Asserting the exact published URL pins that the
    // module never goes near it.
    const ctx = load();
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(PAGE_URL));
    const url = parsed.sources[0].streamUrl;
    test.includes(url, 'video.twimg.com', 'taken from the microdata contentUrl');
    test.equal(url.indexOf('player-x.php'), -1, 'no embed URL emitted');
});

test('streams: a page with no contentUrl reports no source instead of faking one', async () => {
    const url = 'https://pornmz.com/video/id=pm-nosource';
    const body = '<meta itemprop="name" content="A Video" />' +
        '<meta itemprop="uploadDate" content="2026-01-01T00:00:00+00:00" />';
    const ctx = load({ [url]: { status: 200, body: body } });
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(url));
    test.equal(h.hostStreamOptions(parsed).length, 0, 'nothing playable is offered');
    test.includes(ctx.log.join('\n'), 'no contentUrl', 'the reason is logged');
});

test('streams: a failed page fetch offers nothing rather than a broken source', async () => {
    const url = 'https://pornmz.com/video/id=pm-403';
    const ctx = load({ [url]: { status: 403, body: 'forbidden' } });
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(url));
    test.equal(h.hostStreamOptions(parsed).length, 0, 'no unplayable option is offered');
});

// ---------------------------------------------------------------------------
// Page shape resilience
// ---------------------------------------------------------------------------

test('a duplicated single-valued itemprop is refused, not silently guessed', async () => {
    // If the page ever publishes two contentUrls the module must not pick one
    // arbitrarily — a wrong stream that looks valid is worse than none.
    const url = 'https://pornmz.com/video/id=pm-dup';
    const body = '<meta itemprop="contentUrl" content="https://a.test/1.m3u8" />' +
        '<meta itemprop="contentUrl" content="https://b.test/2.m3u8" />';
    const ctx = load({ [url]: { status: 200, body: body } });
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(url));
    test.equal(h.hostStreamOptions(parsed).length, 0, 'no source is offered');
    test.includes(ctx.log.join('\n'), '2 metas for contentUrl', 'the anomaly is logged');
});

test('meta tags with single quotes are read, not missed', async () => {
    // The site's own theme emits double quotes; this guards the module against
    // a theme change rather than the current markup.
    const url = 'https://pornmz.com/video/id=pm-quotes';
    const body = "<meta itemprop='contentUrl' content='https://cdn.test/q.m3u8' />";
    const ctx = load({ [url]: { status: 200, body: body } });
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(url));
    test.equal(h.hostStreamOptions(parsed)[0].url, 'https://cdn.test/q.m3u8', 'value found');
});

test('an empty page body yields an empty result, not a crash', async () => {
    const url = 'https://pornmz.com/video/id=pm-blank';
    const ctx = load({ [url]: { status: 200, body: '' } });
    const details = h.hostParseDetails(await ctx.context.extractDetails(url));
    test.true(details.ok, 'still parses');
    test.equal(details.items.length, 0, 'no metadata invented');
    const episodes = h.hostParseEpisodes(await ctx.context.extractEpisodes(url));
    test.equal(episodes.episodes.length, 1, 'the episode is the URL, and needs no page');
});

test('search: only the relation the module reads is embedded', async () => {
    // _embed=1 resolves author and term relations too, which this provider's
    // server serves as internal sub-requests: same rows, but a measured median
    // of 7.1 s against 2.6 s. Naming the one relation needed is the difference
    // between a search that feels instant and one that does not.
    const ctx = load();
    await ctx.context.searchResults('milf');
    const url = ctx.calls[0].url;
    test.includes(url, '_embed=wp:featuredmedia', 'named relation requested');
    test.equal(url.indexOf('_embed=1&') === -1, true, 'and not the blanket _embed=1');
});

test('the stream is served from cache well after the details page', async () => {
    // The provider's server is slow and variable — the same page request
    // measured anywhere from 1.7 s to 18 s. A second fetch before playback is
    // what turns a two-second wait into a twenty-second blank screen.
    const ctx = load();
    await ctx.context.extractDetails(PAGE_URL);
    await ctx.context.extractEpisodes(PAGE_URL);
    test.equal(requestCount(ctx), 1, 'one page fetch so far');
    await ctx.context.extractStreamUrl(PAGE_URL);
    test.equal(requestCount(ctx), 1, 'and the stream reuses it, no second fetch');
});

// ---------------------------------------------------------------------------
// Runtime constraints
// ---------------------------------------------------------------------------

test('the module never reaches for a URL constructor', async () => {
    // JavaScriptCore has no `URL` global and the host injects no polyfill, so
    // `new URL()` throws on device. The harness leaves URL undefined.
    const ctx = load();
    const parsed = h.hostParseStream(await ctx.context.extractStreamUrl(PAGE_URL));
    test.equal(options1(parsed).length, 1, 'the stream still resolves without URL');
    function options1(p) { return h.hostStreamOptions(p); }
});

test('logs never contain response payloads', async () => {
    // §52: a log line must stay small and must not carry a page or a body.
    const url = 'https://pornmz.com/wp-json/wp/v2/posts?search=leak&per_page=20&_embed=wp:featuredmedia';
    const ctx = load({ [url]: { status: 500, body: 'A'.repeat(5000) } });
    await ctx.context.searchResults('leak');
    const logged = ctx.log.join('\n');
    test.ok(logged.indexOf('AAAA') === -1, 'the response body is not logged');
    test.ok(logged.length < 200, 'the log line stays short (' + logged.length + ' chars)');
});

test.run();
