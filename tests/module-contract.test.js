'use strict';
/*
 * Structural contract checks that apply to every module, provider-independent.
 *
 * These are the rules that are cheap to state and easy to violate by accident:
 * a missing manifest field fails only at install time on a user's device, and an
 * `eval(` or a `const` the settings rewriter will mangle is invisible until
 * something breaks in the app. Checking them here means they break in CI instead.
 *
 * Every module under modules/ is checked. Run after adding one.
 */

const fs = require('fs');
const path = require('path');
const test = require('./test');

const ROOT = path.join(__dirname, '..');
const MODULES_DIR = path.join(ROOT, 'modules');

const REQUIRED_MANIFEST_FIELDS = [
    'sourceName', 'author', 'iconUrl', 'version', 'language',
    'baseUrl', 'streamType', 'quality', 'searchBaseUrl', 'scriptUrl'
];

const ENTRY_POINTS = ['searchResults', 'extractDetails', 'extractEpisodes', 'extractStreamUrl'];

/*
 * Ban list. Each entry is a rule from the project brief that a reviewer would
 * otherwise have to catch by eye, every time.
 */
const BANNED = [
    { re: /\beval\s*\(/, why: '§33 — no eval; write a deterministic decoder instead' },
    { re: /\bnew\s+Function\s*\(/, why: '§33 — no Function constructor' },
    { re: /\brequire\s*\(/, why: '§6 — no Node; JavaScriptCore has no module system' },
    { re: /\bprocess\s*\./, why: '§6 — no Node globals' },
    { re: /\bwindow\s*\./, why: '§6 — no DOM in the module context' },
    { re: /\bdocument\s*\./, why: '§6 — no DOM in the module context' },
    { re: /\blocalStorage\b/, why: '§6 — no web storage' },
    { re: /\bXMLHttpRequest\b/, why: '§6 — use fetchv2' },
    { re: /\bnetworkFetch(With\w+)?\s*\(/, why: '§12/§35 — WebView automation with anti-bot masking; not used by these modules' },
    { re: /\b__proto__\b/, why: '§33 — do not touch the prototype chain' },
    { re: /\bsetTimeout\s*\(/, why: 'no timers in the module context; fetchv2 already resolves' },
    { re: /\bsetInterval\s*\(/, why: 'no timers in the module context' }
];

function moduleDirs() {
    if (!fs.existsSync(MODULES_DIR)) return [];
    return fs.readdirSync(MODULES_DIR)
        .map(d => path.join(MODULES_DIR, d))
        .filter(d => fs.statSync(d).isDirectory());
}

// ---------------------------------------------------------------------------

const dirs = moduleDirs();

if (dirs.length === 0) {
    test('no modules present yet — contract checks are vacuous', () => {
        test.true(true, 'placeholder so the suite reports honestly instead of silently passing');
    });
}

for (const dir of dirs) {
    const name = path.basename(dir);

    test(name + ': ships a manifest and a module.js', () => {
        const files = fs.readdirSync(dir);
        test.ok(files.includes('module.js'), 'module.js present');
        test.ok(files.some(f => f.endsWith('.json')), 'manifest .json present');
    });

    test(name + ': manifest satisfies ModuleMetadata', () => {
        const file = fs.readdirSync(dir).find(f => f.endsWith('.json'));
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

        for (const field of REQUIRED_MANIFEST_FIELDS) {
            test.ok(manifest[field] !== undefined, 'required field "' + field + '" present');
        }

        test.ok(manifest.author && typeof manifest.author.name === 'string' &&
            manifest.author.name.length > 0, 'author.name non-empty');
        test.ok(manifest.author && typeof manifest.author.icon === 'string',
            'author.icon present (Sora renders it)');

        // §1: the host only substitutes %s here; without it the search URL is
        // the bare template and every search returns the same page.
        test.includes(manifest.searchBaseUrl, '%s', 'searchBaseUrl contains the %s placeholder');

        for (const field of ['baseUrl', 'searchBaseUrl', 'scriptUrl', 'iconUrl']) {
            test.ok(/^https:\/\//.test(manifest[field]), field + ' is https');
        }

        test.ok(/^\d+\.\d+\.\d+$/.test(manifest.version),
            'version is semver-shaped ("' + manifest.version + '") — it gates script updates');

        // Drift note in COMPATIBILITY.md §3: the app decodes `novel`; SoraCore
        // carries `settings`. Shipping `settings` satisfies neither.
        test.equal(manifest.settings, undefined,
            'no "settings" key — the app decodes "novel"; "settings" is silently ignored');
        test.equal(manifest.novel, undefined,
            'no "novel" key — these are media modules');

        // `asyncJS` is the master switch: Sora checks it first and routes search,
        // details AND streams to the Promise path. `streamAsyncJS` is only read in
        // the `else if` branch, so with asyncJS true it is dead — and if the two
        // checks were ever reordered, setting it would route this module to the
        // HTML-first path and break playback. An earlier revision of this linter
        // demanded the opposite; the source says otherwise.
        if (manifest.asyncJS === true) {
            test.equal(manifest.streamAsyncJS, undefined,
                'streamAsyncJS omitted — it is inert once asyncJS is true, and ' +
                'actively harmful if the host ever checks it first');
        } else {
            test.ok(manifest.streamAsyncJS === true || manifest.streamAsyncJS === false,
                'a synchronous-search module states streamAsyncJS explicitly');
        }
    });

    test(name + ': module.js declares all four entry points', () => {
        const source = fs.readFileSync(path.join(dir, 'module.js'), 'utf8');
        for (const entry of ENTRY_POINTS) {
            test.ok(new RegExp('function\\s+' + entry + '\\b').test(source) ||
                    new RegExp('\\b' + entry + '\\s*=\\s*function').test(source) ||
                    new RegExp('\\b' + entry + '\\s*=\\s*async').test(source) ||
                    new RegExp('(var|let|const)\\s+' + entry + '\\b').test(source),
                'defines ' + entry);
        }
    });

    test(name + ': module.js respects the runtime and project rules', () => {
        const source = fs.readFileSync(path.join(dir, 'module.js'), 'utf8');
        const violations = [];
        for (const rule of BANNED) {
            if (rule.re.test(source)) violations.push(rule.why + '  — matched ' + rule.re);
        }
        test.equal(violations.length, 0, 'no banned constructs:\n    ' + violations.join('\n    '));
    });

    test(name + ': top-level consts are safe for the settings rewriter', () => {
        // ModuleManager.writeSettingsToFile substitutes overrides with
        //   ^(\s*)const\s+KEY\s*=\s*.*?;(.*)$      (anchorsMatchLines)
        // `.*?` is non-greedy, so the value ends at the FIRST semicolon and
        // everything after it is kept verbatim. Two ways to break it: no
        // semicolon at all (the line never matches), or a semicolon inside the
        // value (the rewrite lands mid-literal and the script stops parsing).
        //
        // A trailing `// comment` is explicitly fine — it is the semicolon's
        // group `(.*)`, preserved across a rewrite, and it is how a settings row
        // gets its caption. An earlier revision of this linter rejected any line
        // not ending in `;` and so forbade the one form that actually works.
        const source = fs.readFileSync(path.join(dir, 'module.js'), 'utf8');
        const problems = [];

        source.split('\n').forEach((line, i) => {
            const match = /^(\s*)const\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
            if (!match) return;
            const rest = match[3];
            const semi = rest.indexOf(';');

            if (semi === -1) {
                problems.push('line ' + (i + 1) + ': const ' + match[2] +
                    ' has no semicolon — the rewriter will not match this line');
                return;
            }
            const after = rest.slice(semi + 1).trim();
            if (after !== '' && !after.startsWith('//')) {
                problems.push('line ' + (i + 1) + ': const ' + match[2] +
                    ' has text after its first ";" that is not a comment ("' + after +
                    '") — the rewriter keeps that text and truncates the value');
            }
        });

        test.equal(problems.length, 0, 'settings-safe consts:\n    ' + problems.join('\n    '));
    });

    test(name + ': does not log response bodies or headers', () => {
        // §52 — no HTML dumps or sensitive data in logs. console.log takes a
        // single String, so logging a body is both useless and a leak.
        const source = fs.readFileSync(path.join(dir, 'module.js'), 'utf8');
        const leaky = [];
        const re = /console\.(?:log|error)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(source)) !== null) {
            const arg = m[1];
            if (/\b(?:body|text|_data|html|headers|cookies?)\b/i.test(arg)) {
                leaky.push('console call logs a payload: ' + m[0].replace(/\s+/g, ' '));
            }
        }
        test.equal(leaky.length, 0, 'no payload logging:\n    ' + leaky.join('\n    '));
    });
}

test.run();
