/*
 * Sora module — pornmz.com
 *
 * Four entry points: searchResults, extractDetails, extractEpisodes,
 * extractStreamUrl. The contract they must satisfy was read out of the Sora /
 * SoraCore source rather than from community documentation; see
 * ../../COMPATIBILITY.md.
 *
 * The two rules that decide whether this module works at all:
 *
 *   1. Async mode. The host does `JSON.parse(result.toString())` on whatever is
 *      resolved (JSController-Search.swift / -Details.swift / -Streams.swift).
 *      A JS array stringifies to "[object Object],…" and silently yields
 *      nothing. So every entry point resolves a JSON *string*.
 *
 *   2. fetchv2 resolves on failure. A try/catch around a fetch catches nothing,
 *      and a down provider is indistinguishable from an empty result unless the
 *      response shape is inspected. So every fetch goes through get() below.
 *
 * Endpoints used, both public and unauthenticated:
 *   GET /wp-json/wp/v2/posts?search=…&per_page=…&_embed=wp:featuredmedia
 *                                                          (WordPress REST)
 *   GET the video page, for its schema.org VideoObject microdata
 * The page's <iframe> player is deliberately not touched: the playable HLS URL
 * is already published in the microdata, so there is no reason to go near an
 * obfuscated embed (§9, §34).
 *
 * Network layer: an inlined copy of ../../../shared/net.js. Sora evaluates one
 * script per module, so a shared file cannot be imported at runtime; net.js is
 * the canonical version and tests/net.test.js covers it.
 */

// Settings start
//
// Sora builds a settings screen for this module out of the `const` declarations
// between these two markers: `parseSettingsSchema` (ModuleSettings.swift:120) scans
// for exactly these comments, `ModuleSettingsView` renders one control per entry,
// and `writeSettingsToFile` (ModuleManager.swift:266) writes the edited value back
// into this script so it takes effect on the next load.
//
// This is the ONLY user-facing control a module can own. The engine injects no view
// (JavaScriptCore+Extensions.swift:383-392 gives us console, fetch, base64 and string
// helpers, nothing else), the 17 fields of ModuleMetadata all render nothing, and the
// search screen has no module-driven surface. So the browse choice lives here rather
// than on a button in the search bar — see COMPATIBILITY.md §3.1.1.
//
// A string rather than a bool: the parser infers type from the literal, and only
// "true"/"false" becomes a switch. A text field can name either honest ordering.
const BROWSE_ORDER = ""; // Type "latest", "popular", "longest", "random", or "cat:milf" to make every search browse that listing instead of matching text. Leave this empty to search normally.
// Settings end

var BASE_URL = "https://pornmz.com";
var SEARCH_ENDPOINT = "/wp-json/wp/v2/posts";
var CATEGORY_PATH = "/pmvideo/c/";
var SEARCH_LIMIT = 20;
var PAGE_TTL_MS = 300000;

// itemprop -> how many <meta> tags carrying it are meaningful.
//
// The page is schema.org microdata, so a value may legitimately repeat: an
// itemprop="actor" list is one meta per person, while itemprop="contentUrl" is
// published once. Reading "the first match" is therefore only correct for the
// single-valued properties. See metaContent() for what happens when the page
// stops matching.
var META_REPEATS = {
    "description": false,
    "uploadDate": false,
    "contentUrl": false
};

// Keywords that browse the archive rather than matching text.
//
// Each maps to one of the site's own front-page sorts (?filter=…), so the module
// reports a real ordering the provider actually computed rather than inventing
// one. The site publishes a view count on every card (`<span class="views">629K`)
// and a most-viewed sort over it, so "popular" has genuine data behind it here.
//
// Correction worth keeping: an earlier revision of this file claimed no popularity
// signal existed, on the grounds that the WordPress REST API rejects
// `orderby=comment_count` and posts carry no view count. Both of those are true
// and irrelevant — the view counts live in the theme, not in the REST payload, and
// are exposed through these filter URLs. Checking the API and concluding the
// provider has no popularity data was the wrong inference; check the front page.
//
// Value: the value to pass as ?filter=.
var BROWSE_KEYWORDS = {
    "latest": "latest", "newest": "latest", "new": "latest", "new videos": "latest",
    "recent": "latest", "recently": "latest", "fresh": "latest", "newest first": "latest",

    "popular": "most-viewed", "most viewed": "most-viewed", "most-viewed": "most-viewed",
    "top": "most-viewed", "best": "most-viewed", "trending": "most-viewed",
    "hot": "most-viewed", "most watched": "most-viewed",

    "longest": "longest", "long": "longest", "longest videos": "longest",

    "random": "random", "shuffle": "random", "surprise": "random"
};

// A category is requested explicitly — "cat:milf" — rather than by matching a bare
// word. The provider has 67 categories whose slugs are ordinary words (milf, anal,
// best, asian, bdsm), so a bare-word match would silently turn a text search into a
// category listing. The prefix keeps the two apart, exactly as matching whole
// browse words does.
var CATEGORY_PREFIX = /^cat(?:egory)?\s*:\s*(.+)$/i;

/**
 * The browse chosen in the settings screen, or "" when there is none.
 *
 * Accepts a browse word or "cat:slug". Anything else is ignored rather than
 * honoured, so a typo in a free-text field cannot turn every search into a browse
 * of nothing — the module falls back to normal text search instead. The value
 * comes back from the file as a string literal, but guard anyway.
 */
function browseOverride() {
    if (typeof BROWSE_ORDER !== "string") {
        return "";
    }
    var chosen = BROWSE_ORDER.trim();
    if (!chosen) {
        return "";
    }
    if (Object.prototype.hasOwnProperty.call(BROWSE_KEYWORDS, chosen.toLowerCase())) {
        return chosen;
    }
    return CATEGORY_PREFIX.test(chosen) ? chosen : "";
}

/**
 * The listing URL for a browse, or null when the query is an ordinary search.
 *
 * Two shapes, both the provider's own URLs and both one request:
 *   ?filter=<sort>          the front-page sorts
 *   /pmvideo/c/<slug>       a category listing, same card markup
 */
function listingUrl(query) {
    var lower = query.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BROWSE_KEYWORDS, lower)) {
        return BASE_URL + "/?filter=" + encodeURIComponent(BROWSE_KEYWORDS[lower]);
    }

    var category = CATEGORY_PREFIX.exec(query);
    if (category) {
        // Slugs are lowercase, dash-separated; anything else is normalised to that
        // shape rather than being pasted into the path raw.
        var slug = category[1].toLowerCase().replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        if (slug) {
            return BASE_URL + CATEGORY_PATH + slug;
        }
    }
    return null;
}

/**
 * One row per <article> card on a listing page.
 *
 * The card is the same shape on every listing the site renders — front-page sorts
 * and category pages alike — so one parser covers all of them:
 *
 *   <article data-main-thumb="IMG" class="thumb-block …" data-post-id="N">
 *     <a href="PAGE" title="TITLE">
 *       <div class="post-thumbnail"> … <img class="video-main-thumb" src="IMG">
 *       <span class="duration">37:00</span></div>
 *       <header class="entry-header">
 *         <span class="title">TITLE</span>
 *         <div class="under-thumb"><span class="views">… 629K</span></div>
 *
 * The href is required and the title is required, because the host drops a search
 * row missing any of title/image/href. The image is not: a card without a
 * thumbnail yields "", which the host renders as a blank cell, and losing the row
 * over a missing image is the worse trade (same rule as the REST path).
 *
 * No duration or view count is read. The host discards both — it takes only
 * {title, image, href} — and the app renders the count itself.
 */
function parseCards(html) {
    var rows = [];
    var cardPattern = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
    var match;

    while ((match = cardPattern.exec(html)) !== null) {
        var attributes = match[1] || "";
        var body = match[2] || "";

        var link = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
        var href = link ? (link[1] !== undefined ? link[1] : link[2]) : "";
        if (!href) {
            continue;
        }

        var title = /<span\b[^>]*\bclass\s*=\s*"[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body);
        if (!title) {
            // The <a title="…"> attribute carries the same text; use it rather than
            // dropping a card whose markup lost the span.
            var attribute = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
            title = attribute ? [null, attribute[1] !== undefined ? attribute[1] : attribute[2]] : null;
        }
        if (!title) {
            continue;
        }
        var name = decodeEntities(String(title[1]).replace(/<[^>]*>/g, "").trim());
        if (!name) {
            continue;
        }

        var image = attributeValue(attributes, "data-main-thumb") ||
            attributeValue(body, "src");
        // An absolute URL only: a root-relative one would need resolving, and
        // JavaScriptCore has no URL global to do it with.
        if (image && !/^https?:\/\//i.test(image)) {
            image = "";
        }

        rows.push({ title: name, image: image, href: href });
    }
    return rows;
}

/** The value of a double- or single-quoted attribute, or "" when absent. */
function attributeValue(html, name) {
    var found = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(html);
    return found ? (found[1] !== undefined ? found[1] : found[2]) : "";
}


// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * One request. Resolves to {kind:'ok'|'error'|'http', …} and never rejects.
 *
 * fetchv2's failure shapes, all of which RESOLVE (setupFetchV2 in
 * JavaScriptCore+Extensions.swift):
 *   - an unusable URL  -> the bare String "Invalid URL"
 *   - a transport fault -> {error: …} with no status key
 *   - an oversized body -> 200-shaped with an empty body
 */
function fetchOnce(url) {
    return fetchv2(url).then(function (res) {
        // Checked first: res.status on a String is undefined, so a status check
        // alone would let this through and read as a success.
        if (typeof res === "string") {
            return { kind: "error", reason: "bad-request" };
        }
        if (!res || typeof res !== "object") {
            return { kind: "error", reason: "bad-response" };
        }
        if (res.error) {
            return { kind: "error", reason: "transport" };
        }

        var status = res.status;
        var body = res._data;
        if (typeof body !== "string") {
            body = (body === undefined || body === null) ? "" : String(body);
        }

        if (typeof status !== "number" || status < 200 || status >= 300) {
            // Not a transport failure — the provider answered. 403 and 429 are
            // conditions rather than outages and must not be conflated with one.
            return { kind: "http", status: typeof status === "number" ? status : 0 };
        }

        return { kind: "ok", status: status, body: body };
    });
}

/**
 * One request, retried once if the connection dropped.
 *
 * A transport fault is the one failure that is genuinely worth a second ask:
 * the app logged "The network connection was lost" mid-search, and the same
 * request routinely succeeds immediately afterwards. A status code is not
 * retried — that is an answer, and asking again for an answer already in hand
 * only doubles the wait on a server that is already slow (§49).
 */
function get(url) {
    return fetchOnce(url).then(function (result) {
        if (result.kind !== "error") {
            return result;
        }
        return fetchOnce(url);
    });
}

/** Parse without risking a rejection, so malformed is a state, not a crash. */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * A log-safe description of a failed fetch: the status when there is one, the
 * failure reason when there is not. Never includes the response body, which may
 * be a full HTML page.
 */
function describe(result) {
    if (result.status) {
        return "HTTP " + result.status;
    }
    return String(result.reason);
}

// ---------------------------------------------------------------------------
// Page cache
// ---------------------------------------------------------------------------

// One entry. The host dispatches extractDetails and extractEpisodes
// concurrently on the same URL and calls extractStreamUrl on it afterwards, so
// memoising the in-flight promise collapses three fetches into one. Holding a
// single URL keeps the cache bounded.
//
// The TTL is a real trade, not a free win. The contentUrl is tokenised, so a
// cache that outlives the token would hand back a stream that will not play
// (§25) — but the token is far more durable than it looks: one captured over an
// hour earlier still returned 200 when re-checked. Meanwhile the provider's own
// server is slow and wildly variable (the same request measured anywhere from
// 1.7 s to 18 s), so an extra page fetch before playback is what turns a
// two-second wait into a twenty-second blank screen. Five minutes comfortably
// covers open-details-then-press-play, and still refetches on a later revisit.

var cachedUrl = null;
var cachedAt = 0;
var cachedPage = null;

function loadPage(url) {
    if (cachedPage !== null && cachedUrl === url && (Date.now() - cachedAt) < PAGE_TTL_MS) {
        return cachedPage;
    }
    cachedUrl = url;
    cachedAt = Date.now();
    cachedPage = get(url).then(function (result) {
        if (result.kind !== "ok") {
            console.log("pornmz page " + describe(result) + " for " + url);
            return "";
        }
        return result.body;
    });
    return cachedPage;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Decode the entity forms WordPress actually emits. Numeric first: &hellip;
 *  and &ndash; reach us as &#8230; / &#8211; inside attribute values. */
function decodeEntities(text) {
    return text.replace(/&#(\d+);/g, function (_, code) {
        return String.fromCharCode(parseInt(code, 10));
    }).replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

/**
 * The content of the <meta> tag(s) for one itemprop, read by scanning the tag
 * once and picking it out by attribute.
 *
 * Scanning beats the injected getAttribute() here for two reasons. It is
 * parameterised by the property being read, and the injected form only finds
 * the first tag carrying a given attribute — which is wrong for this page,
 * where itemprop="name" appears twice (the site, then the video) and only the
 * second is what a naive read would want.
 */
function metaContent(html, itemprop) {
    // WordPress emits double-quoted attributes; a theme change to single quotes
    // should degrade the module, not silently return nothing.
    var doubleQuoted = 'itemprop="' + itemprop + '"';
    var singleQuoted = "itemprop='" + itemprop + "'";
    var results = [];
    var tagPattern = /<meta\b[^>]*>/gi;
    var contentPattern = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/;
    var match;

    while ((match = tagPattern.exec(html)) !== null) {
        var tag = match[0];
        if (tag.indexOf(doubleQuoted) === -1 && tag.indexOf(singleQuoted) === -1) {
            continue;
        }
        var content = contentPattern.exec(tag);
        if (content) {
            results.push(decodeEntities(content[1] !== undefined ? content[1] : content[2]));
        }
    }

    if (META_REPEATS[itemprop] === false && results.length > 1) {
        // The page's shape changed. Refusing beats silently emitting a value
        // whose meaning is no longer known (§31 — no silent corruption).
        console.log("pornmz: " + results.length + " metas for " + itemprop);
        return null;
    }
    return results.length ? results[0] : null;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Search. The host requires exactly {title, image, href} as strings; a row
 * missing any of the three is dropped by the host's compactMap, so every row
 * carries all three.
 *
 * image is "" when a post has no featured media: the thumbnail is missing
 * upstream and inventing one would be a fabricated value (§31, §54). Losing the
 * whole result row over an absent thumbnail is the worse trade.
 *
 * Two kinds of query, and they return the same row shape:
 *
 *   browse  a sort keyword or "cat:slug", answered from the provider's own
 *           listing page and parsed out of its post cards
 *   search  anything else, answered from the WordPress REST API
 *
 * Neither app can be made to show a landing page: Sora has no home tab
 * (ContentView.swift lists exactly Library, Downloads, Settings, Search) and
 * both hosts refuse to call a module with an empty query (SearchView.swift:243).
 * A keyword the user chooses, or the setting in the module's own settings
 * screen, is the only way in.
 */
function searchResults(keyword) {
    // A browse chosen in the module's settings screen overrides the typed text.
    // Empty by default, so the shipped behaviour is exactly what it was: search
    // what was typed, and browse only on a keyword.
    var query = browseOverride() || String(keyword === undefined || keyword === null ? "" : keyword).trim();
    if (!query) {
        return Promise.resolve("[]");
    }

    var browse = listingUrl(query);
    var url = browse !== null ? browse :
        // _embed=wp:featuredmedia rather than _embed=1. Plain _embed resolves every
        // embeddable relation — author, terms, featured media — and this provider's
        // server pays for each one as an internal sub-request. Naming the single
        // relation the module actually reads returned byte-identical rows in a
        // median 2.6 s against 7.1 s, so the other two relations were pure latency
        // and load on someone else's server (§48, §49).
        BASE_URL + SEARCH_ENDPOINT + "?search=" + encodeURIComponent(query) +
        "&per_page=" + SEARCH_LIMIT + "&_embed=wp:featuredmedia";

    return get(url).then(function (result) {
        if (result.kind !== "ok") {
            console.log("pornmz search " + describe(result) + " for " + query);
            return "[]";
        }

        if (browse !== null) {
            var cards = parseCards(result.body);
            if (!cards.length) {
                // A 200 carrying no cards means the listing markup changed, or the
                // category slug does not exist. Saying so beats returning an empty
                // grid that reads as "this site has nothing".
                console.log("pornmz browse found no cards for " + query);
            }
            return JSON.stringify(cards);
        }

        var posts = parseJson(result.body);
        if (!posts) {
            console.log("pornmz search returned unreadable JSON for " + query);
            return "[]";
        }
        if (!Array.isArray(posts)) {
            // WordPress answers an unknown parameter with a {code, message}
            // object rather than an array.
            console.log("pornmz search returned " + (typeof posts) + ", not a list");
            return "[]";
        }

        var rows = [];
        for (var i = 0; i < posts.length; i++) {
            var post = posts[i] || {};
            var title = post.title && post.title.rendered;
            if (typeof title !== "string" || !title || typeof post.link !== "string" || !post.link) {
                continue;
            }
            rows.push({
                title: decodeEntities(title),
                image: featuredImage(post),
                href: post.link
            });
        }
        return JSON.stringify(rows);
    });
}

/** The post's thumbnail, or "" when it has none. */
function featuredImage(post) {
    var media = post._embedded && post._embedded["wp:featuredmedia"];
    if (!Array.isArray(media) || !media[0] || typeof media[0].source_url !== "string") {
        return "";
    }
    return media[0].source_url;
}

/**
 * Details: [{description, aliases, airdate}].
 *
 * aliases is empty by design. The page's og:title is this same title with
 * site boilerplate appended ("… – Free HD Porn Video – Pornmz"); that is not an
 * alternate name, and writing it into the alias field would surface the site's
 * marketing text in the app. The provider publishes no real alias, so the field
 * stays empty rather than being filled with something plausible.
 */
function extractDetails(url) {
    return loadPage(url).then(function (html) {
        if (!html) {
            return "[]";
        }
        return JSON.stringify([{
            description: metaContent(html, "description") || "",
            aliases: "",
            airdate: metaContent(html, "uploadDate") || ""
        }]);
    });
}

/**
 * Episodes: one post is one standalone video, so the honest model is a single
 * episode. The host discards title and duration in async mode, so only the two
 * fields it actually reads are emitted.
 *
 * Nothing here comes from the page. The episode *is* the URL the host is
 * already holding, so awaiting a fetch only to test that the page existed put
 * a network round-trip in front of an entry point that cannot fail — and on an
 * origin this slow that showed up in the app as a real "Timeout for
 * extractEpisodes" on a video that then played perfectly well. The page is
 * still fetched, just not awaited, so extractStreamUrl finds it warm.
 */
function extractEpisodes(url) {
    loadPage(url);
    return Promise.resolve(JSON.stringify([{ number: 1, href: url }]));
}

/**
 * Headers for the playlist request.
 *
 * Both hosts default the Referer to the module's own baseUrl when a source
 * carries no headers (Sora: CustomPlayer.swift, "Referer"/"Origin" = baseUrl;
 * Luna: MediaDetailView.swift, "Referer"/"Origin" = service.baseUrl). The
 * playlist is served from a different host entirely — Twitter's CDN — and that
 * CDN answers **403 Forbidden** to a pornmz.com referer while serving the same
 * URL fine with a referer of its own origin. So the referer has to travel with
 * the source, and the host has to be told.
 *
 * The value is derived from the playlist URL rather than hardcoded, so this
 * keeps working if the provider moves the video to a different CDN.
 */
function streamHeaders(streamUrl) {
    var origin = /^(https?:\/\/[^\/?#]+)/i.exec(streamUrl);
    return { "Referer": origin ? origin[1] : BASE_URL };
}

/**
 * The playable HLS playlist, straight from the page's VideoObject contentUrl.
 *
 * Returned as a `streams` array of source objects rather than a bare URL,
 * because a bare URL carries no headers and would draw the host's pornmz.com
 * referer, which the CDN rejects.
 *
 * An empty list when the page publishes no contentUrl. The host then reports no
 * playable source, which is the truth — falling back to the iframe player would
 * mean scraping a third-party embed for a URL that may not exist, and reporting
 * success when there is nothing to play (§31).
 */
function extractStreamUrl(url) {
    return loadPage(url).then(function (html) {
        var contentUrl = html ? metaContent(html, "contentUrl") : null;
        if (!contentUrl) {
            console.log("pornmz: no contentUrl published for " + url);
            return JSON.stringify({ streams: [] });
        }
        return JSON.stringify({
            streams: [{
                streamUrl: contentUrl,
                title: "HLS",
                headers: streamHeaders(contentUrl)
            }]
        });
    });
}
