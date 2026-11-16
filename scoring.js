const NUMBERS_CLOCKWISE = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
function scoreHit(x, y) {
  const r = Math.hypot(x, y);
  if (r > 1) return { points: 0, label: 'MISS', ring: 'miss' };
  if (r <= 0.0374) return { points: 50, label: 'BULLSEYE!', ring: 'bullseye' };
  if (r <= 0.0935) return { points: 25, label: 'OUTER BULL', ring: 'bull' };
  const angle = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
  const sector = Math.floor((angle + Math.PI / 20) / (Math.PI / 10)) % 20;
  const number = NUMBERS_CLOCKWISE[sector];
  if (r >= 0.953) return { points: 2 * number, label: `DOUBLE ${number}`, ring: 'double' };
  if (r >= 0.582 && r <= 0.629) return { points: 3 * number, label: `TRIPLE ${number}`, ring: 'triple' };
  return { points: number, label: `${number} POINTS`, ring: 'single' };
}

module.exports = { scoreHit, NUMBERS_CLOCKWISE };
