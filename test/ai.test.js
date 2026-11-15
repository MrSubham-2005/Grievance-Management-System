const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeComplaint, CATEGORIES, normalizeCategory } = require('../server/ai');

function readDropdownCategories() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'raise_complaint.html'),
    'utf8'
  );
  const selectMatch = html.match(/<select[^>]*id="category"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, 'Category select element must exist');
  return [...selectMatch[1].matchAll(/<option(?:\s+[^>]*)?>([^<]+)<\/option>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').trim())
    .filter((label) => label !== '-- Select Category --');
}

test('CATEGORIES matches the exact 26 options in raise_complaint.html', () => {
  const htmlCategories = readDropdownCategories();
  assert.equal(CATEGORIES.length, 26);
  assert.deepEqual(CATEGORIES, htmlCategories);
  assert.equal(CATEGORIES.includes('Infrastructure'), false);
  assert.equal(CATEGORIES.includes('Examinations'), false);
  assert.equal(CATEGORIES.includes('Other'), false);
});

test('normalizeCategory validates strictly against the 26 allowed categories', () => {
  assert.equal(normalizeCategory('IT & Network Support'), 'IT & Network Support');
  assert.equal(normalizeCategory('  computer lab '), 'Computer Lab');
  assert.equal(normalizeCategory('Infrastructure'), '');
  assert.equal(normalizeCategory('Other'), '');
  assert.equal(normalizeCategory(''), '');
  assert.equal(normalizeCategory(null), '');
});

test('analyzeComplaint does not force a category when description is empty or insufficient', async () => {
  const empty = await analyzeComplaint('', []);
  assert.deepEqual(empty.issues, []);
  const short = await analyzeComplaint('abc', []);
  assert.deepEqual(short.issues, []);
});

test('analyzeComplaint filters invalid categories and preserves valid ones', async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              spam: false,
              spamReason: '',
              issues: [
                { text: 'bad cat', category: 'Infrastructure', priority: 'High', reason: 'test' },
                { text: 'wifi down', category: 'IT & Network Support', priority: 'High', reason: 'blocks study' },
              ],
              duplicateOf: '',
              duplicateReason: '',
              verdict: 'WiFi needs IT support.',
            }),
          }],
        },
      }],
    }),
  });
  try {
    const res = await analyzeComplaint('WiFi is not working in computer lab', []);
    assert.equal(res.issues.length, 1);
    assert.equal(res.issues[0].category, 'IT & Network Support');
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
  }
});
