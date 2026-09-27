'use strict';
/*
 * Tests for shared/net.js.
 *
 * Each case is a real branch of setupFetchV2 in JavaScriptCore+Extensions.swift.
 * The point is that a module using this helper can tell the six response states
 * apart; a regression here would silently merge them again, which is how "the
 * provider is down" turns into "no results found".
 *
 * The inlined copy inside modules/pornmz/module.js carries the same logic, and
 * tests/pornmz.test.js covers the copy that actually ships.
 */

const fs = require('fs');
const path = require('path');
const test = require('./test');
const h = require('./harness');

const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'net.js'), 'utf8');

function withRoutes(routes) {
    return h.loadSource(source, routes).context;
}

test('ok: a 200 with a body is kind=ok and exposes it', async () => {
    const ctx = withRoutes({ 'https://p.test/a': { status: 200, body: '{"items":[]}' } });
    const res = await ctx.get('https://p.test/a');
    test.equal(res.kind, 'ok', 'kind');
    test.equal(res.status, 200, 'status');
    test.equal(res.body, '{"items":[]}', 'body');
    test.deepEqual(ctx.parseJson(res.body).value, { items: [] }, 'json parsed');
});

test('transport error is distinguishable from an HTTP error', async () => {
    const ctx = withRoutes({
        'https://p.test/down': { transportError: 'A server with the specified hostname could not be found.' }
    });
    const res = await ctx.get('https://p.test/down');
    test.equal(res.kind, 'error', 'kind is error, not http');
    test.equal(res.reason, 'transport', 'reason');
    test.equal(ctx.describe(res), 'transport', 'log line names the reason');
});

test('"Invalid URL" arrives as a bare string, not an object', async () => {
    // setupFetchV2 resolves this with resolve.call(withArguments: ["Invalid URL"])
    // — a String. Reading .status off it yields undefined and would sail past a
    // status check, which is exactly the bug this guards.
    const ctx = withRoutes({ 'https://p.test/bad': { invalidUrl: true } });
    const res = await ctx.get('https://p.test/bad');
    test.equal(res.kind, 'error', 'kind');
    test.equal(res.reason, 'bad-request', 'reason');
});

test('non-2xx is kind=http and keeps the status', async () => {
    // 403 and 429 are conditions, not outages, and must not be retried as if the
    // host were unreachable.
    const ctx = withRoutes({
        'https://p.test/403': { status: 403, body: 'forbidden' },
        'https://p.test/429': { status: 429, body: 'slow down' },
        'https://p.test/500': { status: 500, body: 'oops' }
    });
    for (const status of [403, 429, 500]) {
        const res = await ctx.get('https://p.test/' + status);
        test.equal(res.kind, 'http', status + ' kind');
        test.equal(res.status, status, status + ' status kept');
        test.equal(ctx.describe(res), 'HTTP ' + status, status + ' log line');
    }
});

test('a 200 with an empty body is ok, not an error', async () => {
    // setupFetchV2 resolves 200-shaped with body:"" when decoding fails outright.
    // That is a successful empty response and must not read as an outage.
    const ctx = withRoutes({ 'https://p.test/empty': { status: 200, body: '' } });
    const res = await ctx.get('https://p.test/empty');
    test.equal(res.kind, 'ok', 'kind');
    test.equal(res.body, '', 'empty body');
    test.equal(ctx.parseJson(res.body).value, null, 'and it does not parse as JSON');
});

test('a response with no status at all is not treated as a success', async () => {
    const ctx = withRoutes({ 'https://p.test/nostatus': { status: 'weird', body: 'x' } });
    const res = await ctx.get('https://p.test/nostatus');
    test.equal(res.kind, 'http', 'kind');
    test.equal(res.status, 0, 'status normalised to 0 rather than left undefined');
});

test('parseJson reports malformed input instead of throwing', async () => {
    // fetchv2's own .json() REJECTS on malformed input, which surfaces as an
    // unhandled rejection. This never does.
    const ctx = withRoutes({ 'https://p.test/html': { status: 200, body: '<html>nope</html>' } });
    const res = await ctx.get('https://p.test/html');
    test.equal(res.kind, 'ok', 'the HTTP exchange did succeed');
    test.equal(ctx.parseJson(res.body).value, null, 'no value');
});

test('get forwards the url to fetchv2 with the default GET shape', async () => {
    const ctx = withRoutes({ 'https://p.test/p': { status: 200, body: '{}' } });
    await ctx.get('https://p.test/p');
    test.equal(ctx.calls.length, 1, 'exactly one network call');
    test.equal(ctx.calls[0].url, 'https://p.test/p', 'url forwarded');
    test.equal(ctx.calls[0].method, 'GET', 'method defaulted');
    test.equal(ctx.calls[0].redirect, true, 'redirect defaulted');
});

test('a module cannot use `new URL()` — JavaScriptCore has none', () => {
    // Deliberately left undefined. If this ever passes because Node leaked a URL
    // into the sandbox, a module could come to depend on it and throw on device.
    const ctx = withRoutes({});
    test.equal(typeof ctx.URL, 'undefined', 'URL is not present in the module context');
});

test('describe never returns a response body', () => {
    // §52: a log line must not carry a payload.
    const ctx = withRoutes({});
    test.equal(ctx.describe({ kind: 'http', status: 429, body: 'A'.repeat(5000) }),
        'HTTP 429', 'status only');
    test.ok(ctx.describe({ kind: 'ok', status: 200, body: 'secret' }).indexOf('secret') === -1,
        'no body leaks through an ok result either');
});

test.run();
