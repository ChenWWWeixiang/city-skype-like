// ============================================================================
//  录制演示视频（真正的 60fps 画面，不是 25fps 的降级）
//  做法：Chrome DevTools Protocol 的 Page.startScreencast —— 浏览器每合成一帧
//  就推一帧给我们，带真实时间戳，最后用 ffmpeg 按真实帧率编码成 mp4。
//  运行： node scripts/record.mjs [输出目录]
// ============================================================================
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.resolve('docs/media');
const BASE = process.env.CITY_URL || 'http://127.0.0.1:5173';
const ffmpegPath = ffmpegInstaller.path;
fs.mkdirSync(OUT, { recursive: true });

// 默认「无头」：不弹窗、不抢你桌面的焦点（HEADFUL=1 才开有界面模式）
const HEADFUL = process.env.HEADFUL === '1';

async function launch() {
  // 默认用 Playwright 自带的 Chromium + 无头模式：
  //   不会弹窗抢你桌面的焦点（录制时你照常用电脑），也不跟系统 Chrome 抢配置。
  // 想极致帧率可以 HEADFUL=1（有界面，能跑 60~120fps，但会弹窗口）。
  const args = HEADFUL
    ? ['--no-sandbox', '--ignore-gpu-blocklist', '--hide-scrollbars',
       '--disable-features=CalculateNativeWinOcclusion', '--window-size=1320,820']
    : ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
       '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'];
  return chromium.launch({ headless: !HEADFUL, args });
}

/**
 * 录一段视频：返回 {file, frames, fps}
 * camera: 页面内执行的自定义取景函数
 */
async function record(browser, name, opts) {
  const {
    url, seconds = 12, size = { width: 1024, height: 576 },
    setup, maxFps = 60,
  } = opts;
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('crash', () => console.error('  ! 页面崩溃'));
  browser.on('disconnected', () => console.error('  ! 浏览器连接断开'));
  ctx.on('close', () => console.error('  ! 上下文被关闭'));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(6000);           // 等场景与车辆数据就绪
  if (setup) await setup(page);
  await page.waitForTimeout(1200);

  const cdp = await ctx.newCDPSession(page);
  const tmp = path.join(OUT, '_frames_' + name);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const stamps = [];
  let seq = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    try {
      fs.writeFileSync(path.join(tmp, String(seq++).padStart(6, '0') + '.jpg'), Buffer.from(f.data, 'base64'));
      stamps.push(f.metadata.timestamp);
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    } catch { /* 忽略写盘错误 */ }
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, everyNthFrame: 1,
    maxWidth: size.width, maxHeight: size.height,
  });
  await page.waitForTimeout(seconds * 1000);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await page.waitForTimeout(300);

  // 按真实时间戳推算帧率（取中位数，抗抖动）
  let fps = 30;
  if (stamps.length > 3) {
    const d = [];
    for (let i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    if (med > 0) fps = Math.min(maxFps, Math.max(10, Math.round(1 / med)));
  }
  const mp4 = path.join(OUT, name + '.mp4');
  if (seq > 1) {
    try {
    execFileSync(ffmpegPath, [
      '-y', '-framerate', String(fps), '-start_number', '0', '-i', path.join(tmp, '%06d.jpg'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-r', String(fps), mp4,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      console.error('ffmpeg 失败，重试：', e.stderr ? e.stderr.toString().slice(-600) : e.message);
      try {
        execFileSync(ffmpegPath, [
          '-y', '-framerate', String(fps), '-start_number', '0', '-i', path.join(tmp, '%06d.jpg'),
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast',
          '-crf', '22', '-pix_fmt', 'yuv420p', mp4,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e2) {
        console.error('ffmpeg 重试仍失败：', e2.stderr ? e2.stderr.toString().slice(-600) : e2.message);
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await ctx.close();
  const sizeMB = fs.existsSync(mp4) ? (fs.statSync(mp4).size / 1048576).toFixed(1) : 0;
  console.log(`  ✓ ${name}.mp4  ${seq} 帧 @ ${fps}fps  ${sizeMB}MB` +
    (errors.length ? `  ⚠ 页面错误: ${errors[0]}` : ''));
  return { file: mp4, frames: seq, fps, errors };
}

const browser = await launch();
const results = [];

// ---- 1) 主游戏：路口车流（贴近路面的机位）--------------------------------
results.push(await record(browser, 'game-traffic', {
  url: BASE + '/?c=demo_skyline&nohelp=1',
  seconds: 14,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(-88, 8, 150);
      r.goalPitch = r.pitch = 0.34;
      r.goalYaw = r.yaw = -0.62;
      r.goalDist = r.dist = 150;
    });
  },
}));

// ---- 2) 主游戏：3D 环绕（展示可拖动视角）----------------------------------
results.push(await record(browser, 'game-orbit', {
  url: BASE + '/?c=demo_skyline&nohelp=1',
  seconds: 12,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(0, 0, 250);
      r.goalPitch = r.pitch = 0.52;
      r.goalYaw = r.yaw = -1.0;
    });
    // 缓慢环绕，验证 3D 视角
    for (let i = 0; i < 24; i++) {
      await page.evaluate((k) => { window.CITY.rts.goalYaw = -1.0 + k * 0.05; }, i);
      await page.waitForTimeout(500);
    }
  },
}));

// ---- 3) 实验室：多车跟驰排队 ---------------------------------------------
results.push(await record(browser, 'lab-queue', {
  url: BASE + '/lab.html?stage=2',
  seconds: 12,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(-40, 8, 120);
      r.goalPitch = r.pitch = 0.26;
      r.goalYaw = r.yaw = -1.35;
    });
  },
}));

// ---- 4) 实验室：红绿灯 ---------------------------------------------------
results.push(await record(browser, 'lab-signal', {
  url: BASE + '/lab.html?stage=3',
  seconds: 12,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(0, 8, 120);
      r.goalPitch = r.pitch = 0.34;
      r.goalYaw = r.yaw = -1.0;
    });
  },
}));

// ---- 5) 实验室：瓶颈排队回溯（拥堵）--------------------------------------
results.push(await record(browser, 'lab-jam', {
  url: BASE + '/lab.html?stage=5',
  seconds: 14,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(-40, 8, 140);
      r.goalPitch = r.pitch = 0.24;
      r.goalYaw = r.yaw = -1.35;
    });
  },
}));

// ---- 6) 实验室：按拥堵选路 ----------------------------------------------
results.push(await record(browser, 'lab-route', {
  url: BASE + '/lab.html?stage=6',
  seconds: 14,
  setup: async (page) => {
    await page.evaluate(() => {
      const r = window.CITY.rts;
      r.focus(0, 0, 260);
      r.goalPitch = r.pitch = 0.62;
      r.goalYaw = r.yaw = -1.1;
    });
  },
}));

await browser.close();
console.log('\n全部完成，输出目录：' + OUT);
for (const r of results) console.log('  ' + path.basename(r.file) + `  ${r.frames} 帧 @ ${r.fps}fps`);
