// ============================================================================
//  HUD：顶栏 / 工具选项 / 统计面板 / 提示
// ============================================================================
import { state } from './net.js';
import { MAP } from './constants.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const money = (n) => (n < 0 ? '-' : '') + '§' + fmt(Math.abs(n));

export class UI {
  constructor(net) {
    this.net = net;
    this.config = null;
    this.tab = 'stats';
    this.hoverTile = -1;
    this.rciFill = {};
    for (const k of ['res', 'com', 'ind']) {
      const bar = $('rci-' + k);
      const fill = document.createElement('i');
      bar.appendChild(fill);
      this.rciFill[k] = fill;
    }
    this.bindStatic();
  }

  /** 同步信号灯方案按钮的选中状态 */
  setSignalMode(mode) {
    const seg = $('signal-modes');
    if (!seg) return;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', +b.dataset.mode === mode);
    });
    const hint = $('signal-hint');
    if (hint) {
      hint.textContent = mode === 0
        ? '四向分相：四个方向轮流放行，右转也要等本方向的绿灯。'
        : (mode === 1
          ? '对向通行：南北/东西成对放行，左转右转随时可走（但要让行）。'
          : '自动：大路口四向分相，小路口对向通行。');
    }
  }

  async loadConfig() {
    const r = await fetch('/api/config');
    this.config = await r.json();
    return this.config;
  }

  bindStatic() {
    // 速度
    $('speeds').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.setSpeedUI(+b.dataset.speed);
      this.net.send({ name: 'speed', value: +b.dataset.speed });
    });
    // 面板页签
    document.querySelectorAll('.pt').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.pt').forEach((x) => x.classList.remove('on'));
        document.querySelectorAll('.ptab').forEach((x) => x.classList.add('hidden'));
        b.classList.add('on');
        $('ptab-' + b.dataset.ptab).classList.remove('hidden');
        this.tab = b.dataset.ptab;
      });
    });
    $('btn-panel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
    // 信号灯方案
    const seg = $('signal-modes');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        this.net.send({ name: 'signal', mode: +b.dataset.mode });
        this.setSignalMode(+b.dataset.mode);
      });
    }
    // 税率
    for (const k of ['res', 'com', 'ind']) {
      const sl = $('tax-' + k);
      sl.addEventListener('input', () => { $('tax-' + k + '-v').textContent = sl.value + '%'; });
      sl.addEventListener('change', () => this.net.send({ name: 'tax', kind: k, value: +sl.value }));
    }
    // 财政结算步长
    const settle = $('settle-step');
    if (settle) {
      settle.addEventListener('input', () => {
        const steps = (this.config && this.config.econ && this.config.econ.settleSteps) || [1, 5, 10, 30, 60];
        const v = steps[Math.max(0, Math.min(steps.length - 1, +settle.value))];
        $('settle-step-v').textContent = v + ' 分钟';
      });
      settle.addEventListener('change', () => {
        const steps = (this.config && this.config.econ && this.config.econ.settleSteps) || [1, 5, 10, 30, 60];
        const v = steps[Math.max(0, Math.min(steps.length - 1, +settle.value))];
        this.net.send({ name: 'settle', minutes: v });
      });
    }
    // 工具栏
    $('toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('.tool');
      if (!b) return;
      document.querySelectorAll('.tool').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (this.onTool) this.onTool(b.dataset.tool);
    });
    // 分享
    $('btn-share').addEventListener('click', () => this.share());
    // 城市
    $('btn-create').addEventListener('click', () => this.createCity());
    $('btn-rename').addEventListener('click', () => this.renameCity());
    $('btn-clone').addEventListener('click', () => this.cloneCity());
    $('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
    $('help-x').addEventListener('click', () => $('help').classList.add('hidden'));
    $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
    $('loading').classList.add('gone');
  }

  setSpeedUI(v) {
    document.querySelectorAll('#speeds button').forEach((b) => {
      b.classList.toggle('on', +b.dataset.speed === v);
    });
  }

  // ------------------------------------------------------------ 顶栏
  update() {
    const st = state.stats, tr = state.traffic;
    $('funds').textContent = fmt(state.funds);
    $('stat-money').classList.toggle('negative', state.funds < 0);
    $('population').textContent = fmt(st.population || 0);
    $('jobs').textContent = '/' + fmt(st.jobs || 0);
    $('happiness').textContent = Math.round(st.happiness || 0);
    const d = state.date;
    $('date').textContent = d.year + '.' + d.month + '.' + d.day;
    $('clock').textContent = String(d.hour).padStart(2, '0') + ':' + String(d.minute).padStart(2, '0');
    this.setSpeedUI(state.speed);

    for (const k of ['res', 'com', 'ind']) {
      const v = Math.max(-1, Math.min(1, state.demand[k] || 0));
      const el = this.rciFill[k];
      const pct = Math.abs(v) * 50;
      if (v >= 0) {
        el.style.bottom = '50%'; el.style.height = pct + '%';
        el.style.background = k === 'res' ? 'var(--res)' : k === 'com' ? 'var(--com)' : 'var(--ind)';
      } else {
        el.style.bottom = '50%'; el.style.height = pct + '%';
        el.style.transform = 'translateY(' + pct + '%)';
        el.style.background = 'rgba(220,220,220,.45)';
      }
      if (v < 0) el.style.transform = 'translateY(' + pct + '%)';
      else el.style.transform = 'none';
    }

    // 统计页
    $('s-pop').textContent = fmt(st.population || 0);
    $('s-jobs').textContent = fmt(st.jobs || 0);
    $('s-unemp').textContent = Math.round((st.unemployment || 0) * 100) + '%';
    $('s-happy').textContent = Math.round(st.happiness || 0) + '%';
    $('s-res').textContent = fmt(st.residential || 0);
    $('s-com').textContent = fmt(st.commercial || 0);
    $('s-ind').textContent = fmt(st.industrial || 0);
    $('s-land').textContent = Math.round(st.landValueAvg || 0);
    const effInd = Math.round((st.effIndustrial === undefined ? 1 : st.effIndustrial) * 100);
    const effCom = Math.round((st.effCommercial === undefined ? 1 : st.effCommercial) * 100);
    const effRes = Math.round((st.effResidential === undefined ? 1 : st.effResidential) * 100);
    $('s-eff-ind').textContent = effInd + '%';
    $('s-eff-com').textContent = effCom + '%';
    $('s-eff-res').textContent = effRes + '%';
    $('s-eff-ind').style.color = effInd < 60 ? 'var(--bad)' : effInd < 85 ? 'var(--warn)' : 'var(--good)';
    $('s-eff-com').style.color = effCom < 60 ? 'var(--bad)' : effCom < 85 ? 'var(--warn)' : 'var(--good)';
    $('s-power').textContent = Math.round(st.powerCoverage || 0) + '%';
    $('s-water').textContent = Math.round(st.waterCoverage || 0) + '%';
    for (const k of ['res', 'com', 'ind']) {
      const sl = $('tax-' + k);
      if (document.activeElement !== sl) { sl.value = state.tax[k]; $('tax-' + k + '-v').textContent = state.tax[k] + '%'; }
    }

    // 财政页
    const b = this.budgetBreakdown();
    $('b-income').textContent = money(st.income || 0) + '/时';
    $('b-road').textContent = money(-b.road) + '/时';
    $('b-svc').textContent = money(-b.service) + '/时';
    $('b-admin').textContent = money(-b.admin) + '/时';
    const netv = (st.income || 0) - (st.expense || 0);
    const netEl = $('b-net');
    netEl.textContent = money(netv) + '/时';
    netEl.style.color = netv >= 0 ? 'var(--good)' : 'var(--bad)';
    const netMin = st.netMin === undefined ? netv / 60 : st.netMin;
    const nm = $('b-netmin');
    nm.textContent = (netMin >= 0 ? '+' : '') + netMin.toFixed(2) + ' §/分';
    nm.style.color = netMin >= 0 ? 'var(--good)' : 'var(--bad)';
    // 结算步长
    const steps = (this.config && this.config.settleSteps) || [1, 5, 10, 30, 60];
    const curStep = state.settleMinutes || 10;
    const sl = $('settle-step');
    if (sl && document.activeElement !== sl) {
      const idx = steps.indexOf(curStep);
      sl.value = idx >= 0 ? idx : 2;
    }
    $('settle-step-v').textContent = curStep + ' 分钟';
    const last = (state.ledger || [])[state.ledger.length - 1];
    $('b-last').textContent = last
      ? (last.net >= 0 ? '+' : '') + fmt(last.net) + ' §　余额 ' + fmt(last.funds)
      : '—';
    const led = $('ledger');
    led.innerHTML = '';
    for (const e of (state.ledger || []).slice(-14).reverse()) {
      const row = document.createElement('div');
      row.className = e.net >= 0 ? 'pos' : 'neg';
      row.innerHTML = '<span>' + e.date.month + '/' + e.date.day + ' ' +
        String(e.date.hour).padStart(2, '0') + ':' + String(e.date.minute).padStart(2, '0') + '</span><b>' +
        (e.net >= 0 ? '+' : '') + fmt(e.net) + ' §</b>';
      led.appendChild(row);
    }

    // 路网连通性提示
    const segs = state.stats.roadSegments || 0;
    const warn = $('net-warn');
    if (segs > 1) {
      warn.classList.remove('hidden');
      warn.textContent = '⚠ 路网被分成 ' + segs + ' 个互不相连的部分，车辆无法跨越，请补建连接道路';
    } else {
      warn.classList.add('hidden');
    }

    // 交通页
    $('t-veh').textContent = fmt(tr.vehicles || 0);
    $('t-jam').textContent = fmt(tr.jammed || 0);
    // 服务端给出的是 m/s，界面按 km/h 显示
    $('t-speed').textContent = ((tr.avgSpeed || 0) * 3.6).toFixed(1) + ' km/h';
    $('t-cong').textContent = (tr.congestion || 0).toFixed(1) + '%';
    $('t-trip').textContent = Math.round(tr.avgTripTime || 0) + ' s';
    $('t-unreach').textContent = fmt(tr.unreachable || 0);
    $('t-dispatch').textContent = fmt(tr.dispatched || 0);
    $('t-dwell').textContent = fmt(tr.dwelling || 0);
    const bp = tr.byPurpose || {};
    $('t-work').textContent = fmt(bp.work || 0);
    $('t-shop').textContent = fmt(bp.shop || 0);
    $('t-freight').textContent = fmt(bp.freight || 0);
    $('t-service').textContent = fmt(bp.service || 0);
    $('cong-fill').style.width = Math.min(100, tr.congestion || 0) + '%';

    // 民生页：人口来源 / 车队 / 事件
    const dem = state.demography || {};
    const fl = state.fleet || {};
    // 人口变化速率（每游戏小时）—— 人口随时在变，要一眼看出涨跌
    const rate = dem.rate || {};
    const rIn = (rate.immig || 0) + (rate.birth || 0);
    const rOut = (rate.death || 0) + (rate.emig || 0);
    const rNet = rate.net === undefined ? (rIn - rOut) : rate.net;
    const rateEl = $('c-rate');
    rateEl.textContent = (rNet >= 0 ? '+' : '') + (Math.round(rNet * 10) / 10) + ' 人/时';
    rateEl.style.color = rNet >= 0 ? 'var(--good)' : 'var(--bad)';
    $('c-rate-in').textContent = '+' + (Math.round(rIn * 10) / 10);
    $('c-rate-in').style.color = rIn > 0 ? 'var(--good)' : 'var(--muted)';
    $('c-rate-out').textContent = '-' + (Math.round(rOut * 10) / 10);
    $('c-rate-out').style.color = rOut > 0 ? 'var(--bad)' : 'var(--muted)';
    // 顶栏人口后面的小箭头
    const pr = $('pop-rate');
    if (pr) {
      pr.textContent = (rNet >= 0 ? '▲' : '▼') + Math.abs(Math.round(rNet * 10) / 10) + '/时';
      pr.style.color = rNet >= 0 ? 'var(--good)' : 'var(--bad)';
    }
    $('c-imm').textContent = fmt(dem.immigrants || 0);
    $('c-birth').textContent = fmt(dem.births || 0);
    $('c-death').textContent = fmt(dem.deaths || 0);
    $('c-emig').textContent = fmt(dem.emigrants || 0);
    $('c-wait').textContent = fmt(dem.waiting || 0);
    $('c-fleet').textContent = fmt(fl.total || 0);
    $('c-fleetsp').textContent = fmt(fl.special || 0);
    $('c-scrapped').textContent = fmt(fl.scrapped || 0);
    const ev = state.events || [];
    const evBox = $('c-events');
    if (!ev.length) {
      evBox.innerHTML = '<div class="muted">暂无事件</div>';
    } else {
      evBox.innerHTML = ev.map((e) => {
        const cls = e.responded ? 'ev ok' : 'ev warn';
        return '<div class="' + cls + '"><span>' + (e.icon || '') + ' ' + (e.name || e.type) + '</span>' +
          '<b>' + (e.responded ? '已派车' : '等待处理') + '</b></div>';
      }).join('');
    }
    const es = state.eventStats || {};
    $('c-fire').textContent = fmt(es.fire || 0);
    $('c-crime').textContent = fmt(es.crime || 0);
    $('c-dis').textContent = fmt(es.disease || 0);
    $('c-acc').textContent = fmt(es.accident || 0);
    $('c-res').textContent = fmt(es.resolved || 0);
    $('c-fail').textContent = fmt(es.failed || 0);
  }

  budgetBreakdown() {
    let street = 0, ave = 0, hwy = 0;
    for (let i = 0; i < state.road.length; i++) {
      const r = state.road[i];
      if (r === 1) street++; else if (r === 2) ave++; else if (r === 3) hwy++;
    }
    const ru = (this.config && this.config.econ && this.config.econ.roadUpkeep) || { 1: 0.5, 2: 1.2, 3: 2.8 };
    const road = street * ru[1] + ave * ru[2] + hwy * ru[3];
    let service = 0;
    if (this.config) {
      const byId = {};
      for (const s of this.config.services) byId[s.id] = s;
      for (let i = 0; i < state.service.length; i++) {
        const s = state.service[i];
        if (s && byId[s]) service += byId[s].upkeep;
      }
    }
    const admin = (this.config && this.config.econ && this.config.econ.baseUpkeep) || 25;
    return { road, service, admin };
  }

  // ------------------------------------------------------------ 工具选项
  renderToolOptions(tool, opt) {
    const box = $('tool-options');
    box.innerHTML = '';
    const cfg = this.config;
    if (!cfg) return;
    const add = (title, items, current, onPick) => {
      const h = document.createElement('h5');
      h.textContent = title;
      box.appendChild(h);
      for (const it of items) {
        const d = document.createElement('div');
        d.className = 'opt' + (it.key === current ? ' on' : '');
        d.innerHTML = '<i class="sw" style="background:' + it.color + '"></i>' +
          '<span class="nm">' + it.name + '</span>' +
          '<span class="pr">§<b>' + fmt(it.cost) + '</b></span>';
        d.addEventListener('click', () => {
          onPick(it.key);
          this.renderToolOptions(tool, opt);
        });
        box.appendChild(d);
      }
    };
    if (tool === 'road') {
      const tip0 = document.createElement('div');
      tip0.className = 'muted';
      tip0.style.cssText = 'font-size:11px;line-height:1.5;margin:0 0 8px;max-width:196px';
      tip0.innerHTML = '按住拖拽即可连续画路：默认<b>吸附成水平/垂直直线</b>，' +
        '终点靠近已有道路会<b>自动接成路口</b>；按住 <b>Shift</b> 可画斜线，' +
        '下方的<b>弯曲</b>参数能画出弧线。路面会<b>随地形起伏</b>（坡度上限 15%）。';
      box.appendChild(tip0);
      // --- 道路类型：卡片式（CS2 风格）---
      const hR = document.createElement('h5');
      hR.textContent = '道路类型';
      box.appendChild(hR);
      const roadCards = document.createElement('div');
      roadCards.className = 'opt-cards';
      for (const r of cfg.roads) {
        const d = document.createElement('div');
        d.className = 'opt-card' + (r.id === opt.roadType ? ' on' : '');
        const lanes = r.lanes || 2;
        d.innerHTML = '<div class="rd-ico"><i></i><i></i><i></i><i></i></div>' +
          '<div class="rd-nm">' + r.name + '</div>' +
          '<div class="rd-sub">' + lanes + ' 车道 · ' + Math.round(r.v0 * 3.6) + ' km/h</div>' +
          '<div class="rd-cost">§' + fmt(r.cost) + '</div>';
        d.addEventListener('click', () => { opt.roadType = r.id; this.renderToolOptions(tool, opt); });
        roadCards.appendChild(d);
      }
      box.appendChild(roadCards);
      // --- 地面 / 高架 / 隧道：分段开关 ---
      const hM = document.createElement('h5');
      hM.textContent = '施工方式';
      box.appendChild(hM);
      const modes = [
        { key: 'surface', name: '地面', tip: '贴着地面的普通道路' },
        { key: 'elevated', name: '高架', tip: '架空的立体交叉（自带坡道）' },
        { key: 'tunnel', name: '隧道', tip: '从山体内部穿过，路面在地下' },
      ];
      const modeRow = document.createElement('div');
      modeRow.className = 'seg';
      for (const m of modes) {
        const b = document.createElement('button');
        const active = (m.key === 'elevated' && opt.elevated) ||
          (m.key === 'tunnel' && opt.tunnel) ||
          (m.key === 'surface' && !opt.elevated && !opt.tunnel);
        b.className = active ? 'on' : '';
        b.textContent = m.name;
        b.title = m.tip;
        b.addEventListener('click', () => {
          opt.elevated = m.key === 'elevated';
          opt.tunnel = m.key === 'tunnel';
          this.renderToolOptions(tool, opt);
        });
        modeRow.appendChild(b);
      }
      box.appendChild(modeRow);
      // 曲率
      const c5 = document.createElement('h5');
      c5.textContent = '弯曲（画弧线）';
      box.appendChild(c5);
      const cur = document.createElement('div');
      cur.className = 'slider';
      cur.innerHTML = '<span style="width:30px">弯曲</span>' +
        '<input type="range" id="curv" min="0" max="100" value="' + Math.round((opt.curvature || 0) * 100) + '">' +
        '<b id="curv-v">' + Math.round((opt.curvature || 0) * 100) + '%</b>';
      box.appendChild(cur);
      const sl = cur.querySelector('#curv');
      sl.addEventListener('input', () => {
        opt.curvature = sl.value / 100;
        cur.querySelector('#curv-v').textContent = sl.value + '%';
      });
    } else if (tool === 'zone') {
      add('分区类型', cfg.zones.map((z) => ({
        key: z.key, name: z.name, cost: z.cost,
        color: z.key === 'res' ? '#3f9d5c' : z.key === 'com' ? '#3f7fd0' : '#d09a3f',
      })), opt.zone, (k) => { opt.zone = k; });
    } else if (tool === 'entrance') {
      const tipE = document.createElement('div');
      tipE.className = 'muted';
      tipE.style.cssText = 'font-size:11px;line-height:1.5;margin:0;max-width:196px';
      tipE.innerHTML = '点击<b>地图边缘的道路</b>建造「高速出入口」。<br>' +
        '它相当于城市与外界的高速匝道：外来车辆从这里开进来上班、' +
        '下班再从这里驶离，<b>人口也更容易流进城市</b>。<br>' +
        '<span style="color:#c8a24a">提示：先在地图边缘修一条路，再点它。</span>';
      box.appendChild(tipE);
    } else if (tool === 'lane') {
      const h5 = document.createElement('h5');
      h5.textContent = '车道类型';
      box.appendChild(h5);
      const tip = document.createElement('div');
      tip.className = 'muted';
      tip.style.cssText = 'font-size:11px;line-height:1.5;margin:2px 0 8px;max-width:196px';
      tip.textContent = '点击道路上的某条车道即可循环切换其类型；路面上的彩色色带即为车道类型。';
      box.appendChild(tip);
      for (const l of (cfg.laneTypes || [])) {
        const d = document.createElement('div');
        d.className = 'opt';
        d.innerHTML = '<i class="sw" style="background:#' + l.color.toString(16).padStart(6, '0') + '"></i>' +
          '<span class="nm">' + l.name + '</span><span class="pr">色带</span>';
        box.appendChild(d);
      }
    } else if (tool === 'service') {
      add('服务设施', cfg.services.map((s) => ({
        key: s.key, name: s.name, cost: s.cost, color: '#' + s.color.toString(16).padStart(6, '0'),
      })), opt.service, (k) => { opt.service = k; });
    } else if (tool === 'overlay') {
      const items = [
        { key: 'none', name: '关闭', cost: 0, color: '#555' },
        { key: 'zone', name: '分区', cost: 0, color: '#3f9d5c' },
        { key: 'land', name: '地价', cost: 0, color: '#3fd08a' },
        { key: 'power', name: '电力/供水', cost: 0, color: '#3fa8d0' },
        { key: 'traffic', name: '交通拥堵', cost: 0, color: '#d09a3f' },
      ];
      add('数据视图', items, opt.overlay, (k) => { opt.overlay = k; if (this.onOverlay) this.onOverlay(k); });
    } else {
      box.classList.remove('show');
      return;
    }
    box.classList.add('show');
  }

  // ------------------------------------------------------------ 地块信息
  showTileInfo(t) { this.setHoverInfo(t); }

  setHoverInfo(t) {
    this.hoverTile = t;
    if (t < 0) return;
  }

  // ------------------------------------------------------------ 提示
  toast(text, kind) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = text;
    box.appendChild(d);
    setTimeout(() => {
      d.style.transition = 'opacity .35s';
      d.style.opacity = '0';
      setTimeout(() => d.remove(), 360);
    }, 2600);
  }

  // ------------------------------------------------------------ 城市 / 分享
  async share() {
    const url = location.origin + location.pathname + '?c=' + state.cityId;
    try {
      await navigator.clipboard.writeText(url);
      this.toast('分享链接已复制：' + url, 'ok');
    } catch {
      this.toast('分享链接：' + url);
    }
  }

  async renameCity() {
    const name = $('city-name').value.trim();
    if (!name || !state.cityId) return;
    this.net.send({ name: 'rename', cityName: name });
    this.toast('城市已重命名为 ' + name, 'ok');
  }

  async createCity() {
    const name = $('city-name').value.trim() || '新城市';
    const r = await fetch('/api/cities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    location.search = '?c=' + j.id;
  }

  async cloneCity() {
    if (!state.cityId) return;
    const r = await fetch('/api/cities/' + state.cityId + '/clone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const j = await r.json();
    this.toast('已创建副本：' + j.name, 'ok');
    location.search = '?c=' + j.id;
  }

  async refreshCityList() {
    const r = await fetch('/api/cities');
    const list = await r.json();
    const box = $('city-list');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="muted">暂无公开城市</div>'; return; }
    for (const c of list.slice(0, 20)) {
      const d = document.createElement('div');
      d.className = 'city-item';
      d.innerHTML = '<span class="cname">' + escapeHtml(c.name) + '</span>' +
        '<span class="cmeta">' + fmt(c.population) + ' 人 · §' + fmt(c.funds) + '</span>';
      d.addEventListener('click', () => { location.search = '?c=' + c.id; });
      box.appendChild(d);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
