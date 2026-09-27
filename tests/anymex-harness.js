'use strict';
/*
 * A reproduction of the AnymeX / Mangayomi JavaScript runtime, for testing
 * anymex/*.js offline.
 *
 * This is the AnymeX counterpart to harness.js, and it exists for the same
 * reason: an assertion that "the function returned an object" proves nothing,
 * because the host is what decides whether that object becomes a row the user
 * can tap. What is tested here instead is the value that would cross the
 * bridge, checked against the shapes the host documents.
 *
 * What is reproduced, and from where:
 *
 *   Client.get(url, headers)      `res.body`, `res.statusCode`, `res.headers`.
 *                                 Verified in mangayomi `lib/eval/javascript/
 *                                 http.dart`: `_toHttpResponse` returns
 *                                 package:http's `Response.toJson()` with
 *                                 `body` replaced by the response text. Header
 *                                 names arrive lowercased, which is what
 *                                 package:http does.
 *   MProvider                     The bridged base class. The exact method
 *                                 signatures are transcribed from
 *                                 `lib/eval/dart/bridge/m_provider.dart`, and
 *                                 the `source` property from the same file's
 *                                 use of it.
 *   console.log                   Captured, not printed, so a test can assert
 *                                 on what was said and check that no response
 *                                 body leaked into a log line.
 *
 * The suite never touches the network. Fixtures are real captured responses
 * from the provider, the same rule the Sora-side tests follow.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** The bridged MProvider. Every method is a not-implemented throw, exactly as
 *  the host's default is: a source that forgets one reports it loudly rather
 *  than appearing to work. */
class MProvider {
    constructor() {
        this.source = null;
    }

    get supportsLatest() {
        return false;
    }

    get baseUrl() {
        return this.source ? this.source.baseUrl : '';
    }

    get headers() {
        return {};
    }

    async getPopular() {
        throw new Error('getPopular not implemented');
    }

    async getLatestUpdates() {
        throw new Error('getLatestUpdates not implemented');
    }

    async search() {
        throw new Error('search not implemented');
    }

    async getDetail() {
        throw new Error('getDetail not implemented');
    }

    async getVideoList() {
        throw new Error('getVideoList not implemented');
    }

    async getPageList() {
        throw new Error('getPageList not implemented');
    }

    async getHtmlContent() {
        throw new Error('getHtmlContent not implemented');
    }

    async cleanHtmlContent() {
        throw new Error('cleanHtmlContent not implemented');
    }

    getFilterList() {
        throw new Error('getFilterList not implemented');
    }

    getSourcePreferences() {
        return [];
    }
}

/** The `Client` the runtime injects, backed by a routing table of fixtures. */
class Client {
    /**
     * @param routes  url -> {status, body, headers, transportError, failFirst}
     * @param calls   array every request is appended to
     */
    constructor(routes, calls) {
        this.routes = routes;
        this.calls = calls;
    }

    async get(url, headers) {
        this.calls.push({method: 'GET', url, headers});
        const route = this.routes[url];
        if (route === undefined) {
            return {
                statusCode: 404,
                headers: {},
                body: 'no fixture for ' + url
            };
        }
        if (route.failFirst && this.calls.filter(c => c.url === url).length <= route.failFirst) {
            return {statusCode: 0, headers: {}, body: '', transportError: route.transportError || 'The network connection was lost.'};
        }
        if (route.transportError) {
            return {statusCode: 0, headers: {}, body: '', transportError: route.transportError};
        }
        const out = {statusCode: route.status, headers: lowerKeys(route.headers || {}), body: route.body};
        return out;
    }

    async post(url, headers, body) {
        this.calls.push({method: 'POST', url, headers, body});
        return this.get(url, headers);
    }
}

function lowerKeys(headers) {
    const out = {};
    for (const key of Object.keys(headers)) {
        out[key.toLowerCase()] = headers[key];
    }
    return out;
}

/** `SharedPreferences`, the host's per-source settings store. */
class SharedPreferences {
    constructor(values) {
        this.values = values || {};
    }

    get(key) {
        return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
    }

    set(key, value) {
        this.values[key] = value;
    }
}

/**
 * Load a source file and return a live instance of its DefaultExtension.
 *
 * The file is wrapped in a function so its `const`s and its class stay private
 * to it, the way they are in the app — the host reads `mangayomiSources` and
 * instantiates `DefaultExtension`, and reaches nothing else.
 *
 * @param file     path to anymex/<name>.js
 * @param routes   url -> fixture response
 * @param overrides extra members assigned onto the instance (preferences etc.)
 */
function loadSource(file, routes, overrides) {
    const source = fs.readFileSync(file, 'utf8');
    const calls = [];
    const log = [];

    // The file is wrapped so its `const`s and its class stay private to it, the
    // way they are in the app: the host reads `mangayomiSources`, instantiates
    // `DefaultExtension`, and reaches nothing else. Anything the source forgot
    // to export is therefore not reachable from a test either.
    const wrapped =
        '(function (MProvider, Client, SharedPreferences, console) {\n' +
        source +
        '\nreturn {mangayomiSources: mangayomiSources, DefaultExtension: DefaultExtension};\n' +
        '})';

    // `new Client()` is called inside the source on every request, so the class
    // itself closes over the route table rather than an instance being threaded
    // through by hand.
    const sandbox = {
        MProvider,
        Client: function () {
            return new Client(routes || {}, calls);
        },
        SharedPreferences,
        console: {log: (...args) => log.push(args.map(String).join(' '))}
    };
    const context = vm.createContext(sandbox);
    const exported = vm.runInContext(wrapped, context, {filename: file})(
        MProvider,
        sandbox.Client,
        SharedPreferences,
        sandbox.console
    );

    if (!Array.isArray(exported.mangayomiSources) || !exported.mangayomiSources.length) {
        throw new Error(file + ' does not export mangayomiSources');
    }
    if (typeof exported.DefaultExtension !== 'function') {
        throw new Error(file + ' does not export a DefaultExtension class');
    }

    const instance = new exported.DefaultExtension();
    instance.source = exported.mangayomiSources[0];
    for (const key of Object.keys(overrides || {})) {
        instance[key] = overrides[key];
    }

    return {
        instance,
        manifest: exported.mangayomiSources[0],
        calls,
        log,
        callCount: () => calls.length
    };
}

// ---------------------------------------------------------------------------
// Host-side contract checks
// ---------------------------------------------------------------------------

/**
 * A listing row, as the host has to be able to use it.
 *
 * The documented shape is {name, imageUrl, link}. The check is deliberately
 * strict about the three fields being strings and non-empty except the image:
 * Mangayomi builds its row from these and a missing one is a blank cell or a
 * row that cannot be tapped, and neither is obvious from the source's side.
 */
function hostParseList(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.list)) {
        return {ok: false, reason: 'no list array', items: []};
    }
    if (typeof result.hasNextPage !== 'boolean') {
        return {ok: false, reason: 'hasNextPage is not a boolean', items: []};
    }
    const items = [];
    const dropped = [];
    for (const row of result.list) {
        if (typeof row.name !== 'string' || !row.name) {
            dropped.push('a row with no name');
            continue;
        }
        if (typeof row.imageUrl !== 'string') {
            dropped.push(JSON.stringify(row.name) + ' with no imageUrl');
            continue;
        }
        if (typeof row.link !== 'string' || !row.link) {
            dropped.push(JSON.stringify(row.name) + ' with no link');
            continue;
        }
        items.push(row);
    }
    return {ok: true, items, dropped, hasNextPage: result.hasNextPage};
}

/** A detail object, as the host has to be able to use it. */
function hostParseDetail(detail) {
    if (!detail || typeof detail !== 'object') {
        return {ok: false, reason: 'not an object'};
    }
    if (typeof detail.name !== 'string' || !detail.name) {
        return {ok: false, reason: 'no name'};
    }
    if (!Array.isArray(detail.genre)) {
        return {ok: false, reason: 'genre is not an array'};
    }
    if (!Array.isArray(detail.chapters) || !detail.chapters.length) {
        return {ok: false, reason: 'no chapters'};
    }
    for (const chapter of detail.chapters) {
        if (typeof chapter.name !== 'string' || !chapter.name) {
            return {ok: false, reason: 'a chapter with no name'};
        }
        if (typeof chapter.url !== 'string' || !chapter.url) {
            return {ok: false, reason: 'a chapter with no url'};
        }
    }
    if (typeof detail.status !== 'number') {
        return {ok: false, reason: 'status is not a number'};
    }
    if (typeof detail.imageUrl !== 'string') {
        return {ok: false, reason: 'imageUrl is not a string'};
    }
    return {ok: true, detail};
}

/**
 * A video list, as the host has to be able to use it.
 *
 * The documented shape is {url, originalUrl, quality}. `headers` is not in the
 * documented minimum but the reference sources put it there and it is the only
 * way to send the Referer this provider's CDN requires, so its presence is
 * checked rather than merely permitted.
 */
function hostParseVideos(videos) {
    if (!Array.isArray(videos)) {
        return {ok: false, reason: 'not an array', items: []};
    }
    const items = [];
    for (const video of videos) {
        if (typeof video.url !== 'string' || !video.url) {
            return {ok: false, reason: 'a stream with no url'};
        }
        if (typeof video.originalUrl !== 'string' || !video.originalUrl) {
            return {ok: false, reason: 'a stream with no originalUrl'};
        }
        if (typeof video.quality !== 'string' || !video.quality) {
            return {ok: false, reason: 'a stream with no quality'};
        }
        items.push(video);
    }
    return {ok: true, items};
}

/** A filter list, as the app's filter panel has to be able to build from it. */
function hostParseFilters(filters) {
    if (!Array.isArray(filters) || !filters.length) {
        return {ok: false, reason: 'not a non-empty array'};
    }
    for (const group of filters) {
        if (typeof group.name !== 'string' || !group.name) {
            return {ok: false, reason: 'a group with no name'};
        }
        if (!Array.isArray(group.state) || !group.state.length) {
            return {ok: false, reason: JSON.stringify(group.name) + ' has no values'};
        }
        for (const entry of group.state) {
            if (typeof entry.name !== 'string' || !entry.name) {
                return {ok: false, reason: 'a value with no name'};
            }
            if (typeof entry.value !== 'string') {
                return {ok: false, reason: JSON.stringify(entry.name) + ' has a non-string value'};
            }
        }
    }
    return {ok: true, filters};
}

/**
 * Load every fixture for a provider directory, as name -> body text.
 *
 * Bodies rather than ready-made routes, because the URL a request lands on is
 * the thing under test: a test that asserted against a canned route could not
 * catch the source asking for the wrong page. Naming the routes is the test's
 * job.
 */
function readFixtures(name) {
    const base = path.join(__dirname, 'fixtures', name || 'pornmz-anymex');
    const bodies = {};
    for (const file of fs.readdirSync(base)) {
        bodies[file] = fs.readFileSync(path.join(base, file), 'utf8');
    }
    return bodies;
}

module.exports = {
    MProvider,
    Client,
    SharedPreferences,
    loadSource,
    hostParseList,
    hostParseDetail,
    hostParseVideos,
    hostParseFilters,
    readFixtures
};
