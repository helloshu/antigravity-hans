'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { generateJs, SIGNATURE_START } = require('../localization_engine');

const projectRoot = path.resolve(__dirname, '..');
const dictionaryRoot = path.join(projectRoot, 'dicts');
const dictionaryFiles = fs.readdirSync(dictionaryRoot)
    .filter(fileName => fileName.endsWith('.json'))
    .sort();

let entryCount = 0;
for (const fileName of dictionaryFiles) {
    const filePath = path.join(dictionaryRoot, fileName);
    const dictionary = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary));
    for (const [source, translated] of Object.entries(dictionary)) {
        assert.strictEqual(typeof source, 'string');
        assert.strictEqual(typeof translated, 'string', `${fileName}: ${source}`);
        entryCount++;
    }
}

const generated = generateJs();
assert.ok(generated.includes(SIGNATURE_START));
new vm.Script(generated, { filename: 'generated-localization-injection.js' });

console.log(JSON.stringify({
    test: 'assets_validation.test.js',
    status: 'PASS',
    dictionaries: dictionaryFiles.length,
    entries: entryCount,
    generatedBytes: Buffer.byteLength(generated),
}));
