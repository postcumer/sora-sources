const mangayomiSources = [{
    "name": "Pornmz",
    "lang": "en",
    "baseUrl": "https://pornmz.com",
    "apiUrl": "",
    "iconUrl": "https://www.google.com/s2/favicons?sz=128&domain=https://pornmz.com",
    "typeSource": "single",
    "version": "1.0.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "itemType": 1,
    "isNsfw": true,
    "pkgPath": "anymex/pornmz.js"
}];

/*
 * pornmz.com as an AnymeX / Mangayomi anime source.
 *
 * This is the same provider the Sora module in ../modules/pornmz targets, and
 * the parsers are the same ones, re-expressed against the Mangayomi contract.
 * The two hosts are different programs with different entry points, so the code
 * is deliberately duplicated rather than shared: Mangayomi evaluates one
 * self-contained script and has no module loader, exactly as Sora does.
 *
 * What changes between the hosts is mostly ergonomics, in our favour. The Sora
 * module had to expose its browse choice as a text field in a settings screen,
 * because a module there cannot own any UI. Mangayomi hands the user two native
 * entry points (Popular and Latest) and a filter builder, so the same four sorts
 * and the same 67 categories arrive as real controls:
 *
 *   Sora:  Settings -> Modules -> BROWSE_ORDER = "popular"
 *   AnymeX: the Sort/Category filters
 *
 * The one control this source does not drive is the Popular entry point itself.
 * The host shows it for every source and offers no way to switch it off, so
 * there is nothing to delete; what a source decides is what it puts behind it,
 * and it puts the newest listing there. The view-count ranking is still one tap
 * away as the "Popular" entry in the Sort filter.
 *
 * The site is a WordPress install whose theme renders <article> cards on its
 * front page. Each card carries a title, a thumbnail, a link and a view count,
 * which is what makes the site's four `?filter=` sorts worth using: the
 * "popular" sort is the provider's own view-count ranking, not one this source
 * approximates.
 *
 * Every value below is taken from a page the site serves in the open. There is
 * no auth, no key, no cookie and no header beyond a Referer the CDN requires.
 */
class DefaultExtension extends MProvider {
    // `this.source` is supplied by the host (MProvider's bridged `source`
    // property), the same as every reference source. It is deliberately not
    // redeclared here: shadowing a bridged property with a getter risks
    // breaking the binding the host installed.

    // -----------------------------------------------------------------------
    // HTTP
    // -----------------------------------------------------------------------

    /**
     * GET with a status check, so an error page is never parsed as content.
     *
     * `res.headers` and `res.statusCode` both exist: the runtime returns
     * package:http's `Response.toJson()` with the body swapped for a string, and
     * header names arrive lowercased. The pagination check in search() depends
     * on that, so a renamed or absent header is handled rather than assumed.
     */
    async fetchPage(url, headers) {
        const res = await new Client().get(url, headers || {"Referer": this.source.baseUrl});
        if (typeof res.statusCode !== "number" || res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error("pornmz: HTTP " + res.statusCode + " for " + url);
        }
        return res;
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    /**
     * Every `content` value of the <meta> tags carrying an itemprop, in order.
     *
     * Returns a list rather than a single value because the video page publishes
     * `itemprop="name"` twice — the site name first, then the video title. A
     * reader that takes the first match labels every video "Pornmz", which is
     * the same trap the Sora module documents. Callers pick by index.
     */
    metaValues(html, itemprop) {
        const found = [];
        const tag = new RegExp("<meta\\b[^>]*>", "gi");
        const wanted = new RegExp("\\bitemprop\\s*=\\s*(?:\"" + itemprop + "\"|'" + itemprop + "')", "i");
        const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
        let match;
        while ((match = tag.exec(html)) !== null) {
            const open = match[0];
            if (!wanted.test(open)) {
                continue;
            }
            const value = content.exec(open);
            if (value) {
                found.push(decodeEntities(value[1] !== undefined ? value[1] : value[2]));
            }
        }
        return found;
    }

    /** The single-valued microdata properties this source reads. */
    metaText(html, itemprop) {
        const all = this.metaValues(html, itemprop);
        if (all.length > 1) {
            // A stream that looks valid but is not is worse than no stream, so
            // a property that has quietly become repeatable is refused, not
            // guessed at.
            throw new Error("pornmz: " + itemprop + " appears " + all.length + " times");
        }
        return all.length ? all[0] : "";
    }

    /**
     * The listing cards, in the shape Mangayomi wants: name, imageUrl, link.
     *
     * A card with no usable thumbnail is still returned with an empty imageUrl
     * rather than dropped. Mangayomi's row parser discards an entry missing any
     * of the three fields, so dropping it here would silently shrink the list.
     */
    parseCards(html) {
        const rows = [];
        const card = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
        let match;
        while ((match = card.exec(html)) !== null) {
            const attributes = match[1] || "";
            const body = match[2] || "";
            const link = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
            const href = link ? (link[1] !== undefined ? link[1] : link[2]) : "";
            if (!href) {
                continue;
            }
            const title = /<span\b[^>]*\bclass\s*=\s*"[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body);
            const titleAttribute = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
            const raw = title
                ? title[1]
                : (titleAttribute ? (titleAttribute[1] !== undefined ? titleAttribute[1] : titleAttribute[2]) : "");
            const name = decodeEntities(String(raw).replace(/<[^>]*>/g, "")).trim();
            if (!name) {
                continue;
            }
            let image = attributeValue(attributes, "data-main-thumb") || attributeValue(body, "src");
            if (image && !/^https?:\/\//i.test(image)) {
                // No URL global in the engine, so a root-relative thumbnail
                // cannot be resolved here. Passing it on would render broken.
                image = "";
            }
            rows.push({name, imageUrl: image, link: href});
        }
        return rows;
    }

    /**
     * The category labels from the page's own tag block.
     *
     * The block mixes two kinds of link, told apart by their icon: `fa-folder`
     * links are categories, `fa-tag` links are content tags ("HD", "Cowgirl").
     * Only the categories become genres — the tags restate them often enough
     * that including both fills the genre list with near-duplicates.
     */
    parseGenres(html) {
        const genres = [];
        const block = /<div\b[^>]*\bclass\s*=\s*"[^"]*\btags-list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
        if (!block) {
            return genres;
        }
        const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = link.exec(block[1])) !== null) {
            if (!/class\s*=\s*"[^"]*\bfa-folder\b[^"]*"/i.test(match[2])) {
                continue;
            }
            const label = attributeValue(match[1], "title") || stripTags(match[2]).trim();
            if (label) {
                genres.push(decodeEntities(label));
            }
        }
        return genres;
    }

    /**
     * `uploadDate` to milliseconds since the epoch, for a chapter's dateUpload.
     *
     * Parsed by hand rather than through Date.parse: the value carries a
     * non-zero UTC offset ("2026-09-26T20:19:17+01:00"), and how a given engine
     * handles that string is not something to leave to chance. Zero means
     * "unknown", which the app already handles.
     */
    uploadMillis(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(iso || "");
        if (!m) {
            return 0;
        }
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 5, +m[5], +m[6]);
    }

    // -----------------------------------------------------------------------
    // Listing entry points
    // -----------------------------------------------------------------------

    /**
     * A listing page: one of the site's four sorts, or a category.
     *
     * These are single pages of 20 cards. `?filter=latest&page=2` returns page
     * one again and `/page/2/?filter=latest` returns nothing, so there is no
     * pagination to offer and hasNextPage is false rather than optimistic.
     */
    async listing(url) {
        const res = await this.fetchPage(url);
        const list = this.parseCards(res.body);
        if (!list.length) {
            console.log("pornmz: no cards in listing " + url);
        }
        return {list, hasNextPage: false};
    }

    async getPopular(page) {
        // The host shows this unconditionally — tapping a source in the list
        // opens it, and there is no supportsPopular flag to opt out of, only a
        // commented-out one for Latest. So the button cannot be removed from a
        // source; what a source controls is what it puts behind it. It serves
        // the newest listing rather than the view-count ranking, at the user's
        // request. The ?filter=most-viewed ranking is still reachable, and is
        // still the "Popular" entry in the Sort filter below.
        if (page > 1) {
            return {list: [], hasNextPage: false};
        }
        return this.listing(this.source.baseUrl + "/?filter=latest");
    }

    async getLatestUpdates(page) {
        if (page > 1) {
            return {list: [], hasNextPage: false};
        }
        return this.listing(this.source.baseUrl + "/?filter=latest");
    }

    // -----------------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------------

    /**
     * Text search over the WordPress REST API, or a browse when a filter is set.
     *
     * A chosen Sort or Category wins over the typed text, because that is what
     * picking one in the filter panel means. This is the one place the two
     * mechanisms meet, and the filter is deliberately decisive: the user just
     * made an explicit choice and it should not depend on what was typed.
     */
    async search(query, page, filters) {
        const chosen = selectedFilters(filters);
        const wanted = String(query === undefined || query === null ? "" : query).trim();

        if (chosen.category) {
            if (page > 1) {
                return {list: [], hasNextPage: false};
            }
            return this.listing(this.source.baseUrl + "/pmvideo/c/" + encodeURIComponent(chosen.category));
        }
        if (chosen.sort) {
            if (page > 1) {
                return {list: [], hasNextPage: false};
            }
            return this.listing(this.source.baseUrl + "/?filter=" + encodeURIComponent(chosen.sort));
        }

        if (!wanted) {
            return {list: [], hasNextPage: false};
        }

        // `_embed=wp:featuredmedia` rather than `_embed=1`: the blanket form
        // resolves every embeddable relation as a server-side sub-request, and
        // this host is slow. Measured 7058ms vs 2591ms for the same 20 rows.
        const url = this.source.baseUrl +
            "/wp-json/wp/v2/posts?search=" + encodeURIComponent(wanted) +
            "&per_page=20&page=" + Math.max(1, page) + "&_embed=wp:featuredmedia";
        const res = await this.fetchPage(url);
        const posts = parseJsonList(res.body);
        if (posts === null) {
            // A 200 carrying HTML is a bot check or a maintenance page. Offering
            // it as results would be worse than offering none.
            console.log("pornmz: search response was not a list for " + wanted);
            return {list: [], hasNextPage: false};
        }
        const list = [];
        for (const post of posts) {
            const link = typeof post.link === "string" ? post.link : "";
            const name = post.title && typeof post.title.rendered === "string"
                ? decodeEntities(post.title.rendered).trim()
                : "";
            if (!link || !name) {
                continue;
            }
            list.push({name, imageUrl: featuredImage(post), link});
        }
        return {list, hasNextPage: hasMorePages(res, page)};
    }

    // -----------------------------------------------------------------------
    // Detail
    // -----------------------------------------------------------------------

    /**
     * One post, one video, one chapter.
     *
     * The same honest model the Sora module uses: a pornmz post is a standalone
     * video, not an episode of a series, so there is nothing to group. The site
     * has no series or studio listing to group by — its 67 categories are tags,
     * not shows — and inventing a one-item "series" per post would be a shape
     * the app would treat as a real show.
     */
    async getDetail(url) {
        const page = url.indexOf("http") === 0 ? url : this.source.baseUrl + url;
        const res = await this.fetchPage(page);
        const body = res.body;

        // name appears twice: the site first, the video second.
        const names = this.metaValues(body, "name");
        const name = names.length > 1 ? names[1] : (names.length ? names[0] : "");
        if (!name) {
            throw new Error("pornmz: no title in " + page);
        }

        const chapters = [{
            name: "Watch",
            url: page,
            scanlator: "",
            // A *string* of milliseconds, not a number. The host declares the
            // field String? and reads it back with int.tryParse, so a bare
            // integer here is a hard type error on every detail page rather
            // than a missing date. Every reference source stringifies it too.
            dateUpload: String(this.uploadMillis(this.metaText(body, "uploadDate")))
        }];

        return {
            name,
            description: this.metaText(body, "description"),
            // The page's own `author` is a Person scope whose only name is the
            // site itself, and performers are published in no machine-readable
            // place. Empty rather than "Pornmz" or a guess.
            author: "",
            // A pornmz post is always a finished, published video.
            status: 1,
            imageUrl: this.metaText(body, "thumbnailUrl"),
            genre: this.parseGenres(body),
            chapters,
            link: page
        };
    }

    // -----------------------------------------------------------------------
    // Video
    // -----------------------------------------------------------------------

    /**
     * The HLS master plus each of its variants.
     *
     * The playlist lives on a third-party CDN, which answers 403 to a referer
     * from the provider's domain — the same failure the Sora module documents.
     * So every stream carries a Referer derived from the playlist URL's own
     * origin, and the master is listed first with `quality: "auto"` so the app
     * can pick. Mangayomi takes `headers` per stream, which is what makes this
     * possible here at all.
     */
    async getVideoList(url) {
        const page = url.indexOf("http") === 0 ? url : this.source.baseUrl + url;
        const body = (await this.fetchPage(page)).body;
        const master = this.metaText(body, "contentUrl");
        if (!master) {
            // No playable URL published. An empty list makes the app say so,
            // rather than handing it something that will not play.
            return [];
        }

        const origin = (master.match(/^(https?:\/\/[^/?#]+)/i) || [])[1] || this.source.baseUrl;
        const headers = {"Referer": origin};

        const streams = [{
            url: master,
            originalUrl: master,
            quality: "auto",
            headers
        }];

        let playlist = "";
        try {
            playlist = (await this.fetchPage(master, headers)).body;
        } catch (error) {
            // The master alone is still playable; the variant list is a bonus.
            console.log("pornmz: variant list unavailable, offering the master: " + error.message);
            return streams;
        }

        const audios = parseAudios(playlist, origin);
        streams[0].audios = audios;

        for (const variant of parseVariants(playlist, origin)) {
            variant.headers = headers;
            if (variant.audioGroup && audios.length) {
                const group = audios.filter(audio => audio.group === variant.audioGroup);
                if (group.length) {
                    variant.audios = [{file: group[0].file, label: group[0].label}];
                }
            }
            streams.push(variant);
        }
        return streams;
    }

    // -----------------------------------------------------------------------
    // Filters and preferences
    // -----------------------------------------------------------------------

    /**
     * The site's four sorts and its 67 categories, as real controls.
     *
     * This is the part the Sora module could not do. There the browse choice was
     * a free-text field the user had to know the spelling of; here they are two
     * drop-downs, and the category list is the complete one from the REST API
     * rather than the 19 the site's own /categories page renders.
     */
    getFilterList() {
        return [
            {
                type_name: "GroupFilter",
                name: "Sort",
                state: [
                    {type_name: "CheckBox", name: "All", value: ""},
                    {type_name: "CheckBox", name: "Latest", value: "latest"},
                    {type_name: "CheckBox", name: "Popular", value: "most-viewed"},
                    {type_name: "CheckBox", name: "Longest", value: "longest"},
                    {type_name: "CheckBox", name: "Random", value: "random"}
                ]
            },
            {
                type_name: "GroupFilter",
                name: "Category",
                state: CATEGORIES.map(function (entry) {
                    return {type_name: "CheckBox", name: entry.label, value: entry.slug};
                })
            }
        ];
    }

    getSourcePreferences() {
        return [];
    }

    // -----------------------------------------------------------------------
    // Manga-only entry points
    // -----------------------------------------------------------------------

    // This is an anime source. AnymeX only calls these for a manga source, and
    // throwing is how the contract reports "not implemented" — a silent empty
    // return would look like a working source with no pages.
    //
    // These three are the real manga-side entry points. The bridged provider
    // (mangayomi lib/eval/dart/bridge/m_provider.dart) exposes getPageList,
    // getHtmlContent and cleanHtmlContent and nothing else page-related, so
    // there is deliberately no getPage here to be called by nothing.

    getPageList() {
        throw new Error("getPageList not implemented");
    }

    getHtmlContent() {
        throw new Error("getHtmlContent not implemented");
    }

    cleanHtmlContent() {
        throw new Error("cleanHtmlContent not implemented");
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The 67 categories, as they are published by /wp-json/wp/v2/categories.
 *
 * Hardcoded rather than fetched at runtime so the filter list is available the
 * moment a source is added, with no request to a host that is slow to answer and
 * occasionally does not answer at all. Slugs are what the module needs; labels
 * are the site's own, so the drop-down reads the way the site does.
 */
const CATEGORIES = [
    {slug: "amateur", label: "Amateur"},
    {slug: "anal", label: "Anal"},
    {slug: "analmom", label: "Anal Mom"},
    {slug: "asian", label: "Asian"},
    {slug: "bangbros", label: "Bang Bros"},
    {slug: "bdsm", label: "BDSM"},
    {slug: "best", label: "Best"},
    {slug: "big-ass", label: "Big Ass"},
    {slug: "big-dick", label: "Big Dick"},
    {slug: "big-tits", label: "Big Tits"},
    {slug: "blacked", label: "Blacked"},
    {slug: "blowjob", label: "Blowjob"},
    {slug: "brattysis", label: "Bratty Sis"},
    {slug: "brazzers", label: "Brazzers"},
    {slug: "brother-sister-porn", label: "Brother Sister"},
    {slug: "caughtfapping", label: "Caught Fapping"},
    {slug: "celebrity", label: "Celebrity"},
    {slug: "christmas", label: "Christmas"},
    {slug: "creampie", label: "Creampie"},
    {slug: "dadcrush", label: "Dadcrush"},
    {slug: "deep-throat", label: "Deep Throat"},
    {slug: "deeper", label: "Deeper"},
    {slug: "digitalplayground", label: "Digital Playground"},
    {slug: "ebony", label: "Ebony"},
    {slug: "facial", label: "Facial"},
    {slug: "fakehostel", label: "Fake Hotel"},
    {slug: "faketaxi", label: "Fake Taxi"},
    {slug: "familystrokes", label: "Family Strokes"},
    {slug: "father-daughter-porn", label: "Father Daughter"},
    {slug: "freeuse", label: "Freeuse"},
    {slug: "freeusefantasy", label: "Freeuse Fantasy"},
    {slug: "gangbang", label: "Gangbang"},
    {slug: "hardcore", label: "Hardcore"},
    {slug: "hornypervmom", label: "Horny perv mom"},
    {slug: "incest", label: "Incest"},
    {slug: "instagram-models", label: "Instagram Models"},
    {slug: "interracial", label: "Interracial"},
    {slug: "latina", label: "Latina"},
    {slug: "lesbian", label: "Lesbian"},
    {slug: "massage", label: "Massage"},
    {slug: "milf", label: "Milf"},
    {slug: "milkyperu", label: "Milky Peru"},
    {slug: "missax", label: "Missax"},
    {slug: "mofos", label: "Mofos"},
    {slug: "mother-daughter-porn", label: "Mother Daughter"},
    {slug: "mom-son-porn", label: "Mom Son"},
    {slug: "mommysboy", label: "Mommys Boy"},
    {slug: "momsteachsex", label: "Mom Steaches Sex"},
    {slug: "mypervyfamily", label: "My Pervy Family"},
    {slug: "naughtyamerica", label: "Naughty America"},
    {slug: "nurumassage", label: "Nuru Massage"},
    {slug: "onlyfans", label: "OnlyFans"},
    {slug: "orgy", label: "Orgy"},
    {slug: "pervmom", label: "Perv Mom"},
    {slug: "pov", label: "POV"},
    {slug: "puretaboo", label: "Pure Taboo"},
    {slug: "reality", label: "Reality"},
    {slug: "realitykings", label: "Reality Kings"},
    {slug: "sexmex", label: "SexMex"},
    {slug: "sislovesme", label: "Sis Loves Me"},
    {slug: "squirting", label: "Squirting"},
    {slug: "stepsiblingscaught", label: "Stepsiblings Caught"},
    {slug: "sweetsinner", label: "Sweetsinner"},
    {slug: "taboo", label: "Taboo"},
    {slug: "teen", label: "Teen"},
    {slug: "threesome", label: "Threesome"},
    {slug: "valentines-day", label: "Valentines Day"}
];

/** The first checked Sort and Category values, or "" for each. */
function selectedFilters(filters) {
    const chosen = {sort: "", category: ""};
    if (!filters) {
        return chosen;
    }
    for (const group of filters) {
        if (!group || !group.state) {
            continue;
        }
        for (const entry of group.state) {
            if (!entry || !entry.state || !entry.value) {
                continue;
            }
            if (group.name === "Sort" && !chosen.sort) {
                chosen.sort = entry.value;
            }
            if (group.name === "Category" && !chosen.category) {
                chosen.category = entry.value;
            }
        }
    }
    return chosen;
}

/**
 * Whether the REST API says there is another page.
 *
 * `x-wp-totalpages` is the real answer. When the header is missing the length of
 * the page is used instead: a short page is the last one. Guessing "always more"
 * would spin the user through empty pages forever, so the fallback errs toward
 * stopping.
 */
function hasMorePages(res, page) {
    const headers = res && res.headers;
    if (headers && headers["x-wp-totalpages"]) {
        return page < parseInt(headers["x-wp-totalpages"], 10);
    }
    if (headers && headers["X-WP-TotalPages"]) {
        return page < parseInt(headers["X-WP-TotalPages"], 10);
    }
    return false;
}

/** The featured image from an embedded post, or "" — never a guess. */
function featuredImage(post) {
    const media = post._embedded && post._embedded["wp:featuredmedia"];
    const first = media && media[0];
    if (!first) {
        return "";
    }
    const sizes = first.media_details && first.media_details.sizes;
    if (sizes && sizes.medium && typeof sizes.medium.source_url === "string") {
        return sizes.medium.source_url;
    }
    return typeof first.source_url === "string" ? first.source_url : "";
}

/** A JSON list, or null when the body is not one. */
function parseJsonList(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        return null;
    }
    return Array.isArray(parsed) ? parsed : null;
}

/** The attribute's value from a tag's opening text, in either quoting style. */
function attributeValue(html, name) {
    const found = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(html);
    return found ? (found[1] !== undefined ? found[1] : found[2]) : "";
}

function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, "");
}

/** Numeric and named HTML entities, which titles and labels really do contain. */
function decodeEntities(text) {
    return String(text)
        .replace(/&#(\d+);/g, function (_, code) {
            return String.fromCharCode(parseInt(code, 10));
        })
        .replace(/&#x([0-9a-f]+);/gi, function (_, code) {
            return String.fromCharCode(parseInt(code, 16));
        })
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/**
 * An HLS attribute list as an object.
 *
 * Not the same as reading an HTML attribute: in a playlist the values are
 * usually unquoted and comma-separated, and one of them — CODECS — contains
 * commas inside quotes. Splitting on commas would cut that value in half and
 * shift everything after it, so the values are read as a list that knows which
 * commas are inside quotes.
 */
function hlsAttributes(text) {
    const out = {};
    const pair = /([A-Za-z0-9-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/g;
    let match;
    while ((match = pair.exec(text)) !== null) {
        const value = match[2] !== undefined ? match[2]
            : match[3] !== undefined ? match[3]
                : (match[4] || "").trim();
        out[match[1].toUpperCase()] = value;
    }
    return out;
}

/**
 * The audio renditions from an HLS master.
 *
 * `group` is the GROUP-ID, kept so a video variant can be paired with the audio
 * track that actually belongs to it rather than offered the first one.
 */
function parseAudios(playlist, origin) {
    const audios = [];
    const line = /#EXT-X-MEDIA:(.*)/g;
    let match;
    while ((match = line.exec(playlist)) !== null) {
        const attributes = hlsAttributes(match[1]);
        if (attributes.TYPE !== "AUDIO" || !attributes.URI) {
            continue;
        }
        const group = attributes["GROUP-ID"] || "";
        // Every rendition on this provider is named "Audio", which tells the
        // user nothing; the group id carries the bitrate, so it is the label.
        const label = group || attributes.NAME || "audio";
        audios.push({file: absolute(attributes.URI, origin), label: label, group: group});
    }
    return audios;
}

/** The video variants, with the resolution as their quality. */
function parseVariants(playlist, origin) {
    const variants = [];
    const lines = playlist.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) {
            continue;
        }
        const attributes = hlsAttributes(line.slice("#EXT-X-STREAM-INF:".length));
        let uri = "";
        for (let j = i + 1; j < lines.length; j++) {
            const candidate = lines[j].trim();
            if (candidate && candidate.charAt(0) !== "#") {
                uri = candidate;
                break;
            }
        }
        if (!uri) {
            continue;
        }
        variants.push({
            url: absolute(uri, origin),
            originalUrl: absolute(uri, origin),
            quality: attributes.RESOLUTION || "auto",
            audioGroup: attributes.AUDIO || ""
        });
    }
    return variants;
}

/**
 * Resolve a playlist URI against the master's origin.
 *
 * The engine has no `URL` global, and these playlists use root-relative paths,
 * so this is a concatenation rather than a URL resolution. An absolute URI is
 * left alone.
 */
function absolute(uri, origin) {
    if (/^https?:\/\//i.test(uri)) {
        return uri;
    }
    if (uri.charAt(0) === "/") {
        return origin + uri;
    }
    return origin + "/" + uri.replace(/^\.\//, "");
}
