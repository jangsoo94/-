/**
 * 티어 분류기 회귀 테스트
 * 각 픽스처가 기대한 티어로 판정되는지 확인.
 */

const { classify } = require('./classifier');
const path = require('path');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/fixtures`;

const CASES = [
  { file: 't0-static.html',              expectedTier: 'T0' },
  { file: 't1-appearance.html',          expectedTier: 'T1' },
  { file: 't1-scrolltrigger-nopin.html', expectedTier: 'T1', note: 'ST 로드됐지만 pin 없음 → T1이어야 함' },
  { file: 't2-carousel.html',            expectedTier: 'T2' },
  { file: 't2-video.html',               expectedTier: 'T2' },
  { file: 't3-scrolltrigger-pin.html',   expectedTier: 'T3' },
  { file: 't4-webgl.html',               expectedTier: 'T4' },
];

(async () => {
  let pass = 0, fail = 0;
  const results = [];
  for (const c of CASES) {
    const url = `${BASE}/${c.file}`;
    process.stdout.write(`[test] ${c.file.padEnd(36)} → `);
    try {
      const r = await classify(url);
      const ok = r.tier === c.expectedTier;
      results.push({ ...c, actual: r.tier, tags: r.tags, evidence: r.evidence, ok });
      if (ok) {
        pass++;
        console.log(`PASS  ${r.tier} [${r.tags.join(',')}]  · ${r.evidence[0]?.reason || ''}`);
      } else {
        fail++;
        console.log(`FAIL  expected ${c.expectedTier}, got ${r.tier}  · ${r.evidence[0]?.reason || ''}`);
        console.log('       hints:', JSON.stringify(r.hints));
      }
    } catch (e) {
      fail++;
      console.log(`ERROR  ${e.message}`);
      results.push({ ...c, error: e.message, ok: false });
    }
  }
  console.log(`\n[summary] ${pass}/${CASES.length} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
