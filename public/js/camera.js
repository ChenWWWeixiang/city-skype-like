// ============================================================================
//  RTS 相机：平移 / 旋转 / 缩放（对标 CS2 操作习惯）
// ============================================================================
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class RtsCamera {
  constructor(camera, dom) {
    this.cam = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.goalTarget = new THREE.Vector3(0, 0, 0);
    this.dist = 320;
    this.goalDist = 320;
    this.yaw = -Math.PI / 4;
    this.goalYaw = -Math.PI / 4;
    this.pitch = 0.72;
    this.goalPitch = 0.72;
    this.minDist = 40;
    this.maxDist = 900;
    this.keys = new Set();
    this.dragging = null;
    // 左键拖拽行为：'rotate' = 3D 转视角（绕目标点旋转）| 'pan' = 平移 | 'off' = 交给工具
    this.leftMode = 'rotate';
    this.last = { x: 0, y: 0 };
    this.bind();
  }

  bind() {
    const d = this.dom;
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        // 右键：平移（按住 Shift 则旋转）
        this.dragging = e.shiftKey ? 'rotate' : 'pan';
        this.last.x = e.clientX; this.last.y = e.clientY;
        d.setPointerCapture(e.pointerId);
      } else if (e.button === 1) {
        this.dragging = 'pan';
        this.last.x = e.clientX; this.last.y = e.clientY;
        d.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (e.button === 0) {
        if (e.altKey) {
          this.dragging = 'pan';
        } else if (this.leftMode === 'rotate') {
          this.dragging = 'rotate';
        } else if (this.leftMode === 'pan') {
          this.dragging = 'pan';
        } else {
          return;                      // 交给道路/分区等工具处理
        }
        this.last.x = e.clientX; this.last.y = e.clientY;
        d.setPointerCapture(e.pointerId);
      }
    });
    d.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      this.last.x = e.clientX; this.last.y = e.clientY;
      // 上下拖：向下拖 = 视角往下压（俯视更多），向上拖 = 抬起来看远景
      // （原来的符号是反的，跟大多数 3D 游戏的肌肉记忆相反）
      if (this.dragging === 'rotate') this.rotate(-dx * 0.005, dy * 0.004);
      else this.pan(dx, dy);
    });
    d.addEventListener('pointerup', (e) => {
      if (this.dragging) { this.dragging = null; try { d.releasePointerCapture(e.pointerId); } catch {} }
    });
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0012);
      this.zoom(f);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  rotate(dyaw, dpitch) {
    this.goalYaw += dyaw;
    this.goalPitch = clamp(this.goalPitch + dpitch, 0.08, 1.52);
  }

  pan(dx, dy) {
    const scale = this.dist * 0.0016;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    // 屏幕右方向 & 前方向
    this.goalTarget.x += (-dx * cos - dy * sin) * scale;
    this.goalTarget.z += (dx * sin - dy * cos) * scale;
    this.clampTarget();
  }

  moveForward(amount) {
    // 相机朝向 = -(sin, cos)，W/S 沿视线方向前进 / 后退
    this.goalTarget.x -= Math.sin(this.yaw) * amount;
    this.goalTarget.z -= Math.cos(this.yaw) * amount;
    this.clampTarget();
  }

  moveRight(amount) {
    this.goalTarget.x += Math.cos(this.yaw) * amount;
    this.goalTarget.z -= Math.sin(this.yaw) * amount;
    this.clampTarget();
  }

  zoom(f) {
    this.goalDist = clamp(this.goalDist * f, this.minDist, this.maxDist);
  }

  focus(x, z, dist) {
    this.goalTarget.set(x, 0, z);
    if (dist) this.goalDist = clamp(dist, this.minDist, this.maxDist);
  }

  clampTarget() {
    const lim = 520;
    this.goalTarget.x = clamp(this.goalTarget.x, -lim, lim);
    this.goalTarget.z = clamp(this.goalTarget.z, -lim, lim);
  }

  update(dt) {
    // 键盘移动
    const sp = this.dist * 0.85 * dt;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.moveForward(sp);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.moveForward(-sp);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.moveRight(-sp);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.moveRight(sp);
    if (this.keys.has('KeyQ')) this.rotate(1.4 * dt, 0);
    if (this.keys.has('KeyE')) this.rotate(-1.4 * dt, 0);

    const k = 1 - Math.pow(0.0015, dt);
    this.target.lerp(this.goalTarget, k);
    this.dist += (this.goalDist - this.dist) * k;
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;

    const cp = Math.cos(this.pitch), sp2 = Math.sin(this.pitch);
    const x = this.target.x + Math.sin(this.yaw) * cp * this.dist;
    const z = this.target.z + Math.cos(this.yaw) * cp * this.dist;
    const y = sp2 * this.dist;
    this.cam.position.set(x, y, z);
    this.cam.lookAt(this.target.x, 0, this.target.z);
  }
}
