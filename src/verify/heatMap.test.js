'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchHardcoded, scoreHeatMap } from './heatMap.js';

// ---------------------------------------------------------------------------
// Shared fixture: a small resolved token set (cssVar → value)
// ---------------------------------------------------------------------------
const TOKENS = new Map([
  ['--color-blue-500',    '#0f65ef'],
  ['--color-gray-900',    '#333333'],
  ['--color-transparent', 'rgba(0, 0, 0, 0)'],
  ['--radius-200',        '4px'],
  ['--space-400',         '16px'],
]);

// ---------------------------------------------------------------------------
// Test 1: computed value matches a token value → appears in tokenized
// ---------------------------------------------------------------------------
test('computed value matching a token value is classified as tokenized', () => {
  const computed = new Map([
    ['color', '#0f65ef'],       // exact match for --color-blue-500
  ]);

  const { hardcoded, tokenized } = matchHardcoded(computed, TOKENS);

  assert.equal(tokenized.length, 1, 'should have 1 tokenized entry');
  assert.equal(tokenized[0].property, 'color');
  assert.equal(tokenized[0].cssVar, '--color-blue-500');
  assert.equal(hardcoded.length, 0, 'should have 0 hardcoded entries');
});

// ---------------------------------------------------------------------------
// Test 2: #hex color with no token match → hardcoded with confidence 0.9
// ---------------------------------------------------------------------------
test('#hex color with no token match is hardcoded with confidence 0.9', () => {
  const computed = new Map([
    ['background-color', '#ff0000'],  // not in TOKENS
  ]);

  const { hardcoded, tokenized } = matchHardcoded(computed, TOKENS);

  assert.equal(hardcoded.length, 1, 'should have 1 hardcoded entry');
  assert.equal(hardcoded[0].property, 'background-color');
  assert.equal(hardcoded[0].value, '#ff0000');
  assert.equal(hardcoded[0].confidence, 0.9);
  assert.equal(tokenized.length, 0);
});

// ---------------------------------------------------------------------------
// Test 3: rgba() with no match → hardcoded with confidence 0.85
// ---------------------------------------------------------------------------
test('rgba() value with no token match is hardcoded with confidence 0.85', () => {
  const computed = new Map([
    ['box-shadow', 'rgba(255, 0, 0, 0.5)'],  // not in TOKENS
  ]);

  const { hardcoded, tokenized } = matchHardcoded(computed, TOKENS);

  assert.equal(hardcoded.length, 1, 'should have 1 hardcoded entry');
  assert.equal(hardcoded[0].property, 'box-shadow');
  assert.equal(hardcoded[0].confidence, 0.85);
  assert.equal(tokenized.length, 0);
});

// ---------------------------------------------------------------------------
// Test 4: unrecognised value with no match → hardcoded with confidence 0.3
// ---------------------------------------------------------------------------
test('unrecognised value with no token match is hardcoded with confidence 0.3', () => {
  const computed = new Map([
    ['font-family', 'Arial, sans-serif'],  // not a hex/px/rgba
  ]);

  const { hardcoded, tokenized } = matchHardcoded(computed, TOKENS);

  assert.equal(hardcoded.length, 1, 'should have 1 hardcoded entry');
  assert.equal(hardcoded[0].confidence, 0.3);
  assert.equal(tokenized.length, 0);
});

// ---------------------------------------------------------------------------
// Test 5: scoreHeatMap with 2 high-confidence entries → verdict 'actionable'
// ---------------------------------------------------------------------------
test('scoreHeatMap with 2 high-confidence entries returns verdict actionable', () => {
  const hardcoded = [
    { property: 'color',            value: '#ff0000', confidence: 0.9  },
    { property: 'background-color', value: '#00ff00', confidence: 0.9  },
    { property: 'font-family',      value: 'Arial',   confidence: 0.3  },
  ];

  const result = scoreHeatMap(hardcoded);

  // heatScore = (0.9 + 0.9 + 0.3) / 3 = 0.7
  assert.ok(
    Math.abs(result.heatScore - (0.9 + 0.9 + 0.3) / 3) < 1e-9,
    `heatScore should be ~0.7, got ${result.heatScore}`,
  );
  assert.equal(result.highConfidence.length, 2, 'should have 2 high-confidence entries');
  assert.equal(result.verdict, 'actionable');
});
