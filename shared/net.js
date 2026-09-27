/*
 * net.js — the module's whole network layer.
 *
 * Sora evaluates exactly one script per module, so there is no `require` and no
 * import: a module CANNOT load a shared file at runtime. This file is the
 * canonical, separately tested version of the helper; each provider's module.js
 * carries its own copy and says so in a comment. If you change this, change the
 * copies. tests/net.test.js covers this file; each provider's test file covers
 * the copy that actually ships.
 *
 * Why the helper exists at all:
 *
 * `fetchv2` RESOLVES on failure instead of rejecting, and its failure shapes are
 * inconsistent (JavaScriptCore+Extensions.swift, setupFetchV2):
 *
 *   - an unparseable URL resolves as the bare String "Invalid URL"
 *   - a transport failure resolves as {error: …} with NO status key
 *   - a body too large to decode resolves 200-shaped with an empty body
 *
 * So `try { … } catch` around a fetch catches nothing useful, which is how a
 * module ends up reporting "no results" when the provider was actually down.
 * get() folds all of that into one value the caller can branch on.
 *
 * kind is what lets a module tell "nothing found" from "the provider is
 * unreachable" and log the right thing (§8, §52). The host collapses every
 * failure to an empty array, so the distinction only exists here.
 */

/** One request. Resolves to {kind: 'ok'|'error'|'http', …}; never rejects. */
function fetchOnce(url) {
    return fetchv2(url).then(function (res) {
        // "Invalid URL" arrives as a String, not a response object, so reading
        // .status off it yields undefined and would sail past a status check.
        // This is the first branch for that reason.
        if (typeof res === 'string') {
            return { kind: 'error', reason: 'bad-request', detail: res };
        }
        if (!res || typeof res !== 'object') {
            return { kind: 'error', reason: 'bad-response' };
        }
        if (res.error) {
            return { kind: 'error', reason: 'transport', detail: String(res.error) };
        }

        var status = res.status;
        var body = res._data;
        if (typeof body !== 'string') {
            body = (body === undefined || body === null) ? '' : String(body);
        }

        if (typeof status !== 'number' || status < 200 || status >= 300) {
            // A non-2xx is NOT a transport failure: the provider answered. 403
            // and 429 especially are conditions, not outages, and must not be
            // handled as though the host were unreachable.
            return { kind: 'http', status: typeof status === 'number' ? status : 0, body: body };
        }

        return { kind: 'ok', status: status, body: body };
    });
}

/**
 * One request, retried once if the connection dropped.
 *
 * A transport fault is the one failure worth a second ask: it means the request
 * never reached the provider, which on a mobile connection is routinely a
 * momentary blip rather than an outage. A status code is NOT retried — that is
 * an answer, and re-asking for an answer already in hand only doubles the wait.
 */
function get(url) {
    return fetchOnce(url).then(function (result) {
        if (result.kind !== 'error') return result;
        return fetchOnce(url);
    });
}

/**
 * Parse a body that get() already accepted, without risking a rejection.
 * Returns {value, error} so a malformed body is a reportable state rather than
 * an exception. (fetchv2's own .json() REJECTS on malformed input.)
 */
function parseJson(text) {
    try {
        return { value: JSON.parse(text), error: null };
    } catch (e) {
        return { value: null, error: e.message };
    }
}

/**
 * Reduce a fetchv2 result to a log-safe one-liner. A status number is the most
 * specific thing available; a transport failure has no status, so its `reason`
 * is logged instead. Never returns the body: it may be a full HTML page, and
 * logging response payloads is exactly what §52 forbids.
 */
function describe(result) {
    if (result.status) return 'HTTP ' + result.status;
    return String(result.reason);
}
