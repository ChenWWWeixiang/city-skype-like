// ============================================================================
//  入口：装配渲染器 / 网络 / 交互 / UI
// ============================================================================
import * as THREE from 'three';
import { net, state } from './net.js';
import { RtsCamera } from './camera.js';
import { createRenderer, createScene, rebuildWater, applyQuality } from './render/world.js';
import { RoadRenderer } from './render/roads.js';
import { BuildingRenderer } from './render/buildings.js';
import { AgentRenderer } from './render/agents.js';
import { PropRenderer } from './render/props.js';
import { SignalRenderer } from './render/signals.js';
import { OverlayRenderer } from './render/overlay.js';
import { ServiceRenderer } from './render/services.js';
import { IncidentRenderer } from './render/incidents.js';
import { UI } from './ui.js';
import { Tools } from './tools.js';
import { Tutorial } from './tutorial.js';
import { MAP } from './constants.js';

async function main() {
  const canvas = document.getElementById('viewport');
  const renderer = createRenderer(canvas);
  const world = createScene();
  const scene = world.scene;
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 5000);

  const rts = new RtsCamera(camera, canvas);
  rts.focus(0, 0, 360);

  const roads = new RoadRenderer(scene);
  const buildings = new BuildingRenderer(scene);
  const agents = new AgentRenderer(scene);
  const props = new PropRenderer(scene);
  const signals = new SignalRenderer(scene);
  const overlay = new OverlayRenderer(scene);
  const services = new ServiceRenderer(scene);
  const incidents = new IncidentRenderer(scene);

  const ui = new UI(net);
  await ui.loadConfig();
  ui.renderToolOptions('select', {});
  ui.refreshCityList();

  const tools = new Tools({ dom: canvas, camera, net, ui, overlay, state });
  const tutorial = new Tutorial(net);
  tutorial.mount();
  rts.leftMode = 'rotate';                  // 初始工具为"选择"，左键拖拽 = 3D 转视角
  ui.onTool = (t) => {
    // 选择模式：左键拖拽 = 3D 转视角；其它工具：左键留给绘制
    rts.leftMode = (t === 'select') ? 'rotate' : 'off';
    if (t === 'overlay') {
      tools.setTool('overlay');
      overlay.setMode(tools.opt.overlay || 'none');
      overlay.rebuild(state);
    } else {
      tools.setTool(t);
      overlay.setMode('none');
      overlay.rebuild(state);
    }
  };
  ui.onOverlay = (m) => { overlay.setMode(m); overlay.rebuild(state); };

  net.on('message', (m) => {
    if (m.text) ui.toast(m.text, m.ok ? 'ok' : 'err');
  });
  net.on('state', () => {
    ui.update();
    tutorial.update();
  });
  net.on('joined', (m) => {
    document.getElementById('loading').classList.add('gone');
    // 请求的城市不存在时服务端会新建一座，同步地址栏避免刷新又建新城市
    const cur = new URLSearchParams(location.search).get('c');
    if (m && m.cityId && cur !== m.cityId) {
      history.replaceState(null, '', '?c=' + m.cityId);
    }
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      const v = state.speed === 0 ? 1 : 0;
      ui.setSpeedUI(v);
      net.send({ name: 'speed', value: v });
      return;
    }
    if (k >= '1' && k <= '5') {
      const v = +k - 1;
      ui.setSpeedUI(v);
      net.send({ name: 'speed', value: v });
      return;
    }
    const map = { r: 'road', z: 'zone', s: 'service', g: 'entrance', l: 'lane', x: 'bulldoze', escape: 'select' };
    if (map[k]) {
      const btn = document.querySelector('.tool[data-tool="' + map[k] + '"]');
      if (btn) btn.click();
      else if (k === 'escape') document.querySelector('.tool[data-tool="select"]').click();
    }
    if (k === 'v') document.querySelector('.tool[data-tool="overlay"]').click();
  });

  const params = new URLSearchParams(location.search);
  if (params.get('nohelp') === '1') {
    document.getElementById('help').classList.add('hidden');
  }
  let cityId = params.get('c');
  if (!cityId) {
    // 无参数：请求创建一座新城市
    try {
      const r = await fetch('/api/cities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新城市' }),
      });
      const j = await r.json();
      cityId = j.id;
      history.replaceState(null, '', '?c=' + cityId);
    } catch (e) { /* 忽略，使用本地模式 */ }
  }
  net.connect(cityId);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------------------------------------------------------------- 主循环
  let last = performance.now();
  let propTimer = 0;
  let fpsAcc = 0, fpsCount = 0, fpsTimer = 0;
  const fpsEl = document.createElement('div');
  fpsEl.className = 'stat';
  fpsEl.style.cssText = 'position:fixed;right:284px;bottom:10px;z-index:19;font-size:11px;padding:3px 8px';
  document.body.appendChild(fpsEl);
  let vehCount = 0;
  let movingCount = 0;
  let frameErrors = 0;
  let quality = 2;          // 2 高 / 1 中 / 0 低
  let qualityLock = 0;      // 降档后一段时间内不再自动升档，避免来回抖动
  function setQuality(q) {
    quality = applyQuality(renderer, world, q);
    qualityLock = 12;      // 12 个采样周期(约 6 秒)内不自动升档
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    try {
      draw(dt);
    } catch (err) {
      if (frameErrors++ < 3) console.error('[render]', err);
    }
  }
  function draw(dt) {

    rts.update(dt);

    // 数据变更 -> 增量重建
    if (state.roadsDirty) {
      roads.rebuild(state);
      props.rebuild(state);
      props.rebuildGates(state);
      signals.rebuild(state, true);
      services.rebuild(state);
      state.roadsDirty = false;
      state.buildingsDirty = true;
    }
    if (state.buildingsDirty) {
      buildings.rebuild(state);
      services.rebuild(state);
      state.buildingsDirty = false;
    }
    incidents.setEvents(state.events);
    incidents.update(dt);
    services.updateBeacons(dt);
    if (state.terrainDirty) {
      rebuildWater(world.water, state);
      state.terrainDirty = false;
    }
    if (state.congestionDirty) {
      roads.updateCongestion(state);
      state.congestionDirty = false;
    }
    if (state.signalsDirty) {
      signals.rebuild(state);
      signals.update(state);
      state.signalsDirty = false;
    }
    propTimer += dt;
    if (propTimer > 0.5) {
      propTimer = 0;
      if (overlay.mode !== 'none') overlay.rebuild(state);
    }
    // 用帧缓冲插值(+航位推算)后的车辆数据渲染，得到 60fps 的连续运动
    const vf = net.vehiclesAt(performance.now());
    if (vf) {
      agents.update(vf.data);
      vehCount = Math.floor(vf.data.length / net.vehStride);
      let mv = 0;
      for (let i = 0; i < vehCount; i++) if (vf.data[i * net.vehStride + 5] > 0) mv++;
      movingCount = mv;
    }

    fpsAcc += dt; fpsCount++; fpsTimer += dt;
    if (fpsTimer > 0.5) {
      const fps = Math.round(fpsCount / fpsAcc);
      fpsEl.textContent = fps + ' FPS · 车辆 ' + vehCount + '（行驶 ' + movingCount + '）' +
        ' · 画质 ' + ['低', '中', '高'][quality] +
        (fps < 30 ? '  ⚠ 目标 30+ FPS' : '');
      fpsAcc = 0; fpsCount = 0; fpsTimer = 0;
      // 自适应画质：低于 30fps 就降档（像素比 -> 阴影），保证车辆运动连贯
      if (fps < 28 && quality > 0) setQuality(quality - 1);
      else if (fps > 56 && quality < 2 && qualityLock <= 0) setQuality(quality + 1);
    }

    // 阴影相机跟随
    world.sun.position.set(rts.target.x - 260, 420, rts.target.z + 200);
    world.sun.target.position.set(rts.target.x, 0, rts.target.z);
    world.sun.target.updateMatrixWorld();
    world.sky.position.set(camera.position.x, 0, camera.position.z);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // 调试入口
  window.CITY = { state, net, rts, scene, renderer, tools, overlay, ui, signals, roads,
    tutorial, setQuality, get quality() { return quality; } };
}

main();
