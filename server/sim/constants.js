// ============================================================================
//  全局数值参数（模拟内核 + 前端共享）
//  单位：长度 m，时间 s（游戏内时间），金额 §（Simoleon）
// ============================================================================

// --- 高程 / 坡度 ------------------------------------------------------------
export const ELEV = {
  MAX_RAMP: 2.4,        // 相邻可连通路格的最大高差 (m)：15% 坡度上限
  BRIDGE_HEIGHT: 9.0,   // 高架桥标准高度 (m)
  RAMP_TILES: 6,        // 上下坡过渡格数
  PILLAR_RADIUS: 1.6,   // 桥墩半径 (m)
  GRADE_SPEED_PENALTY:  // 上坡减速系数 (每 10% 坡度)
    0.35,
  MAX_GRADE: 0.18,      // 最大坡度 18%
  // --- 地形高程 ---
  TERRAIN_MAX: 44,      // 最高点（米）
  RIVER_BED: -3.2,      // 河床高度（水面为 0）
  BANK_TILES: 5,        // 河岸过渡带宽度（格）
  BANK_TOP: 0.6,        // 河岸顶面高度（刚好高出水面一点）
  BRIDGE_CLEARANCE: 2.6,// 桥面距水面的净空（米）—— 必须 <= MAX_RAMP 才能从岸边直接上桥
  TUNNEL_DEPTH: 7.0,    // 隧道埋深（米）
  TUNNEL_RAMP_TILES: 3, // 隧道口坡道长度（格）
  MOUNTAIN_MIN_GRADE: 0.22, // 山体坡度阈值：超过这个坡度无法修路（要绕山 / 修隧道）
};

// --- 车道类型 ---------------------------------------------------------------
export const LANE_TYPES = {
  general: { id: 0, name: '常规车道', color: 0xffffff, speedFactor: 1.00 },
  bus:    { id: 1, name: '公交车道', color: 0x3fa9e8, speedFactor: 1.06 },
  bike:   { id: 2, name: '自行车道', color: 0x54c46a, speedFactor: 1.00 },
  turn:   { id: 3, name: '转弯车道', color: 0xf0c04a, speedFactor: 0.92 },
};
export const LANE_TYPE_LIST = Object.values(LANE_TYPES);

export const MAP = {
  SIZE: 48,          // 地图边长（格），48x48 = 2304 格
  TILE: 16,          // 每格边长 (m) -> 768m x 768m 城区
  WATER_SEED: 20240, // 地形随机种子
};

export const TIME = {
  MINUTES_PER_TICK: 1,
  DAYS_PER_MONTH: 30,
  HOURS_PER_DAY: 24,
  // 城市时钟：游戏分钟 / 真实秒。0 号为暂停。
  SPEEDS: [0, 2, 6, 12, 24],
  // 交通时钟：交通秒 / 真实秒。
  // 关键：交通物理必须与经济时钟解耦。若沿用经济时钟(1x = 120 交通秒/秒)，
  // 一辆 11m/s 的车每秒会跑 1320 米 —— 屏幕上就是「瞬移 / 颜色在跳」，
  // 根本看不出车辆在运动，更谈不上观察排队与拥堵。
  // 1x = 1.5 交通秒/真实秒 —— 车看起来就是「城市里正常开车的速度」
  //（街道限速 40km/h，屏幕上约 60km/h），不再是「1x 就飞起来」。
  // 关键不变量：TRAFFIC_SPEEDS[i] * 60 / SPEEDS[i] === 45
  //   也就是「每个游戏小时恰好推进 45 个交通秒」，任何倍速下都成立。
  // 为什么必须这样：移民车 / 迁出车 / 事件都是按「游戏小时」发生的，
  //   但它们占的是「交通时间」（车在路上的时间按交通秒算）。
  //   如果两个时钟的倍率不一致，高倍速下经济会跑得比交通快好几倍 ——
  //   源源不断的移民车被灌进同一条路，车根本开不完，整城瞬间堵死。
  //   （曾经就在 4x 下复现过：40 秒内 460 辆车、拥堵 85%。）
  // 保持 45 这个比例，游戏内快进脚本（make-demo）也与在线玩法完全一致。
  TRAFFIC_SPEEDS: [0, 1.5, 4.5, 9, 18],
  SPEED_LABELS: ['暂停', '1x', '2x', '3x', '4x'],
  TRAFFIC_DT: 0.25,  // 交通物理子步长（游戏秒）：越小跟驰/排队越细腻
  MAX_SUBSTEPS: 2400,// 每真实秒最多子步数（防止卡顿雪崩）；高倍速时步长自动变粗
  // 1x 速度下，1 个「游戏小时」对应多少「交通秒」（两个时钟的比例）
  TRAFFIC_PER_GAME_HOUR: 45,
};

// --- 道路 ------------------------------------------------------------------
export const ROADS = {
  // lanes = 道路「总」车道数（双向合计）；每个方向 lanes/2 条。
  // width 必须 <= 建筑退线(16*0.13*2≈5.9m 的半宽×2≈11.8m)，否则建筑会压在马路上。
  // v0 = 该等级道路的限速 (m/s)：街道 40km/h，大道 60km/h，高速 100km/h
  street: {
    id: 1, name: '街道', cost: 120, upkeep: 4, v0: 11.1, lanes: 2,
    s0: 2.0, T: 1.5, a: 2.8, b: 3.0, width: 8, color: 0x3c4148, zoned: true,
  },
  avenue: {
    id: 2, name: '大道', cost: 300, upkeep: 9, v0: 16.7, lanes: 4,
    s0: 2.0, T: 1.4, a: 3.2, b: 3.0, width: 11, color: 0x474d55, zoned: true,
  },
  highway: {
    id: 3, name: '高速公路', cost: 800, upkeep: 20, v0: 27.8, lanes: 4,
    s0: 2.4, T: 1.3, a: 2.6, b: 2.6, width: 16, color: 0x555b63, zoned: false,
  },
};
export const ROAD_LIST = [ROADS.street, ROADS.avenue, ROADS.highway];

// --- 分区与建筑 ------------------------------------------------------------
export const ZONES = {
  none:   { id: 0, name: '空地' },
  res:    { id: 1, name: '住宅', cost: 25, pollution: 0.0 },
  com:    { id: 2, name: '商业', cost: 40, pollution: 0.05 },
  ind:    { id: 3, name: '工业', cost: 35, pollution: 0.35 },
};

// 每级建筑的容量（人 / 岗位）。等级 0 = 空地（待开发）
export const BUILDING_CAPS = {
  res: [0, 8, 26, 74],   // 独栋 -> 公寓楼 -> 高层公寓
  com: [0, 6, 22, 62],   // 商铺 -> 商业楼 -> 写字楼
  ind: [0, 16, 44, 96],  // 小作坊 -> 厂房 -> 工业园
};

// --- 服务设施 --------------------------------------------------------------
export const SERVICES = {
  // upkeep = 每游戏小时的维护费（市政实时支出）
  police: { id: 1, name: '警察局', cost: 2500, upkeep: 18, radius: 320, capacity: 4000, color: 0x2f6fd0, power: 2, water: 1 },
  fire:   { id: 2, name: '消防站', cost: 2500, upkeep: 18, radius: 320, capacity: 4000, color: 0xd0453a, power: 2, water: 1 },
  clinic: { id: 3, name: '诊所',   cost: 3200, upkeep: 20, radius: 300, capacity: 3500, color: 0xe8e8e8, power: 2, water: 2 },
  school: { id: 4, name: '学校',   cost: 4000, upkeep: 25, radius: 420, capacity: 5200, color: 0xe0b93c, power: 3, water: 2 },
  park:   { id: 5, name: '公园',   cost: 400,  upkeep: 2,  radius: 170, color: 0x3fa14b, power: 0, water: 1 },
  power:  { id: 6, name: '发电厂', cost: 12000, upkeep: 40, radius: 900, color: 0xd98b2b, power: 0, water: 3 },
  water:  { id: 7, name: '水塔',   cost: 1200, upkeep: 8,  radius: 620, color: 0x3aa8d0, power: 1, water: 0 },
};
export const SERVICE_LIST = Object.values(SERVICES);
export const SERVICE_BY_ID = Object.fromEntries(SERVICE_LIST.map((s) => [s.id, s]));

// --- 经济 ------------------------------------------------------------------
// 口径：所有收支都是「每游戏小时」的量。游戏时钟 1x 时 1 游戏小时 = 30 真实秒，
// 所以面板上的钱每秒都在动，而不是「每月结一次账」那种台阶式变化。
export const ECON = {
  START_FUNDS: 120000,
  // 税收基数：每居民 / 每岗位 每「游戏小时」应收的钱（税率 100% 时）
  TAX_BASE_RES: 3.0,
  TAX_BASE_COM: 4.0,
  TAX_BASE_IND: 3.4,
  DEFAULT_TAX: { res: 9, com: 9, ind: 9 },
  MIN_TAX: 0, MAX_TAX: 20,
  ZONE_COST: { res: 25, com: 40, ind: 35 },
  BULLDOZE_REFUND: 0.15,
  // 市政维护（实时支出，每游戏小时）
  BASE_UPKEEP: 25,                       // 行政管理费
  ROAD_UPKEEP: { 1: 0.5, 2: 1.2, 3: 2.8 }, // 每格道路 每游戏小时
  // 结算步长：每 N 个游戏分钟把累计收支结算一次（写进财政流水）
  SETTLE_MINUTES: 10,
  SETTLE_STEPS: [1, 5, 10, 30, 60],
};

// --- 需求 (RCI) ------------------------------------------------------------
export const DEMAND = {
  RES_BASE: 0.42,
  COM_BASE: 0.34,
  IND_BASE: 0.30,
  UNEMPLOY_RES: 1.15,
  UNEMPLOY_COM: 0.95,
  TAX_PENALTY: 0.012,
  CONGESTION_PENALTY: 0.85,
  LANDVALUE_PULL: 0.9,
  SERVICE_PULL: 0.55,
  BROWNOUT_PENALTY: 0.5,
  GROWTH_PERIOD: 6,
  DECLINE_PERIOD: 12,
};

// --- 交通 ------------------------------------------------------------------
// --- 信号灯 ----------------------------------------------------------------
export const SIGNAL = {
  GREEN: 22,       // 绿灯时长 (交通秒)
  YELLOW: 2.5,     // 黄灯时长
  ALL_RED: 0.5,     // 全红清空
  NODE_CAPACITY: 4,   // 路口内最多同时容纳的车辆数
  // 周期要匹配街区尺度：格宽 16m、街区 64~96m，车过一段路只要 7 秒。
  // 若用 60 秒以上的周期，红灯等待会吃掉绝大部分时间（车队均速掉到 1~2 m/s）。
  CYCLE: 24,       // 完整周期（南北 + 东西各一轮），1x 下约 6 秒一个周期
  WAVE: 1.45,      // 绿波系数：每格相位提前秒数（16m/格 ÷ 11.1m/s ≈ 1.44s，与车速匹配）
  // --- 信号灯方案（可在城市设置里切换）---------------------------------
  // MODE.FOUR_WAY  : 四向分相 —— 北/东/南/西 各自放行，互不冲突
  // MODE.PERMISSIVE: 对向通行 —— 南北一组、东西一组；左转/右转让行（permissive）
  // MODE.AUTO      : 自动 —— 四岔主干路口用四向分相，其余用对向通行
  MODE: { FOUR_WAY: 0, PERMISSIVE: 1, AUTO: 2 },
  MODE_LIST: [
    { id: 0, key: 'four', name: '四向分相', desc: '四个方向分别放行，互不冲突（最安全，最堵）' },
    { id: 1, key: 'perm', name: '对向通行', desc: '南北/东西成对放行，左转右转让行（通行效率最高）' },
    { id: 2, key: 'auto', name: '自动', desc: '大路口四向分相，小路口对向通行' },
  ],
  CYCLE_FOUR_WAY: 32,        // 四向分相的周期（4 个相位，各 8 秒）
  PERMISSIVE_YIELD: 30,      // 允许左转时，检查对向直行车的距离（米）
  PERMISSIVE_GAP: 15,       // 让行判定：冲突车离路口这么近才需要让行（米）
  RIGHT_TURN_FREE: true,     // 右转不受红灯限制（让行后通行）—— 与真实规则一致
};

export const TRAFFIC = {
  MAX_VEHICLES: 1100,
  TOW_WAIT_SECONDS: 150,      // 车一动不动超过这么久（交通秒）就被清障车拖走
  // 出行强度以「交通日」计：1 个交通日 = 24 个交通小时
  SEC_PER_HOUR: 56,             // 1 交通小时 = 56 交通秒（1x 下约 37 秒真实时间）
  DAY_SEC: 1344,                // 1 交通日 = 24 交通小时（1x 下约 15 分钟真实时间）
  // 出行次数（每交通日）。交通时钟放慢后（车速更真实），同样数量的车在路上的
  // 时间更长，所以这里相应调低，避免整城死锁 —— 目标是「繁忙但流动」。
  // 出行强度：路网是有通行能力的，需求必须低于容量，否则整城死锁。
  // 现在的取值配合「需求自适应」（拥堵时自动少出门）能让城市
  // 平时流动、早晚高峰出现真正的排队，而不是永远堵死。
  TRIPS_PER_RESIDENT_DAY: 0.25,  // 每位居民每个交通日的外出次数（上班 + 购物）
  TRIPS_PER_JOB_DAY: 0.06,   // 每个岗位每个交通日产生的货运/出行次数
  TRUCK_RATIO: 0.14,
  HOUR_WEIGHTS: [
    0.20, 0.10, 0.05, 0.05, 0.10, 0.45, 1.20, 2.60,
    3.00, 1.80, 1.10, 1.00, 1.00, 1.00, 1.05, 1.20,
    1.50, 1.90, 2.10, 1.70, 1.20, 0.80, 0.50, 0.30,
  ],
  MAX_PATH_NODES: 400,
  REPATH_INTERVAL: 45,
  NODE_CAPACITY: 3,
  ENTRY_GAP: 3.5,    // 进入下一路段所需的最小空隙（米）：太大路口 throughput 上不去
  LANE_CHANGE_MIN_GAP: 18,
  BODY_GAP: 0.6,          // 车身硬约束：保险杠之间的最小间距（米），保证永不重叠
  BODY_PAD: 1.2,          // 发车时预留的额外余量
  SAMPLE_CONGESTION: 8,      // 交通统计采样间隔（游戏秒）
  MAX_PARKED_CARS: 320,      // 路边停放车辆上限（纯装饰，避免刷屏）
  ENTRANCE_TRIP_RATIO: 0.30,   // 有对外连接时，外部通勤车占出行总量的比例
  // --- 过境车流（外部货车 / 长途客车）---
  // 从一个高速出入口进、另一个高速出入口出的车。它们不属于本市车队，
  // 也不改变人口，但会把城市的「交通枢纽」属性真实地跑出来：
  // 高速限速高 -> 过境车自然选高架环线 / 快速路（按限速算最快到达）。
  THROUGH_PER_HOUR_BASE: 2.2,     // 每个高速出入口对、每交通小时的基础过境车数
  THROUGH_PER_HOUR_POP: 0.0022,   // 每位居民额外增加的过境车数（人口越多，过境越多）
  THROUGH_TYPES: ['truck', 'truck', 'bus', 'truck', 'car'],  // 过境车型分布
  ENTRANCE_COST: 800,          // 建造一个高速出入口（对外连接）的费用
  VEHICLE_TYPES: {
    car:   { id: 0, len: 4.2, width: 1.9, speedFactor: 1.00, name: '轿车' },
    truck: { id: 1, len: 8.5, width: 2.4, speedFactor: 0.88, name: '货车' },
    bus:   { id: 2, len: 11.0, width: 2.5, speedFactor: 0.82, name: '公交' },
    bike:  { id: 3, len: 1.9, width: 0.8, speedFactor: 0.55, name: '自行车' },
  },
  BIKE_RATIO: 0.16,
  // --- 速度规则：限速 / 弯道 / 路口 ---
  // 不同等级道路限速不同（ROADS.*.v0）；弯道与路口还要额外减速，
  // 减速会直接拉低通行效率 —— 工厂迟到、商业断货都是这么来的。
  CURVE_SPEED: 0.62,      // 弯道限速系数（相对该道路限速）
  CURVE_ANGLE: 0.32,       // 超过这个转角(rad)就算「弯道」，开始减速
  TURN_SPEED: 0.45,        // 路口转弯限速系数
  TURN_ANGLE: 0.55,        // 超过这个转角(rad)就算「转弯」
  INTERSECTION_ZONE: 9,     // 路口影响半径 (m)：进入路口就开始减速
  STOP_LINE: 9,           // 停止线到路口中心的距离 (m)：红灯时车停在路口外
  TURN_RADIUS: 11,         // 转弯圆滑半径 (m)：车辆在路口走一段弧线，而不是直角折线
  SLIP_RADIUS: 17,         // 大型路口「弧形右转通道」的转弯半径 (m)
  SLIP_FLARE: 4.5,         // 右转通道外扩（米）：车辆从路口外侧绕过
  TURN_LANE_DIST: 70,      // 距路口多少米开始提前变道到转向车道
  LANE_CHANGE_RATE: 2.0,   // 变道横向移动速率（1/秒）：变道要「滑过去」，不能瞬移
  GRADE_SPEED: 0.55,       // 坡度对车速的额外影响系数（每 10% 坡度）
  // 特种车辆（外形参数）
  SPECIAL_TYPES: {
    police:    { id: 4, len: 4.4, width: 1.9, speedFactor: 1.18, name: '警车',   color: 0x1b3a6b, light: 0x3355ff },
    fire:      { id: 5, len: 8.0, width: 2.4, speedFactor: 1.05, name: '消防车', color: 0xb0261f, light: 0xff3322 },
    ambulance: { id: 6, len: 5.6, width: 2.1, speedFactor: 1.14, name: '救护车', color: 0xf2f2f2, light: 0xffdd33 },
    hearse:    { id: 7, len: 5.8, width: 2.1, speedFactor: 1.00, name: '灵车',   color: 0xe8e8ea, light: 0xffffff },
    garbage:   { id: 8, len: 8.2, width: 2.4, speedFactor: 0.90, name: '垃圾车', color: 0x3f7a4a, light: 0x66ff88 },
  },
};

// --- 出行目的与车辆类型 ----------------------------------------------------
export const TRIP = {
  // 停留时间单位为「交通秒」（交通时钟），不是经济时钟的游戏分钟
  WORK_DWELL: [24, 60],      // 上班停留
  SHOP_DWELL: [12, 30],      // 购物停留
  FREIGHT_DWELL: [10, 24],   // 送货停留
  SERVICE_DWELL: [30, 80],   // 警消救护现场处置
  SHOP_CHANCE: 0.55,         // 下班后去商业区的概率
};

// --- 人口与车队（人口由「外来车辆 + 新生儿」产生，车队守恒）--------------
// 规则：
//   1. 车不会凭空出现：新车只在家里的车位诞生（居民买车 / 外来移民开车进城）。
//   2. 车不会凭空消失：车开进建筑 = 停进车库（不再出现在路上，但仍属于这座城），
//      只有「驶出城市（迁出）」和「报废」才会让车离开车队。
//   3. 人口只有两个来源：外来车辆（移民）与新生儿；只有两个出口：死亡与迁出。
export const DEMOGRAPHY = {
  PEOPLE_PER_CAR: 3.0,             // 每 3 个居民拥有 1 辆车
  PEOPLE_PER_HOUSEHOLD: 6.5,
  IMMIGRATION_BASE_PER_HOUR: 3.0,  // 每个出入口每小时接纳的移民（基准）
  IMMIGRATION_MAX_PER_HOUR: 3.0,   // 上限（每个出入口每游戏小时）
  IMMIGRATION_JOB_FACTOR: 1.5,      // 岗位越充裕，移民越多（上限倍数）
  BIRTH_RATE_PER_HOUR: 0.00022,     // 每小时出生率（占人口比例）
  DEATH_RATE_PER_HOUR: 0.00010,     // 每小时死亡率
  EMIGRATION_RATE_PER_HOUR: 0.00040, // 基础迁出率
  EMIGRATION_UNHAPPY_FACTOR: 10.0,  // 幸福度越低，迁出越多（倍数）
  PASSENGERS_MIN: 1,
  PASSENGERS_MAX: 4,
  SCRAP_MIN_AGE_DAYS: 120,          // 车龄超过这个天数开始报废
  HOMELESS_HAPPINESS_PENALTY: 0.55, // 住房不足（有人露宿）对幸福度的惩罚
  WAITING_HAPPINESS_PENALTY: 0.25,  // 移民滞留待安置的惩罚
};

// --- 事件系统（火灾 / 犯罪 / 疾病 / 事故）---------------------------------
export const INCIDENTS = {
  fire: {
    id: 'fire', name: '火灾', icon: '🔥', color: 0xff5a1f, service: 'fire',
    ratePerBuildingHour: 0.00005,   // 每游戏小时每栋建筑的基础起火率
    industrialBonus: 3.0,           // 工业区起火概率倍率
    growPerHour: 0.16,               // 严重度增长（每小时）
    resolveHours: 2.6,               // 消防车到场后的处置时间
    damageLevels: 1,                 // 扑灭失败 -> 建筑等级 -1
    happinessHit: 6,
  },
  crime: {
    id: 'crime', name: '犯罪', icon: '🚓', color: 0xffd23f, service: 'police',
    ratePerBuildingHour: 0.00030,
    commercialBonus: 2.2, nightBonus: 2.0,
    growPerHour: 0.22,
    resolveHours: 2.0,
    fine: 90,                        // 未被制止的损失（还会按城市规模放大）
    happinessHit: 2.5,
  },
  disease: {
    id: 'disease', name: '疾病', icon: '🚑', color: 0x63d97a, service: 'ambulance',
    ratePerBuildingHour: 0.00004,
    densityBonus: 1.0,               // 住宅密度越高越容易爆发
    growPerHour: 0.12,
    resolveHours: 3.2,
    fatality: 0.30,                  // 未及时救治的死亡率
    happinessHit: 3.0,
  },
  accident: {
    id: 'accident', name: '事故', icon: '⚠', color: 0xff8c1a, service: 'police',
    ratePerVehicleHour: 0.00020,     // 按在途车辆数产生
    congestionBonus: 2.6,            // 越堵越容易出事故
    growPerHour: 0.0,
    resolveHours: 1.3,
    blockMinutes: 40,                // 占用车道的时间（游戏分钟）
    happinessHit: 1.2,
  },
};

// --- 特种车队：特种建筑诞生时，同时诞生对应的特种车辆 -------------------
// （车随建筑来：建消防站 -> 消防车诞生；拆消防站 -> 消防车同时消失）
export const SERVICE_FLEET = {
  1: [{ type: 'police', count: 2 }],                        // 警察局
  2: [{ type: 'fire', count: 2 }],                          // 消防站
  3: [{ type: 'ambulance', count: 2 }, { type: 'hearse', count: 1 }], // 诊所
  4: [{ type: 'bus', count: 3 }],                           // 学校 -> 校车
  5: [{ type: 'garbage', count: 1 }],                       // 公园 -> 环卫车
};

// 特种车辆（按需出动）
export const SERVICE_DISPATCH = {
  1: { type: 'police',   name: '警车',   max: 3, need: 0.006, radius: 1.2, dwell: [30, 80] }, // 警察局
  2: { type: 'fire',     name: '消防车', max: 3, need: 0.005, radius: 1.2, dwell: [40, 100] }, // 消防站
  3: { type: 'ambulance',name: '救护车', max: 3, need: 0.007, radius: 1.2, dwell: [26, 62] }, // 诊所
  4: { type: 'bus',      name: '校车',   max: 1, need: 0.004, radius: 1.0, dwell: [50, 100] }, // 学校
  5: { type: 'garbage',  name: '垃圾车', max: 2, need: 0.016, radius: 1.4, dwell: [12, 30] }, // 公园（环卫）
  6: { type: 'truck',    name: '货运车', max: 2, need: 0.01, radius: 1.0, dwell: [12, 30] }, // 发电厂（物资）
  7: { type: 'hearse',   name: '灵车',   max: 1, need: 0.003, radius: 1.6, dwell: [20, 55] }, // 水塔（殡仪）
};

// --- 拥堵 -> 效率 -> 经济 ----------------------------------------------------
export const EFFICIENCY = {
  RES_LOSS: 0.45,      // 住宅因通勤受阻损失的效率
  COM_LOSS: 0.70,      // 商业因客流/物流受阻损失的效率
  IND_LOSS: 0.85,      // 工业因原料/出货受阻损失的效率（最敏感）
  CLOSE_THRESHOLD: 0.32, // 商业低于该效率开始倒闭
  CLOSE_CHANCE: 0.10,  // 每小时倒闭概率
  HAPPY_COMMUTE: 0.55, // 通勤压力对幸福度的影响
};

// --- 土地价值 / 幸福度 -----------------------------------------------------
export const LAND = {
  BASE: 30,
  ROAD_BONUS: 20,
  SERVICE_BONUS: 22,
  PARK_BONUS: 14,
  POLLUTION_PENALTY: 12,
  CONGESTION_PENALTY: 20,
  WATER_BONUS: 8,
  DIFFUSE_RATE: 0.72,
  MIN: 0, MAX: 100,
};

export const HAPPINESS = {
  BASE: 72,
  SERVICE_EFFECT: 26,
  TAX_EFFECT: 0.9,
  UNEMPLOY_EFFECT: 45,
  CONGESTION_EFFECT: 24,
  LAND_EFFECT: 0.28,
  MIN: 0, MAX: 100,
};

export const RENDER = {
  MAX_TREE_TILES: 900,
  TREE_CHANCE: 0.10,
  BUILDING_SETBACK: 0.13,
};

export const ZONE_IDS = { none: 0, res: 1, com: 2, ind: 3 };
export const ZONE_BY_ID = { 1: ZONES.res, 2: ZONES.com, 3: ZONES.ind };
export const TERRAIN = { grass: 0, water: 1 };

export const idx = (x, z) => z * MAP.SIZE + x;
export const xOf = (i) => i % MAP.SIZE;
export const zOf = (i) => Math.floor(i / MAP.SIZE);
export const inBounds = (x, z) => x >= 0 && z >= 0 && x < MAP.SIZE && z < MAP.SIZE;

export function hash2(x, z, seed = 0) {
  let h = (x * 374761393 + z * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
