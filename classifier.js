/**
 * 캡처 난이도 티어 자동 판정기 (T0~T4 + G/S/H/L 태그)
 *
 * 규칙: DOM에서 실제로 관측된 구조만 인정한다.
 *   - 라이브러리 존재는 근거로 안 씀 (스타일시트에 infinite 규칙 있음 ≠ 화면에서 돌고 있음)
 *   - GSAP 로드됨 ≠ ScrollTrigger.pin이 실제로 있음
 *   - rAF 빈도 높음 ≠ WebGL (Lenis 등 스무스 스크롤도 100/s 넘음)
 *
 * 티어 결정: 가장 높은 신호를 따른다.
 *   T4 (WebGL 활성) > T3 (ScrollTrigger.pin 활성) > T2 (무한 애니 or 슬라이더 autoplay or 재생 중 video) > T1 (등장 대기 or lazy 이미지) > T0
 *
 * 태그: 티어와 직교. 여러 개 붙을 수 있음.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8765/demo.html';
const OUT_FILE = process.argv[3] || path.resolve(__dirname, 'shots/tier-report.json');
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classify(url) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'ko-KR' });
  const page = await ctx.newPage();

  // 관측 계측: 페이지 로드 전에 IntersectionObserver·rAF 등을 감싸 카운팅
  await page.addInitScript(() => {
    window.__probe = { io: 0, raf: 0, animateCalls: 0 };
    const OrigIO = window.IntersectionObserver;
    if (OrigIO) {
      window.IntersectionObserver = class extends OrigIO {
        constructor(...args) {
          window.__probe.io++;
          super(...args);
        }
      };
    }
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      window.__probe.raf++;
      return origRAF(cb);
    };
    const origAnimate = Element.prototype.animate;
    if (origAnimate) {
      Element.prototype.animate = function (...args) {
        window.__probe.animateCalls++;
        return origAnimate.apply(this, args);
      };
    }
  });

  const gated = { detected: false, reason: null };
  let navResp;
  try {
    navResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (e) {
    await browser.close();
    return { url, tier: 'G', tags: ['G'], error: e.message };
  }

  // 리다이렉트로 로그인·챌린지 페이지에 갔는지 확인
  const finalUrl = page.url();
  if (/login|signin|challenge|captcha|access.?denied|cloudflare/i.test(finalUrl)) {
    gated.detected = true;
    gated.reason = `redirect to ${finalUrl}`;
  }
  if (navResp && [401, 403].includes(navResp.status())) {
    gated.detected = true;
    gated.reason = `HTTP ${navResp.status()}`;
  }

  // 지연 로딩 트리거: 프리스크롤 후 원점
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await sleep(500);

  // rAF 빈도 1초간 계측 + probe 카운터 회수 (IO/animate 등)
  const rafBefore = await page.evaluate(() => window.__probe.raf);
  await sleep(1000);
  const rafAfter = await page.evaluate(() => window.__probe.raf);
  const rafPerSec = rafAfter - rafBefore;
  const probe = await page.evaluate(() => ({ ...window.__probe }));

  // 핵심 계측: DOM에서 실제 상태를 본다
  const dom = await page.evaluate(() => {
    const out = {
      totalElements: document.querySelectorAll('*').length,
      docHeight: document.body.scrollHeight,
      infiniteAnimActive: 0,
      videoPlaying: 0,
      videoElements: 0,
      sliderAutoplay: false,
      scrollTriggerPins: 0,
      scrollTriggerTotal: 0,
      webglActive: 0,
      canvasCount: 0,
      stickyFixed: 0,
      lazyPending: 0,
      appearanceCandidates: 0,
      hoverRules: 0,
      hasBotChallenge: false,
    };

    // 1) 실제로 재생 중인 무한 애니메이션
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (
        cs.animationName !== 'none' &&
        cs.animationIterationCount === 'infinite' &&
        cs.animationPlayState !== 'paused' &&
        parseFloat(cs.animationDuration) > 0
      ) {
        out.infiniteAnimActive++;
        if (out.infiniteAnimActive > 500) break; // safety
      }
    }

    // 2) 비디오 재생 상태 (실제 재생 + autoplay 의도)
    out.videoAutoplay = 0;
    for (const v of document.querySelectorAll('video')) {
      out.videoElements++;
      if (!v.paused && !v.ended && v.currentTime > 0) out.videoPlaying++;
      if (v.autoplay) out.videoAutoplay++;
    }

    // 3) Swiper autoplay 실제 러닝 상태 (인스턴스 검사)
    if (window.Swiper) {
      for (const el of document.querySelectorAll('.swiper, .swiper-container')) {
        const inst = el.swiper;
        if (inst && inst.autoplay && inst.autoplay.running) {
          out.sliderAutoplay = true;
          break;
        }
      }
    }
    // slick
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.slick) {
      const slicks = window.jQuery('.slick-slider');
      if (slicks.length) {
        slicks.each(function () {
          const s = window.jQuery(this).slick('getSlick');
          if (s && s.options && s.options.autoplay) out.sliderAutoplay = true;
        });
      }
    }

    // 4) GSAP ScrollTrigger pin (라이브러리 존재로만은 판정 안 함)
    const ST = window.ScrollTrigger || (window.gsap && window.gsap.ScrollTrigger);
    if (ST && typeof ST.getAll === 'function') {
      const all = ST.getAll();
      out.scrollTriggerTotal = all.length;
      out.scrollTriggerPins = all.filter((t) => t.pin).length;
    }

    // 5) WebGL 컨텍스트 실제 존재
    for (const c of document.querySelectorAll('canvas')) {
      out.canvasCount++;
      try {
        const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) out.webglActive++;
      } catch {}
    }

    // 6) sticky · fixed
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky' || cs.position === 'fixed') {
        out.stickyFixed++;
        if (out.stickyFixed > 200) break;
      }
    }

    // 7) 등장 대기 후보 = 뷰포트 아래에서 opacity 0/거의 0 인 요소
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.top < vh) continue;
      const cs = getComputedStyle(el);
      const op = parseFloat(cs.opacity);
      if (op < 0.05) {
        out.appearanceCandidates++;
        if (out.appearanceCandidates > 100) break;
      }
    }

    // 8) lazy 이미지 아직 로드 안 됨
    for (const img of document.querySelectorAll('img[loading="lazy"]')) {
      if (!img.complete || img.naturalWidth === 0) out.lazyPending++;
    }

    // 9) :hover CSS 규칙 수
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.selectorText && rule.selectorText.includes(':hover')) out.hoverRules++;
        }
      } catch { /* cross-origin */ }
      if (out.hoverRules > 500) break;
    }

    // 10) 봇 챌린지 흔한 마커
    if (
      document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="recaptcha"], #cf-challenge, .cf-browser-verification, [data-sitekey]')
    ) {
      out.hasBotChallenge = true;
    }
    return out;
  });

  await browser.close();

  // ─── 티어 판정: 가장 높은 신호 우선 ───
  const evidence = [];
  let tier = 'T0';
  if (dom.hasBotChallenge || gated.detected) {
    tier = 'G';
    evidence.push({ tier: 'G', reason: gated.reason || 'bot challenge marker in DOM' });
  } else if (dom.webglActive > 0) {
    tier = 'T4';
    evidence.push({ tier: 'T4', reason: `WebGL context on ${dom.webglActive}/${dom.canvasCount} canvas` });
  } else if (dom.scrollTriggerPins > 0) {
    tier = 'T3';
    evidence.push({
      tier: 'T3',
      reason: `${dom.scrollTriggerPins} pinned ScrollTrigger of ${dom.scrollTriggerTotal} total`,
    });
  } else if (
    dom.infiniteAnimActive > 0 ||
    dom.videoPlaying > 0 ||
    dom.videoAutoplay > 0 ||
    dom.sliderAutoplay
  ) {
    tier = 'T2';
    const bits = [];
    if (dom.infiniteAnimActive > 0) bits.push(`${dom.infiniteAnimActive} infinite anim active`);
    if (dom.videoPlaying > 0) bits.push(`${dom.videoPlaying}/${dom.videoElements} video playing`);
    else if (dom.videoAutoplay > 0) bits.push(`${dom.videoAutoplay} video with autoplay intent`);
    if (dom.sliderAutoplay) bits.push('slider autoplay running');
    evidence.push({ tier: 'T2', reason: bits.join(' · ') });
  } else if (
    dom.appearanceCandidates > 0 ||
    dom.lazyPending > 0 ||
    probe.io > 0 ||
    probe.animateCalls > 0 ||
    (dom.scrollTriggerTotal > 0 && dom.scrollTriggerPins === 0)
  ) {
    tier = 'T1';
    const bits = [];
    if (dom.appearanceCandidates > 0) bits.push(`${dom.appearanceCandidates} hidden-below-fold`);
    if (dom.lazyPending > 0) bits.push(`${dom.lazyPending} lazy imgs pending`);
    if (probe.io > 0) bits.push(`${probe.io} IntersectionObserver instances`);
    if (probe.animateCalls > 0) bits.push(`${probe.animateCalls} Element.animate() calls`);
    if (dom.scrollTriggerTotal > 0 && dom.scrollTriggerPins === 0) {
      bits.push(`${dom.scrollTriggerTotal} ScrollTrigger (no pin → 등장용 추정)`);
    }
    evidence.push({ tier: 'T1', reason: bits.join(' · ') });
  } else {
    evidence.push({ tier: 'T0', reason: 'no motion/appearance signals' });
  }

  // ─── 태그 판정 ───
  const tags = [];
  if (dom.stickyFixed > 0) tags.push('S');
  if (dom.hoverRules > 10) tags.push('H');
  if (dom.docHeight > 16000) tags.push('L');
  if (gated.detected || dom.hasBotChallenge) tags.push('G');

  return {
    url,
    tier,
    tags,
    evidence,
    hints: {
      // 보조 근거 (판정엔 안 씀, 로그용)
      rafPerSec,
      scrollTriggerTotal: dom.scrollTriggerTotal,
      canvasCount: dom.canvasCount,
      totalElements: dom.totalElements,
      docHeight: dom.docHeight,
      hoverRules: dom.hoverRules,
      probe,
    },
  };
}

if (require.main === module) {
  (async () => {
    const result = await classify(URL_TARGET);
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { classify };
