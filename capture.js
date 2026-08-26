/**
 * 웨일 스타일 fullPage 단일 컴포지트 + 자기 판별 하이브리드
 *
 *  Phase 1 · 각 섹션 방문 → 애니메이션 유무 자동 분류 → 안정화까지 대기
 *  Phase 2 · 스크롤 원점 복귀 + sticky 헤더 제거 → 페이지 전체를 한 번에 촬영
 *  Phase 3 · 촬영된 fullPage 이미지를 섹션 좌표대로 잘라 개별 PNG로 저장
 *
 *  이 순서로 하면
 *   - 이음새 문제 자체가 없음 (스크롤·스티치 안 함)
 *   - clip을 뷰포트가 아닌 실제 섹션 높이로 잡으므로 잔상·잘림 없음
 *   - sticky GNB는 이미지에 딱 한 번만 등장 (섹션 1)
 */

const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_TARGET = process.argv[2] || 'https://www.poscoflow.com/kr/';
const OUT_DIR = process.argv[3] || path.resolve(__dirname, 'shots');
const VIEWPORT = { width: 1440, height: 900 };

const RULES = {
  static: { minMs: 1000, maxMs: 2500, stepMs: 300 },
  motion: { minMs: 5000, maxMs: 8000, stepMs: 500 },
};

const HIDE_STICKY_CSS = `
  header, .header, #header, .gnb, #gnb, nav[role="navigation"],
  [class*="Header"], [class*="Gnb"], [class*="navbar"], [class*="floating"],
  [style*="position: fixed"], [style*="position:fixed"] {
    position: absolute !important;
    top: 0 !important;
  }
`;

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function frameHash(page, clip) {
  const buf = await page.screenshot({ clip, type: 'png', animations: 'allow' });
  return crypto.createHash('md5').update(buf).digest('hex');
}

async function detectMotion(page, clip) {
  const a = await frameHash(page, clip);
  await sleep(400);
  const b = await frameHash(page, clip);
  return a !== b;
}

async function waitUntilStable(page, clip, { minMs, maxMs, stepMs }) {
  await sleep(minMs);
  const start = Date.now();
  let prev = await frameHash(page, clip);
  while (Date.now() - start < maxMs - minMs) {
    await sleep(stepMs);
    const now = await frameHash(page, clip);
    if (now === prev) return true;
    prev = now;
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  console.log(`[go] ${URL_TARGET}`);
  await page
    .goto(URL_TARGET, { waitUntil: 'networkidle', timeout: 60000 })
    .catch((e) => console.log('[warn] networkidle timeout', e.message));

  await page.evaluate(() => document.fonts && document.fonts.ready);

  for (const sel of [
    'button:has-text("동의")',
    'button:has-text("확인")',
    'button:has-text("Accept")',
    '.cookie-close',
    '[aria-label="close"]',
  ]) {
    try {
      await page.locator(sel).first().click({ timeout: 800 });
      console.log('[dismiss]', sel);
      break;
    } catch {}
  }

  // 지연 로딩 강제 트리거 → 원점 복귀
  const totalHeight = await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
    return document.body.scrollHeight;
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[layout] total = ${totalHeight}px`);

  // 섹션 후보 탐색
  let sections = await page.$$eval(
    'section, [class*="section"], main > div',
    (els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
        })
        .filter((s) => s.height > 200 && s.height < 6000)
  );
  if (sections.length < 2) {
    sections = [];
    for (let y = 0; y < totalHeight; y += VIEWPORT.height) {
      sections.push({ top: y, height: Math.min(VIEWPORT.height, totalHeight - y) });
    }
    console.log('[fallback] viewport-sized slices');
  }
  sections = sections
    .sort((a, b) => a.top - b.top)
    .filter((s, i, a) => i === 0 || Math.abs(s.top - a[i - 1].top) > 100);
  console.log(`[sections] ${sections.length} candidates`);

  // ─────── Phase 1: 섹션별 애니메이션 감지 + 안정화 대기
  const probes = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    await page.evaluate((y) => window.scrollTo(0, y), s.top);
    await sleep(300);

    const probeClip = {
      x: 0,
      y: 0,
      width: VIEWPORT.width,
      height: Math.min(VIEWPORT.height, s.height),
    };
    const hasMotion = await detectMotion(page, probeClip);
    const rule = hasMotion ? { ...RULES.motion, tag: 'motion' } : { ...RULES.static, tag: 'static' };
    const stable = await waitUntilStable(page, probeClip, rule);
    probes.push({ ...s, hasMotion, rule: rule.tag, stable });
    console.log(
      `[probe] #${i + 1} top=${s.top} h=${s.height} → ${rule.tag} stable=${stable}`
    );
  }

  // ─────── Phase 2: fullPage 단일 컴포지트 촬영
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  // sticky/fixed 요소는 fullPage에서 각 뷰포트마다 반복되지 않도록 문서 상단에 고정
  await page.addStyleTag({ content: HIDE_STICKY_CSS });
  await sleep(200);

  const fullPath = path.join(OUT_DIR, '_full.png');
  await page.screenshot({ path: fullPath, fullPage: true, animations: 'disabled' });
  const fullMeta = await sharp(fullPath).metadata();
  console.log(`[fullPage] ${fullMeta.width}×${fullMeta.height}px → _full.png`);

  // ─────── Phase 3: fullPage를 섹션 좌표대로 크롭
  const report = [];
  for (let i = 0; i < probes.length; i++) {
    const s = probes[i];
    // fullPage 이미지는 DSR 1이므로 좌표가 그대로 픽셀
    const left = 0;
    const top = Math.min(s.top, fullMeta.height - 1);
    const width = Math.min(VIEWPORT.width, fullMeta.width);
    const height = Math.min(s.height, fullMeta.height - top);
    if (width <= 0 || height <= 0) continue;

    const outFile = path.join(
      OUT_DIR,
      `section-${String(i + 1).padStart(2, '0')}-${s.rule}.png`
    );
    await sharp(fullPath)
      .extract({ left, top, width, height })
      .toFile(outFile);

    const info = {
      idx: i + 1,
      top: s.top,
      height: s.height,
      rule: s.rule,
      stable: s.stable,
      file: path.basename(outFile),
    };
    report.push(info);
    console.log('[crop]', JSON.stringify(info));
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ url: URL_TARGET, viewport: VIEWPORT, sections: report }, null, 2)
  );
  console.log(`\n[done] ${report.length} shots → ${OUT_DIR}`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
