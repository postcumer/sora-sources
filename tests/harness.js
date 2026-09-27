'use strict';
/*
 * Test harness: reproduces the Sora module runtime closely enough that a module
 * which passes here is not obviously broken in the app.
 *
 * The important part is not the mocks — it is that the assertions run the module
 * through the *host's* parsing logic, transcribed from the Swift. A module can
 * look right and still be invisible to Sora: in async mode the host does
 * `JSON.parse(result.toString())`, so a resolved array yields nothing. Tests that
 * only check "does it return an array" cannot catch that; tests that check "does
 * the host get a parseable JSON string" do.
 *
 * The Swift this mirrors (see COMPATIBILITY.md for citations):
 *   - JavaScriptCore+Extensions.swift, setupJavaScriptEnvironment / setupFetchV2
 *   - JSController-Search.swift, fetchJsSearchResults
 *   - JSController-Details.swift, fetchDetailsJS
 *   - JSController-Streams.swift, parseStreamResult / streamOptions
 *   - MediaInfoView.swift, streamOptions(fromSources:)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// fetchv2
// ---------------------------------------------------------------------------

/*
 * Transcribed from setupFetchV2. The failure modes matter more than the happy
 * path, and they are the part community modules get wrong:
 *
 *   - every failure RESOLVES; nothing rejects except a malformed .json()
 *   - "Invalid URL" resolves as a bare string, not an object
 *   - transport failure resolves as {error} with NO status key
 *   - an undecodable body resolves 200-shaped with an empty body
 */
class Response {
    constructor(fields) { Object.assign(this, fields); }
    text() { return Promise.resolve(this._data); }
    json() {
        try { return Promise.resolve(JSON.parse(this._data)); }
        catch (e) { return Promise.reject('JSON parse error: ' + e.message); }
    }
}

function makeFetchV2(routes, log, calls) {
    // Per-URL request counts, so a fixture can describe a connection that
    // fails once and then succeeds — the shape a real flaky network produces
    // and the only way to test a retry honestly.
    const seen = {};

    return function fetchv2(url, headers = {}, method = 'GET', body = null, redirect = true, encoding) {
        return new Promise(function (resolve) {
            log.push('REQ ' + method + ' ' + url);
            if (calls) {
                calls.push({
                    url: url, headers: headers, method: method,
                    body: body, redirect: redirect, encoding: encoding
                });
            }
            seen[url] = (seen[url] || 0) + 1;
            const route = routes[url];
            if (!route) {
                // Not what Swift does, but a missing fixture should fail loudly
                // in tests rather than quietly exercise a fallback branch.
                return resolve(new Response({ error: 'no fixture for ' + url }));
            }
            if (route.hang) {
                // A request that never answers. Mirrors the app's own
                // "Timeout for extractEpisodes" and lets a test assert that an
                // entry point resolves without waiting for the network.
                return;
            }
            if (route.transportError && (!route.failFirst || seen[url] <= route.failFirst)) {
                return resolve(new Response({ error: route.transportError }));
            }
            if (route.invalidUrl) {
                return resolve('Invalid URL');
            }
            if (route.status === 'invalidUrlString') {
                return resolve('Invalid URL');
            }
            if (route.undecodable) {
                return resolve(new Response({ status: 200, headers: {}, _data: '' }));
            }

            resolve(new Response({
                status: route.status || 200,
                headers: route.headers || {},
                _data: route.body === undefined ? '' : route.body
            }));
        });
    };
}

// ---------------------------------------------------------------------------
// The other injected globals
// ---------------------------------------------------------------------------

function makeEnvironment(routes, log, calls) {
    const env = {
        // JavaScriptCore provides no `URL`, and the host injects no polyfill.
        // Deliberately left undefined so a module that reaches for `new URL()`
        // fails here the same way it would on device.
        URL: undefined,

        fetchv2: makeFetchV2(routes, log, calls),

        // setupNativeFetch — a Promise of a plain String, no status code.
        // Provided so a module that reaches for it is caught by review, not by a
        // confusing test failure.
        fetch: function (url, headers) {
            log.push('REQ fetch ' + url);
            const route = routes[url];
            if (!route) return Promise.reject('no fixture');
            return Promise.resolve(route.body || '');
        },

        btoa: function (s) { return Buffer.from(s, 'utf8').toString('base64'); },
        atob: function (s) { return Buffer.from(s, 'base64').toString('utf8'); },

        console: {
            log: function (m) { log.push('LOG ' + m); },
            error: function (m) { log.push('ERR ' + m); }
        },
        log: function (m) { log.push('LOG ' + m); },

        // Regex scraping helpers, transcribed from setupScrapingUtilities.
        getElementsByTag: function (html, tag) {
            const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi');
            const out = []; let m;
            while ((m = re.exec(html)) !== null) out.push(m[1]);
            return out;
        },
        getAttribute: function (html, tag, attr) {
            const re = new RegExp('<' + tag + '[^>]*' + attr + '=["\']?([^"\' >]+)["\']?[^>]*>', 'i');
            const m = re.exec(html);
            return m ? m[1] : null;
        },
        getInnerText: function (html) {
            return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        },
        stripHtml: function (html) { return html.replace(/<[^>]+>/g, ''); },
        normalizeWhitespace: function (s) { return s.replace(/\s+/g, ' ').trim(); },
        extractBetween: function (str, start, end) {
            const s = str.indexOf(start);
            if (s === -1) return '';
            const e = str.indexOf(end, s + start.length);
            if (e === -1) return '';
            return str.substring(s + start.length, e);
        },
        urlEncode: function (s) { return encodeURIComponent(s); },
        urlDecode: function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } },
        htmlEntityDecode: function (str) {
            return str.replace(/&([a-zA-Z]+);/g, function (_, entity) {
                const map = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
                return map[entity] || _;
            });
        },
        transformResponse: function (response, fn) {
            try { return fn(response); } catch (e) { return response; }
        }
    };
    return env;
}

// ---------------------------------------------------------------------------
// Host-side parsing — the part that decides what the user actually sees
// ---------------------------------------------------------------------------

/*
 * JSValue.toString() in JavaScriptCore. An array stringifies to its elements
 * joined by commas, an object to "[object Object]", null to "null". Reproducing
 * this is what makes the async-mode contract testable.
 */
function jsValueToString(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(jsValueToString).join(',');
    return '[object Object]';
}

/** fetchJsSearchResults then-callback, with its guards. */
function hostParseSearch(resolved) {
    if (resolved === null || resolved === undefined) {
        return { ok: false, reason: 'null', items: [] };
    }
    const json = jsValueToString(resolved);
    let array;
    try { array = JSON.parse(json); }
    catch (e) { return { ok: false, reason: 'not JSON: ' + json.slice(0, 80), items: [] }; }

    if (!Array.isArray(array)) {
        return { ok: false, reason: 'not an array', items: [] };
    }
    // compactMap: a row missing any of the three is skipped, not fatal.
    const items = [];
    for (const row of array) {
        if (typeof row.title === 'string' && typeof row.image === 'string' && typeof row.href === 'string') {
            items.push(row);
        }
    }
    return { ok: true, items };
}

/**
 * fetchDetailsJS thenEpisodes — the ASYNC branch, which is the mode these
 * modules use:
 *
 *   number: $0["number"] as? Int ?? 0
 *
 * so a non-numeric number is kept and coerced to 0, not dropped. Sync mode
 * instead does Int(numberString) and silently discards the row. That
 * difference is why the module contract lints the number field, and why
 * hostParseEpisodes below keeps the row.
 */
function hostParseEpisodes(resolved) {
    if (resolved === null || resolved === undefined) {
        return { ok: false, reason: 'null', episodes: [] };
    }
    const json = jsValueToString(resolved);
    let array;
    try { array = JSON.parse(json); }
    catch (e) { return { ok: false, reason: 'not JSON: ' + json.slice(0, 80), episodes: [] }; }

    if (!Array.isArray(array)) return { ok: false, reason: 'not an array', episodes: [] };

    const episodes = array.map(function (ep) {
        const n = typeof ep.number === 'number' ? ep.number
            : (typeof ep.number === 'string' ? parseInt(ep.number, 10) : NaN);
        return Object.assign({}, ep, { number: isNaN(n) ? 0 : n });
    });
    return { ok: true, episodes };
}

function hostParseDetails(resolved) {
    if (resolved === null || resolved === undefined) {
        return { ok: false, reason: 'null', items: [] };
    }
    const json = jsValueToString(resolved);
    let array;
    try { array = JSON.parse(json); }
    catch (e) { return { ok: false, reason: 'not JSON: ' + json.slice(0, 80), items: [] }; }
    if (!Array.isArray(array)) return { ok: false, reason: 'not an array', items: [] };
    return { ok: true, items: array };
}

/** parseStreamResult, transcribed. Returns the same triple Sora builds. */
function hostParseStream(jsonString) {
    let obj = null;
    try { obj = JSON.parse(jsonString); } catch (e) { obj = null; }

    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        let streams = null, subtitles = null, sources = null;

        if (Array.isArray(obj.streams) && obj.streams.every(s => typeof s === 'object' && s !== null)) {
            sources = obj.streams;
        } else if (obj.stream !== null && typeof obj.stream === 'object') {
            sources = [obj.stream];
        } else if (Array.isArray(obj.streams) && obj.streams.every(s => typeof s === 'string')) {
            streams = obj.streams;
        } else if (typeof obj.stream === 'string') {
            streams = [obj.stream];
        }

        if (Array.isArray(obj.subtitles)) subtitles = obj.subtitles;
        else if (typeof obj.subtitles === 'string') subtitles = [obj.subtitles];

        return { streams: streams, subtitles: subtitles, sources: sources };
    }

    if (Array.isArray(obj) && obj.every(s => typeof s === 'string')) {
        return { streams: obj, subtitles: null, sources: null };
    }

    // "Using raw string as stream URL" — the host treats unparseable output as a
    // literal URL. Almost always a module bug, so tests assert we do not land here.
    return { streams: [jsonString], subtitles: null, sources: null, fellBack: true };
}

/** MediaInfoView.streamOptions(fromSources:) — which sources are actually playable. */
function hostStreamOptions(parsed) {
    const options = [];
    if (parsed.sources && parsed.sources.length) {
        parsed.sources.forEach((source, idx) => {
            const rawUrl = (typeof source.streamUrl === 'string' && source.streamUrl)
                ? source.streamUrl
                : source.url;
            if (typeof rawUrl !== 'string' || !rawUrl) return;
            let title = typeof source.title === 'string' ? source.title.trim() : null;
            options.push({
                title: (title && title.length) ? title : 'Stream ' + (idx + 1),
                url: rawUrl,
                headers: source.headers || null,
                subtitle: source.subtitle || null
            });
        });
    } else if (parsed.streams && parsed.streams.length) {
        let index = 0, unnamed = 1;
        while (index < parsed.streams.length) {
            const entry = parsed.streams[index];
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
                options.push({ title: 'Stream ' + unnamed++, url: entry, headers: null, subtitle: null });
                index += 1;
            } else {
                const next = parsed.streams[index + 1];
                if (next && /^[a-z][a-z0-9+.-]*:\/\//i.test(next)) {
                    options.push({ title: entry, url: next, headers: null, subtitle: null });
                    index += 2;
                } else {
                    index += 1;
                }
            }
        }
    }
    return options;
}

// ---------------------------------------------------------------------------
// Loading a module
// ---------------------------------------------------------------------------

/**
 * Evaluate a module script in a context that has the Sora globals, exactly as
 * JSController.loadScript does (fresh context, environment injected, then the
 * script). Throws if the script leaves a pending exception, mirroring the check
 * in loadScript — a module that throws at load poisons every later call.
 */
function loadModule(moduleDir, routes, settings) {
    const log = [];
    const calls = [];
    const sandbox = makeEnvironment(routes || {}, log, calls);
    const context = vm.createContext(sandbox);

    const scriptPath = path.join(moduleDir, 'module.js');
    let source = fs.readFileSync(scriptPath, 'utf8');
    if (settings) {
        // Go through the real rewriter rather than string-replacing in the test,
        // so a settings block that Sora could not parse is caught here.
        source = writeSettingsToFile(source, settings);
    }
    vm.runInContext(source, context, { filename: scriptPath });

    if (vm.runInContext('typeof searchResults === "undefined" && ' +
                        'typeof extractStreamUrl === "undefined"', context)) {
        throw new Error('module.js defines none of the expected entry points');
    }

    return { context: context, log: log, calls: calls, routes: routes || {} };
}

// ---------------------------------------------------------------------------
// Module settings
//
// Transcriptions of the two Swift functions that make a module's `const`
// declarations into a settings screen:
//
//   parseSettingsSchema    ModuleSettings.swift:120-167
//   writeSettingsToFile    ModuleManager.swift:266-296
//
// A module's only user-facing UI is whatever these two functions surface, so they
// are part of the contract and are reproduced rather than mocked.
// ---------------------------------------------------------------------------

/** Sora's schema scan: `const` lines between the two marker comments. */
function parseSettingsSchema(source) {
    const start = source.indexOf('// Settings start');
    const end = start === -1 ? -1 : source.indexOf('// Settings end', start);
    if (start === -1 || end === -1) return [];

    const block = source.slice(start + '// Settings start'.length, end);
    const entries = [];

    // Swift: ^const\s+(\w+)\s*=\s*(.+?);(?:\s*//\s*(.*))?$ — matched per trimmed line.
    const pattern = /^const\s+(\w+)\s*=\s*(.+?);(?:\s*\/\/\s*(.*))?$/;
    for (const raw of block.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;
        const m = pattern.exec(line);
        if (!m) continue;

        let defaultValue = m[2].trim();
        if ((defaultValue.startsWith('"') && defaultValue.endsWith('"')) ||
            (defaultValue.startsWith("'") && defaultValue.endsWith("'"))) {
            defaultValue = defaultValue.slice(1, -1);
        }

        let type;
        if (/^-?\d+$/.test(defaultValue)) type = 'int';
        else if (defaultValue.includes('.') && !isNaN(Number(defaultValue))) type = 'float';
        else if (defaultValue.toLowerCase() === 'true' || defaultValue.toLowerCase() === 'false') type = 'bool';
        else type = 'string';

        entries.push({
            key: m[1],
            type: type,
            defaultValue: defaultValue,
            comment: m[3] === undefined ? null : m[3].trim()
        });
    }
    return entries;
}

/** Sora's formatForJS: a number or bool stays bare, anything else becomes a quoted string. */
function formatForJS(value) {
    const t = value.trim();
    // The emptiness guard is load-bearing and is not a JS/Swift detail I should
    // have to think about twice: Number("") is 0, so without it the empty default
    // would be written out as `const KEY = ;`. Swift's Double("") is nil, so the
    // real app quotes it.
    if (t.length > 0 && !isNaN(Number(t))) return t;
    const lower = t.toLowerCase();
    if (lower === 'true' || lower === 'false') return lower;
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '"' + escaped + '"';
}

/** Sora's write-back: substitute the user's value into the module's own script. */
function writeSettingsToFile(source, overrides) {
    let content = source;
    for (const [key, value] of Object.entries(overrides)) {
        const re = new RegExp('^(\\s*)const\\s+' + key + '\\s*=\\s*.*?;(.*)$', 'gm');
        content = content.replace(re, (all, indent, tail) =>
            indent + 'const ' + key + ' = ' + formatForJS(value) + ';' + tail);
    }
    return content;
}

function readManifest(moduleDir) {
    const files = fs.readdirSync(moduleDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) throw new Error('no manifest .json in ' + moduleDir);
    return JSON.parse(fs.readFileSync(path.join(moduleDir, files[0]), 'utf8'));
}

function readFixtures(fixtureDir) {
    const abs = path.isAbsolute(fixtureDir) ? fixtureDir : path.join(__dirname, 'fixtures', fixtureDir);
    const routes = {};
    for (const f of fs.readdirSync(abs)) {
        if (f.endsWith('.json')) {
            const doc = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
            if (doc.__routes) {
                for (const [url, route] of Object.entries(doc.__routes)) routes[url] = route;
            }
        }
    }
    return routes;
}

/**
 * Evaluate an arbitrary script (e.g. a shared helper) in the Sora-like context.
 * Same environment, but the caller supplies the source rather than a module dir.
 */
function loadSource(source, routes, filename) {
    const log = [];
    const calls = [];
    const sandbox = makeEnvironment(routes || {}, log, calls);
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: filename || 'inline.js' });
    // Exposed on the context as well as the wrapper, because tests naturally
    // hold the context and reach for `ctx.calls`.
    context.calls = calls;
    context.log = log;
    return { context: context, log: log, calls: calls, routes: routes || {} };
}

module.exports = {
    loadModule: loadModule,
    loadSource: loadSource,
    readManifest: readManifest,
    readFixtures: readFixtures,
    parseSettingsSchema: parseSettingsSchema,
    writeSettingsToFile: writeSettingsToFile,
    hostParseSearch: hostParseSearch,
    hostParseEpisodes: hostParseEpisodes,
    hostParseDetails: hostParseDetails,
    hostParseStream: hostParseStream,
    hostStreamOptions: hostStreamOptions,
    jsValueToString: jsValueToString,
    Response: Response
};
