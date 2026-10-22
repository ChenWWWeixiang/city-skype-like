// ============================================================================
//  全局数值参数（模拟内核 + 前端共享）
//  单位：长度 m，时间 s（游戏内时间），金额 §（Simoleon）
// ============================================================================

// --- 高程 / 坡度 ------------------------------------------------------------
export const ELEV = {
  MAX_RAMP: 2.0,        // 相邻可连通路格的最大高差 (m)，超过则形成立交（不相连）
  BRIDGE_HEIGHT: 9.0,   // 高架桥标准高度 (m)
  RAMP_TILES: 6,        // 上下坡过渡格数
  PILLAR_RADIUS: 1.6,   // 桥墩半径 (m)
  GRADE_SPEED_PENALTY:  // 上坡减速系数 (每 10% 坡度)
    0.35,
  MAX_GRADE: 0.18,      // 最大坡度 18%
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
  SPEEDS: [0, 2, 6, 18, 60],
  // 交通时钟：交通秒 / 真实秒。
  // 关键：交通物理必须与经济时钟解耦。若沿用经济时钟(1x = 120 交通秒/秒)，
  // 一辆 11m/s 的车每秒会跑 1320 米 —— 屏幕上就是「瞬移 / 颜色在跳」，
  // 根本看不出车辆在运动，更谈不上观察排队与拥堵。
  // 1x = 4 交通秒/真实秒  ->  车速 44 m/s 观感，约 0.7 米/帧 @60fps，运动连续可读。
  TRAFFIC_SPEEDS: [0, 4, 8, 12, 16],
  SPEED_LABELS: ['暂停', '1x', '2x', '3x', '4x'],
  TRAFFIC_DT: 0.25,  // 交通物理子步长（游戏秒）：越小跟驰/排队越细腻
  MAX_SUBSTEPS: 2400,// 每真实秒最多子步数（防止卡顿雪崩）；高倍速时步长自动变粗
};

// --- 道路 ------------------------------------------------------------------
export const ROADS = {
  // lanes = 道路「总」车道数（双向合计）；每个方向 lanes/2 条。
  // width 必须 <= 建筑退线(16*0.13*2≈5.9m 的半宽×2≈11.8m)，否则建筑会压在马路上。
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
  police: { id: 1, name: '警察局', cost: 2500, upkeep: 220, radius: 320, capacity: 4000, color: 0x2f6fd0, power: 2, water: 1 },
  fire:   { id: 2, name: '消防站', cost: 2500, upkeep: 220, radius: 320, capacity: 4000, color: 0xd0453a, power: 2, water: 1 },
  clinic: { id: 3, name: '诊所',   cost: 3200, upkeep: 300, radius: 300, capacity: 3500, color: 0xe8e8e8, power: 2, water: 2 },
  school: { id: 4, name: '学校',   cost: 4000, upkeep: 380, radius: 420, capacity: 5200, color: 0xe0b93c, power: 3, water: 2 },
  park:   { id: 5, name: '公园',   cost: 400,  upkeep: 25,  radius: 170, color: 0x3fa14b, power: 0, water: 1 },
  power:  { id: 6, name: '发电厂', cost: 12000, upkeep: 900, radius: 900, color: 0xd98b2b, power: 0, water: 3 },
  water:  { id: 7, name: '水塔',   cost: 1200, upkeep: 90,  radius: 620, color: 0x3aa8d0, power: 1, water: 0 },
};
export const SERVICE_LIST = Object.values(SERVICES);
export const SERVICE_BY_ID = Object.fromEntries(SERVICE_LIST.map((s) => [s.id, s]));

// --- 经济 ------------------------------------------------------------------
export const ECON = {
  START_FUNDS: 120000,
  TAX_BASE_RES: 26,
  TAX_BASE_COM: 42,
  TAX_BASE_IND: 34,
  DEFAULT_TAX: { res: 9, com: 9, ind: 9 },
  MIN_TAX: 0, MAX_TAX: 20,
  ZONE_COST: { res: 25, com: 40, ind: 35 },
  BULLDOZE_REFUND: 0.15,
  BASE_UPKEEP: 320,
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
};

export const TRAFFIC = {
  MAX_VEHICLES: 1100,
  // 出行强度以「交通日」计：1 个交通日 = 24 个交通小时
  SEC_PER_HOUR: 150,            // 1 交通小时 = 150 交通秒（1x 下约 37 秒真实时间）
  DAY_SEC: 3600,                // 1 交通日 = 3600 交通秒（1x 下约 15 分钟真实时间）
  TRIPS_PER_RESIDENT_DAY: 0.9,   // 每位居民每个交通日的外出次数（上班 + 购物）
  TRIPS_PER_JOB_DAY: 0.20,   // 每个岗位每个交通日产生的货运/出行次数
  TRUCK_RATIO: 0.14,
  HOUR_WEIGHTS: [
    0.20, 0.10, 0.05, 0.05, 0.10, 0.45, 1.20, 2.60,
    3.00, 1.80, 1.10, 1.00, 1.00, 1.00, 1.05, 1.20,
    1.50, 1.90, 2.10, 1.70, 1.20, 0.80, 0.50, 0.30,
  ],
  MAX_PATH_NODES: 400,
  REPATH_INTERVAL: 45,
  NODE_CAPACITY: 3,
  ENTRY_GAP: 5,      // 进入下一路段所需的最小空隙（米）
  LANE_CHANGE_MIN_GAP: 18,
  BODY_GAP: 0.6,          // 车身硬约束：保险杠之间的最小间距（米），保证永不重叠
  BODY_PAD: 1.2,          // 发车时预留的额外余量
  SAMPLE_CONGESTION: 8,      // 交通统计采样间隔（游戏秒）
  MAX_PARKED_CARS: 320,      // 路边停放车辆上限（纯装饰，避免刷屏）
  ENTRANCE_TRIP_RATIO: 0.30,   // 有对外连接时，外部通勤车占出行总量的比例
  ENTRANCE_COST: 800,          // 建造一个高速出入口（对外连接）的费用
  VEHICLE_TYPES: {
    car:   { id: 0, len: 4.2, width: 1.9, speedFactor: 1.00, name: '轿车' },
    truck: { id: 1, len: 8.5, width: 2.4, speedFactor: 0.88, name: '货车' },
    bus:   { id: 2, len: 11.0, width: 2.5, speedFactor: 0.82, name: '公交' },
    bike:  { id: 3, len: 1.9, width: 0.8, speedFactor: 0.55, name: '自行车' },
  },
  BIKE_RATIO: 0.16,
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
  IMMIGRATION_MAX_PER_HOUR: 6.0,   // 上限
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
    ratePerBuildingHour: 0.00018,   // 每游戏小时每栋建筑的基础起火率
    industrialBonus: 3.0,           // 工业区起火概率倍率
    growPerHour: 0.16,               // 严重度增长（每小时）
    resolveHours: 1.6,               // 消防车到场后的处置时间
    damageLevels: 1,                 // 扑灭失败 -> 建筑等级 -1
    happinessHit: 6,
  },
  crime: {
    id: 'crime', name: '犯罪', icon: '🚓', color: 0xffd23f, service: 'police',
    ratePerBuildingHour: 0.00120,
    commercialBonus: 2.2, nightBonus: 2.0,
    growPerHour: 0.22,
    resolveHours: 1.2,
    fine: 260,                       // 未被制止的损失
    happinessHit: 2.5,
  },
  disease: {
    id: 'disease', name: '疾病', icon: '🚑', color: 0x63d97a, service: 'ambulance',
    ratePerBuildingHour: 0.00012,
    densityBonus: 1.0,               // 住宅密度越高越容易爆发
    growPerHour: 0.12,
    resolveHours: 2.4,
    fatality: 0.30,                  // 未及时救治的死亡率
    happinessHit: 3.0,
  },
  accident: {
    id: 'accident', name: '事故', icon: '⚠', color: 0xff8c1a, service: 'police',
    ratePerVehicleHour: 0.00080,     // 按在途车辆数产生
    congestionBonus: 2.6,            // 越堵越容易出事故
    growPerHour: 0.0,
    resolveHours: 0.7,
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
  POLLUTION_PENALTY: 26,
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
