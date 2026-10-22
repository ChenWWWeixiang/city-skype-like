// 与服务端保持一致的常量（通过 /api/config 校验）
export const MAP = { SIZE: 48, TILE: 16 };
export const WORLD = MAP.SIZE * MAP.TILE;      // 768
export const HALF = WORLD / 2;

export const worldX = (x) => (x + 0.5) * MAP.TILE - HALF;
export const worldZ = (z) => (z + 0.5) * MAP.TILE - HALF;
export const tileX = (wx) => Math.floor((wx + HALF) / MAP.TILE);
export const tileZ = (wz) => Math.floor((wz + HALF) / MAP.TILE);
export const tileIndex = (x, z) => z * MAP.SIZE + x;

export function hash2(x, z, seed = 0) {
  let h = (x * 374761393 + z * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
