// ============================================================================
//  叠加层：分区着色 / 数据视图 / 悬停高亮 / 道路预览
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF } from '../constants.js';

const ZONE_COLOR = {
  1: new THREE.Color(0x3f9d5c),
  2: new THREE.Color(0x3f7fd0),
  3: new THREE.Color(0xd09a3f),
};

export const OVERLAY_MODES = [
  { key: 'none', name: '关闭', desc: '不显示叠加' },
  { key: 'zone', name: '分区', desc: '显示已规划区域' },
  { key: 'land', name: '地价', desc: '土地价值高低' },
  { key: 'power', name: '电力', desc: '电力与供水覆盖' },
  { key: 'traffic', name: '交通', desc: '道路拥堵程度' },
];

export class OverlayRenderer {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(MAP.TILE * 0.92, MAP.TILE * 0.92);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAP.SIZE * MAP.SIZE);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);

    // 悬停高亮
    const hg = new THREE.PlaneGeometry(MAP.TILE, MAP.TILE);
    hg.rotateX(-Math.PI / 2);
    this.hover = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false,
    }));
    this.hover.position.y = 0.09;
    this.hover.renderOrder = 4;
    this.hover.visible = false;
    scene.add(this.hover);

    // 道路/分区预览
    const pg = new THREE.PlaneGeometry(MAP.TILE * 0.98, MAP.TILE * 0.98);
    pg.rotateX(-Math.PI / 2);
    this.preview = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false,
    }), 900);
    this.preview.count = 0;
    this.preview.frustumCulled = false;
    this.preview.renderOrder = 5;
    scene.add(this.preview);

    // 服务设施覆盖半径预览
    const ringGeo = new THREE.RingGeometry(0.985, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    this.radiusRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.radiusRing.visible = false;
    this.radiusRing.renderOrder = 6;
    scene.add(this.radiusRing);
    const fillGeo = new THREE.CircleGeometry(1, 72);
    fillGeo.rotateX(-Math.PI / 2);
    this.radiusFill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.radiusFill.visible = false;
    this.radiusFill.renderOrder = 6;
    scene.add(this.radiusFill);

    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    this.mode = 'none';
  }

  setMode(mode) {
    this.mode = mode;
    this.mesh.visible = mode !== 'none';
  }

  /** 依据当前模式重建叠加层 */
  rebuild(state) {
    if (this.mode === 'none') { this.mesh.count = 0; return; }
    const m = this._m, c = this._c;
    let n = 0;
    for (let i = 0; i < state.zone.length; i++) {
      let col = null;
      if (this.mode === 'zone') {
        if (!state.zone[i]) continue;
        col = ZONE_COLOR[state.zone[i]];
      } else if (this.mode === 'land') {
        const v = state.land[i] / 100;
        c.setHSL(0.33 * (1 - v), 0.72, 0.28 + v * 0.34);
        col = c;
      } else if (this.mode === 'power') {
        if (!state.zone[i] && !state.road[i]) continue;
        if (state.power[i] && state.water[i]) col = new THREE.Color(0x3fd08a);
        else if (state.power[i]) col = new THREE.Color(0x3fa8d0);
        else if (state.water[i]) col = new THREE.Color(0x3f6fd0);
        else col = new THREE.Color(0xd04a4a);
      } else if (this.mode === 'traffic') {
        if (!state.road[i]) continue;
        const v = state.congestion[i] / 255;
        c.setHSL(0.33 * (1 - v), 0.8, 0.28 + v * 0.3);
        col = c;
      }
      if (!col) continue;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      m.makeTranslation((x + 0.5) * MAP.TILE - HALF, 0.075, (z + 0.5) * MAP.TILE - HALF);
      this.mesh.setMatrixAt(n, m);
      this.mesh.setColorAt(n, col);
      n++;
      if (n >= this.mesh.instanceMatrix.count) break;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** 显示服务设施覆盖范围 */
  setRadius(tile, radiusMeters, color) {
    if (tile < 0 || !radiusMeters) {
      this.radiusRing.visible = false;
      this.radiusFill.visible = false;
      return;
    }
    const x = tile % MAP.SIZE, z = Math.floor(tile / MAP.SIZE);
    const wx = (x + 0.5) * MAP.TILE - HALF;
    const wz = (z + 0.5) * MAP.TILE - HALF;
    this.radiusRing.position.set(wx, 0.14, wz);
    this.radiusRing.scale.set(radiusMeters, 1, radiusMeters);
    this.radiusRing.material.color.setHex(color);
    this.radiusRing.visible = true;
    this.radiusFill.position.set(wx, 0.13, wz);
    this.radiusFill.scale.set(radiusMeters, 1, radiusMeters);
    this.radiusFill.material.color.setHex(color);
    this.radiusFill.visible = true;
  }

  setHover(tile) {
    if (tile < 0) { this.hover.visible = false; return; }
    const x = tile % MAP.SIZE, z = Math.floor(tile / MAP.SIZE);
    this.hover.position.set((x + 0.5) * MAP.TILE - HALF, 0.09, (z + 0.5) * MAP.TILE - HALF);
    this.hover.visible = true;
  }

  setPreview(tiles, color, colors) {
    const m = this._m;
    const n = Math.min(tiles.length, this.preview.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      const x = t % MAP.SIZE, z = Math.floor(t / MAP.SIZE);
      m.makeTranslation((x + 0.5) * MAP.TILE - HALF, 0.12, (z + 0.5) * MAP.TILE - HALF);
      this.preview.setMatrixAt(i, m);
      const c = colors ? colors[i] : (color !== undefined ? color : 0xffffff);
      this._c.setHex(c);
      this.preview.setColorAt(i, this._c);
    }
    this.preview.count = n;
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
  }
}
