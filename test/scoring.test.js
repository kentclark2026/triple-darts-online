const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreHit, NUMBERS_CLOCKWISE } = require('../scoring.js');

test('20 sectors in clockwise official order', () => {
  assert.deepEqual(NUMBERS_CLOCKWISE, [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5]);
});
test('bulls, miss, triple twenty, double twenty, single twenty', () => {
  assert.equal(scoreHit(0, 0).points, 50);
  assert.equal(scoreHit(0, .075).points, 25);
  assert.equal(scoreHit(0, .60).points, 60);
  assert.equal(scoreHit(0, .97).points, 40);
  assert.equal(scoreHit(0, .76).points, 20);
  assert.equal(scoreHit(1.3, 0).points, 0);
});
test('clockwise next sector from twenty is one', () => {
  const a = Math.PI/10;
  assert.equal(scoreHit(.7 * Math.sin(a), .7 * Math.cos(a)).points, 1);
});
