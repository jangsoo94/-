/**
 * 강제 조건 + 자기 판별 하이브리드 캡처
 *
 *  강제 조건 (규칙 기반)
 *   - 애니메이션 있는 섹션: 최소 5s 대기
 *   - 애니메이션 없는 섹션: 최소 1s 대기, 최대 대기 상한도 강제
 *   - GNB(sticky/fixed 헤더)는 첫 캡처 이후 숨김 → 섹션마다 중복 캡처 방지
 *
 *  자기 판별 (안정화 감지)
 *   - 현재 뷰포트 안에 CSS animation / transition 실행 요소가 있는지 스캔
 *   - 없으면 애니 없는 섹션 규칙, 있으면 애니 있는 섹션 규칙 적용
 *   - 캡처 직전 연속 두 프레임 diff → 변화가 멈춘 순간에만 셔터
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_TARGET = process.argv[2] || 'https://www.poscoflow.com/kr/';
const OUT_DIR = process.argv[3] || path.resolve(__dirname, 'shots');
const VIEWPORT = { width: 1440, height: 900 };

fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/** 두 프레임을 짧게 비교해 실제로 움직이는지 판별 (pseudo-element·canvas 포함) */
async function detectMotion(page, clip){
  const a = await frameHash(page, clip);
  await sleep(400);
  const b = await frameHash(page, clip);
  return a !== b;
}

/** 캡처 대상 clip 영역의 해시 — 두 프레임 비교용 */
async function frameHash(page, clip){
  const buf = await page.screenshot({ clip, type: 'png', animations: 'allow' });
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** 안정화까지 대기: 두 프레임이 동일해질 때까지, 상한선 안에서 */
async function waitUntilStable(page, clip, { minMs, maxMs, stepMs = 300 }){
  await sleep(minMs);
  const start = Date.now();
  let prev = await frameHash(page, clip);
  while (Date.now() - start < (maxMs - minMs)) {
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
    args: ['--no-sandbox']
  });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    locale: 'ko-KR'
  });
  const page = await ctx.newPage();

  console.log(`[go] ${URL_TARGET}`);
  await page.goto(URL_TARGET, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('[warn] networkidle timeout', e.message));

  // 폰트·이미지 완전 로드 대기
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForLoadState('domcontentloaded');

  // 쿠키 배너 흔한 것들 자동 닫기
  for (const sel of ['button:has-text("동의")','button:has-text("확인")','button:has-text("Accept")','.cookie-close','[aria-label="close"]']) {
    try { await page.locator(sel).first().click({ timeout: 800 }); console.log('[dismiss]', sel); break; } catch {}
  }

  // 지연 로딩 트리거: 끝까지 스크롤 후 원점 복귀
  const total = await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
    return document.body.scrollHeight;
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[layout] total height = ${total}px`);

  // 섹션 구분: 우선 <section> 사용, 없으면 뷰포트 단위로 자름
  let sections = await page.$$eval('section, [class*="section"], main > div', els =>
    els.map(el => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height };
    }).filter(s => s.height > 200 && s.height < 4000)
  );
  if (sections.length < 2) {
    sections = [];
    for (let y = 0; y < total; y += VIEWPORT.height) {
      sections.push({ top: y, height: Math.min(VIEWPORT.height, total - y) });
    }
    console.log('[fallback] use viewport-sized slices');
  }
  // 중복 제거 + 정렬
  sections = sections
    .sort((a,b) => a.top - b.top)
    .filter((s,i,a) => i === 0 || Math.abs(s.top - a[i-1].top) > 100);

  console.log(`[sections] ${sections.length} candidates`);

  const report = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    await page.evaluate(y => window.scrollTo(0, y), Math.max(0, s.top - 0));
    await sleep(300); // 스크롤 후 짧은 여유

    // 두 번째 섹션부터는 GNB(sticky) 숨겨 중복 캡처 방지
    if (i > 0) {
      await page.addStyleTag({ content: `
        header, .header, #header, .gnb, #gnb, nav[role="navigation"],
        [class*="Header"], [class*="Gnb"], [class*="navbar"] {
          position: static !important;
          transform: none !important;
          top: auto !important;
        }
      `}).catch(()=>{});
    }

    const clipProbe = { x:0, y:0, width:VIEWPORT.width, height:Math.min(VIEWPORT.height, s.height) };
    // 자기 판별: 이 섹션에 애니메이션이 있는가?
    const hasMotion = await detectMotion(page, clipProbe);
    const rule = hasMotion
      ? { minMs: 5000, maxMs: 8000, stepMs: 500, tag: 'motion' }
      : { minMs: 1000, maxMs: 2500, stepMs: 300, tag: 'static' };

    const clip = {
      x: 0,
      y: 0, // 뷰포트 기준 (스크롤 상태에서 찍음)
      width: VIEWPORT.width,
      height: Math.min(VIEWPORT.height, s.height)
    };

    const stable = await waitUntilStable(page, clip, rule);
    const file = path.join(OUT_DIR, `section-${String(i+1).padStart(2,'0')}-${rule.tag}.png`);
    await page.screenshot({ path: file, clip, animations: 'disabled' });

    const info = { idx: i+1, top: Math.round(s.top), rule: rule.tag, waited: `${rule.minMs}-${rule.maxMs}ms`, stable, file: path.basename(file) };
    report.push(info);
    console.log('[shot]', JSON.stringify(info));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[done] ${report.length} shots → ${OUT_DIR}`);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
