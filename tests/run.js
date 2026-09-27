'use strict';
/*
 * Runs every *.test.js in this directory, each in its own process.
 *
 * Separate processes because tests/test.js is a singleton registry — requiring
 * two test files into one process would merge their suites and the per-file
 * pass/fail counts would be meaningless.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const only = process.argv[2];

const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => !only || f.indexOf(only) !== -1)
    .sort();

if (files.length === 0) {
    process.stdout.write('no test files matched\n');
    process.exit(1);
}

let failed = 0;

for (const file of files) {
    process.stdout.write('\n' + file + '\n');
    try {
        const out = execFileSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
        process.stdout.write(out);
    } catch (e) {
        failed++;
        process.stdout.write((e.stdout || '') + (e.stderr || ''));
    }
}

process.stdout.write('\n' + (failed ? failed + ' file(s) failed\n' : 'all files passed\n'));
process.exit(failed ? 1 : 0);
