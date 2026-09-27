'use strict';
/*
 * A dependency-free test runner. The project has no npm dependencies by design
 * (§5, §6) and the test tooling should not introduce one.
 *
 *   require('./test');
 *   test('name', () => { ... });
 *   test.run();
 */

const tests = [];
let current = null;

function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fail(message, detail) {
    const err = new Error(message);
    if (detail !== undefined) err.detail = detail;
    throw err;
}

const api = {
    equal: function (actual, expected, message) {
        if (actual !== expected) {
            fail((message || 'equal') + '\n  expected: ' + JSON.stringify(expected) +
                 '\n  actual:   ' + JSON.stringify(actual));
        }
    },
    deepEqual: function (actual, expected, message) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) {
            fail((message || 'deepEqual') + '\n  expected: ' + b + '\n  actual:   ' + a);
        }
    },
    true: function (value, message) {
        if (value !== true) fail((message || 'expected true') + ', got ' + JSON.stringify(value));
    },
    false: function (value, message) {
        if (value !== false) fail((message || 'expected false') + ', got ' + JSON.stringify(value));
    },
    ok: function (value, message) {
        if (!value) fail((message || 'expected truthy') + ', got ' + JSON.stringify(value));
    },
    includes: function (haystack, needle, message) {
        if (String(haystack).indexOf(needle) === -1) {
            fail((message || 'includes') + '\n  expected to contain: ' + needle +
                 '\n  actual: ' + String(haystack).slice(0, 300));
        }
    },
    run: run
};

Object.keys(api).forEach(function (k) { test[k] = api[k]; });

async function run() {
    let passed = 0;
    const failures = [];

    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            process.stdout.write('  ok   ' + t.name + '\n');
        } catch (e) {
            failures.push({ name: t.name, error: e });
            process.stdout.write('  FAIL ' + t.name + '\n');
        }
    }

    process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');

    if (failures.length) {
        process.stdout.write('\n');
        for (const f of failures) {
            process.stdout.write('--- ' + f.name + '\n' + (f.error.message || f.error) + '\n\n');
        }
        process.exitCode = 1;
    }
}

module.exports = test;
