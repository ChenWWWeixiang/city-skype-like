// ============================================================================
//  车辆仿真实验室（3D）：分阶段展示微观车流物理
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
import { MAP, HALF } from './constants.js';

const params = new URLSearchParams(location.search);
let stage = Math.max(1, Math.min(6, parseInt(params.get('stage') || '1', 10) || 1));

const canvas = document.getElementById('viewport');
const renderer = createRenderer(canvas);
const world = createScene();
const scene = world.scene;
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 5000);
const rts = new RtsCamera(camera, canvas);
rts.leftMode = 'rotate';
rts.focus(0, 70, 235);
rts.goalPitch = rts.pitch = 0.58;
rts.goalYaw = rts.yaw = -Math.PI / 5;

const roads = new RoadRenderer(scene);
const buildings = new BuildingRenderer(scene);
const agents = new AgentRenderer(scene);
const props = new PropRenderer(scene);
const signals = new SignalRenderer(scene);

// 地面标记（车位 / 障碍 / 路线）
const markGroup = new THREE.Group();
scene.add(markGroup);
function clearMarks() {
  while (markGroup.children.length) {
    const c = markGroup.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}
function addMark(tile, color, label) {
  const x = tile % MAP.SIZE, z = Math.floor(tile / MAP.SIZE);
  const wx = (x + 0.5) * MAP.TILE - HALF;
  const wz = (z + 0.5) * MAP.TILE - HALF;
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(MAP.TILE * 0.86, 0.25, MAP.TILE * 0.86),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, toneMapped: false }),
  );
  plate.position.set(wx, 0.2, wz);
  g.add(plate);
  const ring = new THREE.Mesh(
    new THREE.BoxGeometry(MAP.TILE * 0.92, 0.12, MAP.TILE * 0.92),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false }),
  );
  ring.position.set(wx, 0.16, wz);
  g.add(ring);
  markGroup.add(g);
}

// ---------------------------------------------------------------- UI
const el = (id) => document.getElementById(id);
const stageBox = el('stages');
for (let i = 1; i <= 6; i++) {
  const b = document.createElement('button');
  b.textContent = '阶段 ' + i;
  b.dataset.stage = i;
  b.onclick = () => {
    stage = i;
    history.replaceState(null, '', '?stage=' + i);
    for (const x of stageBox.children) x.classList.toggle('on', +x.dataset.stage === i);
    net.connect('lab' + i);
  };
  stageBox.appendChild(b);
}
for (const x of stageBox.children) x.classList.toggle('on', +x.dataset.stage === stage);

let paused = false, speed = 1;
el('btnPlay').onclick = () => {
  paused = !paused;
  el('btnPlay').textContent = paused ? '继续' : '暂停';
  net.send({ name: 'labPause', value: paused });
};
el('btnSlow').onclick = () => { speed = 0.5; net.send({ name: 'labSpeed', value: speed }); };
el('btnFast').onclick = () => { speed = 2; net.send({ name: 'labSpeed', value: speed }); };

function fmtStat(L) {
  const s = L.stats || {};
  const rows = [
    ['在场车辆', s.total || 0],
    ['行驶中', s.moving || 0],
    ['停车/排队', s.stopped || 0],
    ['排队车辆', s.queued || 0],
    ['平均车速', (s.avgSpeed || 0).toFixed(1) + ' km/h'],
    ['路网拥堵', (s.congestion || 0).toFixed(1) + ' %'],
  ];
  if (L.signal) rows.push(['信号灯', L.signal.state + ' / 相位 ' + L.signal.phase]);
  for (const r of (L.routes || [])) rows.push([r.name + ' 拥堵', (r.congestion * 100).toFixed(0) + ' %']);
  if (L.chosen) rows.push(['本次路线', L.chosen]);
  return rows.map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('');
}
function fmtCars(L) {
  const cars = (L.cars || []).slice(0, 12);
  if (!cars.length) return '';
  let h = '<table><tr><th>#</th><th>状态</th><th>车速</th><th>车道</th><th>距前车</th><th>等待</th></tr>';
  for (const c of cars) {
    h += '<tr><td>' + (c.note || c.id) + '</td><td>' + c.state + '</td><td><b>' + c.speed + '</b></td><td>' +
      c.lane + '</td><td>' + (c.gap === null ? '-' : c.gap) + '</td><td>' + c.wait + 's</td></tr>';
  }
  return h + '</table>';
}

net.on('state', () => {
  const L = state.lab;
  if (!L) return;
  el('labtitle').textContent = L.title || '';
  el('labdesc').textContent = L.desc || '';
  el('labwatch').textContent = L.watch ? ('▸ ' + L.watch) : '';
  el('labstats').innerHTML = fmtStat(L);
  el('labcars').innerHTML = fmtCars(L);
});
net.on('joined', () => {
  document.getElementById('loading')?.classList.add('gone');
});
net.connect('lab' + stage);

// ---------------------------------------------------------------- 主循环
let last = performance.now();
let fpsAcc = 0, fpsCount = 0, fpsTimer = 0;
let quality = 2, qualityLock = 0;
function setQuality(q) {
  quality = applyQuality(renderer, world, q);
  qualityLock = 12;
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  rts.update(dt);
  if (state.roadsDirty) {
    roads.rebuild(state); props.rebuild(state); signals.rebuild(state, true);
    state.roadsDirty = false; state.buildingsDirty = true;
  }
  if (state.buildingsDirty) { buildings.rebuild(state); state.buildingsDirty = false; }
  if (state.terrainDirty) { rebuildWater(world.water, state); state.terrainDirty = false; }
  if (state.congestionDirty) { roads.updateCongestion(state); state.congestionDirty = false; }
  if (state.signalsDirty) { signals.rebuild(state); signals.update(state); state.signalsDirty = false; }
  const vf = net.vehiclesAt(now);
  if (vf) agents.update(vf.data);
  // 标记
  const L = state.lab;
  if (L && L.markers) {
    const key = L.stage + ':' + L.markers.length;
    if (markGroup.userData.key !== key) {
      markGroup.userData.key = key;
      clearMarks();
      for (const m of L.markers) addMark(m.tile, m.color, m.label);
    }
  }
  world.sun.position.set(rts.target.x - 260, 420, rts.target.z + 200);
  world.sun.target.position.set(rts.target.x, 0, rts.target.z);
  world.sun.target.updateMatrixWorld();
  world.sky.position.set(camera.position.x, 0, camera.position.z);
  renderer.render(scene, camera);

  // 自适应画质：低于 30fps 降档，保证车辆运动连贯
  fpsAcc += dt; fpsCount++; fpsTimer += dt;
  if (fpsTimer > 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    fpsAcc = 0; fpsCount = 0; fpsTimer = 0;
    if (qualityLock > 0) qualityLock--;
    if (fps < 28 && quality > 0) setQuality(quality - 1);
    else if (fps > 56 && quality < 2 && qualityLock <= 0) setQuality(quality + 1);
  }
}
requestAnimationFrame(frame);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

window.CITY = { state, net, rts, scene, renderer, agents, setQuality,
  get quality() { return quality; } };
