'use strict';
/*
 * Mangayomi's Aidoku catalogue parser, transcribed from the app's own source.
 *
 * The point of this file is that the Aidoku sources in postcumer/aidoku-sources
 * are not ported, reimplemented or adapted for Mangayomi — the app already has
 * a native runner for the .aix packages, and it already parses the catalogue
 * that repo publishes. So there is nothing here to test against our own code,
 * and the only honest way to assert that the catalogue works is to reproduce
 * the host's parser and run the real catalogue through it.
 *
 * Every function below is a transcription of named code in the app, with the
 * file and line it came from. Where the transcription is not exact, it says so
 * — the exceptions are marked EXACTNESS rather than glossed over, because a
 * harness that quietly approximates the thing it is checking is worse than no
 * harness at all.
 *
 * Transcribed from:
 *   lib/services/extension_store_service.dart   _parseAidokuJsonStore  234-316
 *   lib/services/fetch_sources_list.dart        the itemType/age filter  50-59
 */

const path = require('path');

/**
 * Dart's String.hashCode: Jenkins one-at-a-time over the UTF-16 code units,
 * masked to 31 bits, with 0 promoted to 1.
 *
 * The app writes src.id = '<prefix>-<id>-<lang>'.hashCode.abs(). The .abs() is
 * a no-op: hashCode is already masked to 0x7fffffff, so it is never negative.
 * Kept out of the transcription deliberately, and pinned by a test.
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

/**
 * Dart's Uri.resolve, which is what the parser uses for both the download URL
 * and the icon URL.
 *
 * EXACTNESS: covers the cases that actually occur in an Aidoku catalogue —
 * an absolute URL, and a root-relative path. Dart also resolves a bare
 * relative path against the base's directory, which Node's URL handles the
 * same way for these inputs. What is not reproduced is Dart's lenient
 * treatment of malformed URIs, where resolve() can return a relative Uri
 * instead of throwing; the host would then store a relative string as a URL
 * and fail later at fetch time rather than here.
 */
function resolveUri(base, ref) {
    if (ref === undefined || ref === null || ref === '') return '';
    try {
        return new URL(String(ref), base).toString();
    } catch (e) {
        return String(ref);
    }
}

/**
 * _parseAidokuJsonStore (extension_store_service.dart:234).
 *
 * Returns null in the two cases the app returns null: the store is not an
 * object with a `sources` list, or the whole parse threw. The caller
 * (fetchStore, :186) tests `jsonMap['sources'] is List` before calling, and
 * falls through to the legacy parsers otherwise — so a catalogue that stops
 * being a `sources` list does not produce a broken source, it produces none at
 * all, which is the failure mode worth pinning.
 */
function parseAidokuJsonStore(indexUrl, jsonMap) {
    try {
        if (!jsonMap || typeof jsonMap !== 'object' || Array.isArray(jsonMap)) return null;
        const rawSources = jsonMap.sources;
        if (!Array.isArray(rawSources)) return null;

        const repoName = jsonMap.name !== undefined && jsonMap.name !== null
            ? jsonMap.name
            : 'Aidoku Sources';

        const sources = [];

        for (const e of rawSources) {
            if (!e || typeof e !== 'object' || Array.isArray(e)) continue; // :247

            const rawDownloadUrl = e.downloadURL !== undefined && e.downloadURL !== null
                ? e.downloadURL
                : e.file;
            const rawIconUrl = e.iconURL !== undefined && e.iconURL !== null
                ? e.iconURL
                : e.icon;

            const downloadUrl = rawDownloadUrl !== undefined && rawDownloadUrl !== null && rawDownloadUrl !== ''
                ? resolveUri(indexUrl, rawDownloadUrl)
                : '';
            const iconUrl = (rawIconUrl !== undefined && rawIconUrl !== null && rawIconUrl !== '')
                ? resolveUri(indexUrl, rawIconUrl)
                : (e.id !== undefined && e.id !== null
                    ? resolveUri(indexUrl, 'icons/' + e.id + '.png')
                    : '');

            const langs = Array.isArray(e.languages)
                ? e.languages.map((l) => String(l))
                : [e.lang !== undefined && e.lang !== null ? e.lang : 'all'];

            // :265-268 — the contentRating form is an int, and >= 2 is the line.
            // The nsfw form is a bool or 0/1, where 1 already means flagged.
            const rating = e.contentRating !== undefined && e.contentRating !== null
                ? e.contentRating
                : (e.nsfw !== undefined && e.nsfw !== null ? e.nsfw : 0);
            const isNsfw = typeof rating === 'number'
                ? rating >= 2
                : (rating === true || rating === 1);

            const baseUrl = (e.baseURL !== undefined && e.baseURL !== null)
                ? e.baseURL
                : ((e.url !== undefined && e.url !== null) ? e.url : '');
            const name = (e.name !== undefined && e.name !== null)
                ? e.name
                : ((e.id !== undefined && e.id !== null) ? e.id : 'Source');
            const version = e.version !== undefined && e.version !== null
                ? String(e.version) + '.0.0'
                : '1.0.0';

            for (const lang of langs) {
                const src = {
                    apiUrl: '',
                    // :277 — hardcoded empty, not read from the entry. This is
                    // the field the age filter would consult if the source were
                    // not aidoku, and it is why the filter below short-circuits.
                    appMinVerReq: '',
                    dateFormat: '',
                    dateFormatLocale: '',
                    hasCloudflare: false,
                    headers: '',
                    isActive: true,
                    isAdded: false,
                    isFullData: false,
                    isNsfw: isNsfw,
                    isPinned: false,
                    lastUsed: false,
                    sourceCode: '',
                    typeSource: '',
                    version: version,
                    versionLast: version,
                    isObsolete: false,
                    isLocal: false,
                    name: name,
                    lang: lang,
                    baseUrl: baseUrl,
                    sourceCodeUrl: downloadUrl,
                    // SourceCodeLanguage.aidoku == 4; ItemType.manga == 0.
                    sourceCodeLanguage: 4,
                    itemType: 0,
                    iconUrl: iconUrl,
                    notes: null,
                    id: dartStringHash('aidoku-' + e.id + '-' + lang)
                };
                sources.push(src);
            }
        }

        return { name: repoName, website: indexUrl, indexUrl: indexUrl, sources: sources };
    } catch (e) {
        return null; // :313-315
    }
}

/**
 * fetch_sources_list.dart:50-59 — the filter that decides which parsed sources
 * are offered for a given item type.
 *
 * The disjunction is ordered, and the order is the whole reason an Aidoku
 * source can never be filtered out for being too old: the aidoku and lnreader
 * cases come first, so appMinVerReq is never even read for them.
 */
function filterForItemType(sources, itemType, appVersion) {
    return sources.filter((source) => {
        if (source.itemType !== itemType) return false;
        if (source.sourceCodeLanguage === 4) return true;   // aidoku
        if (source.sourceCodeLanguage === 3) return true;   // lnreader
        if (source.appMinVerReq === undefined || source.appMinVerReq === null) return true;
        if (source.appMinVerReq === '') return true;
        return compareVersions(appVersion, source.appMinVerReq) > -1;
    });
}

/**
 * fetch_sources_list.dart:144 — the update gate. Source code is re-downloaded
 * only when the catalogue's version is strictly greater than the installed
 * one, so a rebuilt .aix under an unchanged version is never delivered.
 */
function shouldUpdate(installed, catalogue) {
    return installed.isAdded === true &&
        compareVersions(installed.version, catalogue.version) < 0;
}

/**
 * The host's own version comparison, as used above. Compares dot-separated
 * numeric components, padding the shorter side with zeros.
 *
 * EXACTNESS: a faithful-enough model of the numeric-component behaviour. The
 * app's real implementation is not in the files transcribed here, and this
 * covers the shapes those call sites actually pass — '4.0.0' against '4.0.0',
 * and an app version against a declared minimum. Non-numeric components
 * (pre-release suffixes) are treated as 0 rather than throwing, which is
 * enough to keep a surprising input from taking down the whole filter.
 */
function compareVersions(a, b) {
    const pa = String(a === undefined || a === null ? '' : a).split('.').map(toInt);
    const pb = String(b === undefined || b === null ? '' : b).split('.').map(toInt);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const va = i < pa.length ? pa[i] : 0;
        const vb = i < pb.length ? pb[i] : 0;
        if (va !== vb) return va < vb ? -1 : 1;
    }
    return 0;
}

function toInt(part) {
    const n = parseInt(String(part), 10);
    return Number.isNaN(n) ? 0 : n;
}

/** The catalogue as it is published, read from the captured fixture. */
function loadCatalogue() {
    const file = path.join(__dirname, 'fixtures', 'aidoku-store', 'sources.json');
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
}

/** The URL the app is pointed at, transcribed from the documentation. */
const INSTALL_URL =
    'https://raw.githubusercontent.com/postcumer/aidoku-sources/main/sources.json';

const INDEX_URL = INSTALL_URL;

module.exports = {
    dartStringHash,
    resolveUri,
    parseAidokuJsonStore,
    filterForItemType,
    shouldUpdate,
    compareVersions,
    loadCatalogue,
    INSTALL_URL,
    INDEX_URL
};
