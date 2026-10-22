// ============================================================================
//  新手引导：分步清单 + 自动检测进度 + 一键建「初级小城」
// ============================================================================
import { state } from './net.js';

const DEFAULT_TAX = { res: 9, com: 9, ind: 9 };

export class Tutorial {
  constructor(net) {
    this.net = net;
    this.done = false;
    this.hidden = false;
    this.el = null;
    this.stepEls = [];
    this.steps = [
      {
        id: 'road',
        title: '修一条主路（≥ 12 格）',
        hint: '按 R 选道路工具，在地面按住拖拽。默认自动吸附成水平/垂直直线，按住 Shift 可以画斜线。',
        check: () => this.countRoads() >= 12,
      },
      {
        id: 'entrance',
        title: '在地图边缘建「高速出入口」',
        hint: '按 G 选出入口工具，点击地图最外圈的道路。它是城市与外界的高速匝道 —— 没有它，外来人口进不来。',
        check: () => (state.entrances || []).length >= 1,
      },
      {
        id: 'res',
        title: '划一块住宅区（≥ 6 格）',
        hint: '按 Z 选分区类型，在道路旁划出住宅用地。市民住在这里，开车去上班。',
        check: () => this.countZone(1) >= 6,
      },
      {
        id: 'comind',
        title: '划商业区与工业区（各 ≥ 3 格）',
        hint: '商业区提供岗位与消费，工业区生产货物 —— 货车会把工业品送到商业区销售。',
        check: () => this.countZone(2) >= 3 && this.countZone(3) >= 3,
      },
      {
        id: 'svc',
        title: '建发电厂 + 水塔',
        hint: '按 S 选服务设施。电和水由设施按半径自动覆盖，不用铺管线；但没有它们，地块不会长出房子。',
        check: () => this.countService() >= 2,
      },
      {
        id: 'traffic',
        title: '让城市跑起来：人口 > 50 且路上有 8 辆车',
        hint: '速度调到 2× / 3×，观察车辆行驶、路口排队，右侧「交通」页能看到拥堵路段。',
        check: () => (state.stats.population || 0) > 50 && (state.traffic.vehicles || 0) >= 8,
      },
      {
        id: 'tax',
        title: '试一次税率调节',
        hint: '在右侧「统计」页拖动住宅税率滑块，观察人口、幸福度和税收的变化。',
        check: () => this.taxChanged(),
      },
    ];
  }

  // ------------------------------------------------------------ 计数
  countRoads() {
    let n = 0;
    for (let i = 0; i < state.road.length; i++) if (state.road[i]) n++;
    return n;
  }
  countZone(kind) {
    let n = 0;
    for (let i = 0; i < state.zone.length; i++) if (state.zone[i] === kind) n++;
    return n;
  }
  countService() {
    let n = 0;
    for (let i = 0; i < state.service.length; i++) if (state.service[i]) n++;
    return n;
  }
  taxChanged() {
    const t = state.tax || DEFAULT_TAX;
    return t.res !== DEFAULT_TAX.res || t.com !== DEFAULT_TAX.com || t.ind !== DEFAULT_TAX.ind;
  }

  // ------------------------------------------------------------ 挂载
  mount() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'tutorial';
    el.id = 'tutorial';

    const head = document.createElement('div');
    head.className = 'tut-head';
    head.innerHTML = '<span class="tut-title">🎓 新手引导</span>';
    const btns = document.createElement('div');
    btns.className = 'tut-btns';
    const bStarter = document.createElement('button');
    bStarter.className = 'tut-btn starter';
    bStarter.textContent = '⚡ 一键建初级小城';
    bStarter.title = '自动生成主干道 + 街区 + 住宅/商业/工业 + 发电厂/水塔/诊所 + 高速出入口';
    bStarter.addEventListener('click', () => this.buildStarter());
    const bHide = document.createElement('button');
    bHide.className = 'tut-btn';
    bHide.textContent = '✕';
    bHide.title = '收起引导';
    bHide.addEventListener('click', () => this.hide());
    btns.appendChild(bStarter);
    btns.appendChild(bHide);
    head.appendChild(btns);
    el.appendChild(head);

    const list = document.createElement('div');
    list.className = 'tut-steps';
    el.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'tut-foot';
    foot.id = 'tut-foot';
    el.appendChild(foot);

    this.el = el;
    this.list = list;
    this.foot = foot;
    document.body.appendChild(el);

    // 收起后可以用这个小按钮再叫回来
    const launcher = document.createElement('button');
    launcher.className = 'tut-launch';
    launcher.id = 'tut-launch';
    launcher.textContent = '🎓 引导';
    launcher.title = '打开新手引导';
    launcher.addEventListener('click', () => this.show());
    document.body.appendChild(launcher);
    this.launcher = launcher;

    for (const s of this.steps) {
      const row = document.createElement('div');
      row.className = 'tut-step';
      const box = document.createElement('i');
      box.className = 'tut-box';
      const txt = document.createElement('span');
      txt.textContent = s.title;
      row.appendChild(box);
      row.appendChild(txt);
      row.addEventListener('click', () => this.focusStep(s));
      list.appendChild(row);
      this.stepEls.push(row);
    }
    this.render();
  }

  /** 一键生成初级小城 */
  buildStarter() {
    const p = this.net.send({ name: 'starter' });
    if (p && p.then) p.then((r) => { /* 失败时服务端会回 toast */ }).catch(() => {});
  }

  hide() {
    this.hidden = true;
    if (this.el) this.el.classList.add('folded');
    if (this.launcher) this.launcher.classList.add('show');
  }
  show() {
    this.hidden = false;
    if (this.el) this.el.classList.remove('folded');
    if (this.launcher) this.launcher.classList.remove('show');
  }

  /** 点击某一步 -> 切到对应工具并高亮提示 */
  focusStep(s) {
    const map = { road: 'road', entrance: 'entrance', res: 'zone', comind: 'zone', svc: 'service', traffic: 'select', tax: 'select' };
    const t = map[s.id];
    if (t) {
      const btn = document.querySelector('.tool[data-tool="' + t + '"]');
      if (btn && !btn.classList.contains('on')) btn.click();
    }
    if (s.id === 'tax') {
      const p = document.getElementById('panel');
      if (p) p.classList.remove('collapsed');
      const tab = document.querySelector('.pt[data-ptab="stats"]');
      if (tab) tab.click();
    }
    this.foot.textContent = '👉 ' + s.hint;
    this.foot.classList.add('show');
  }

  /** 每次状态更新调用 */
  update() {
    if (!this.el) return;
    // 已经建得不错的城市（比如示范城）不必再弹引导，折叠起来即可
    if (!this._checkedInit && state.cityId) {
      this._checkedInit = true;
      const developed = this.countRoads() >= 60 || (state.stats.population || 0) >= 300;
      if (developed) { this.hide(); this.collapsedByInit = true; }
    }
    let allDone = true;
    let firstPending = -1;
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      let ok = false;
      try { ok = !!s.check(); } catch (e) { ok = false; }
      const row = this.stepEls[i];
      row.classList.toggle('ok', ok);
      row.classList.toggle('cur', !ok && firstPending < 0);
      if (!ok) { allDone = false; if (firstPending < 0) firstPending = i; }
    }
    if (allDone && !this.done) {
      this.done = true;
      this.foot.textContent = '🎉 教程完成！你已经会建城了 —— 接下来扩容、修高速、观察拥堵对经济的影响吧。';
      this.foot.classList.add('show', 'done');
      setTimeout(() => { this.hide(); }, 4000);
    } else if (!this.done && firstPending >= 0) {
      this.foot.textContent = '👉 ' + this.steps[firstPending].hint;
      this.foot.classList.add('show');
    }
  }

  render() { this.update(); }
}
