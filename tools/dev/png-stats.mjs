// 纯 Node 实现的 PNG 统计：不依赖图像库，用于在无图形界面时确认 AIUI 预览页
// 「真的画出了东西」，并给出粗粒度的亮度网格，便于判断版面结构。
import zlib from 'node:zlib';

/**
 * @param {Buffer} buffer PNG 文件内容
 * @returns {{width: number, height: number, lit: number, greenish: number, grid: string[], rows: Array<{y: number, lit: number}>}}
 */
export function analyzePng(buffer) {
  let pos = 8;
  /** @type {Buffer[]} */
  const idat = [];
  /** @type {any} */
  let ihdr = null;
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!ihdr) throw new Error('不是有效的 PNG：缺少 IHDR');
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('暂只支持 8-bit 非隔行 PNG');

  const channelCount = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channelCount) throw new Error(`暂不支持的 PNG colorType: ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channelCount;
  const pixels = Buffer.alloc(ihdr.height * stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channelCount ? current[x - channelCount] : 0;
      const up = previous[x];
      const upLeft = x >= channelCount ? previous[x - channelCount] : 0;
      const value = row[x];
      let output;
      switch (filter) {
        case 0:
          output = value;
          break;
        case 1:
          output = value + left;
          break;
        case 2:
          output = value + up;
          break;
        case 3:
          output = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          output = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`未知 PNG 过滤类型: ${filter}`);
      }
      current[x] = output & 0xff;
    }
    previous = current;
  }

  const colorAt = (x, y) => {
    const offset = y * stride + x * channelCount;
    if (channelCount >= 3) {
      return { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] };
    }
    return { r: pixels[offset], g: pixels[offset], b: pixels[offset] };
  };

  let lit = 0;
  let greenish = 0;
  const cellsX = 48;
  const cellsY = 24;
  const sums = new Array(cellsX * cellsY).fill(0);
  const counts = new Array(cellsX * cellsY).fill(0);
  const rowLit = new Array(ihdr.height).fill(0);

  for (let y = 0; y < ihdr.height; y += 1) {
    for (let x = 0; x < ihdr.width; x += 1) {
      const { r, g, b } = colorAt(x, y);
      const brightness = Math.max(r, g, b);
      if (brightness > 32) {
        lit += 1;
        rowLit[y] += 1;
      }
      if (g > 60 && g > r + 15 && g > b + 15) greenish += 1;
      const cell = Math.min(cellsY - 1, Math.floor((y / ihdr.height) * cellsY)) * cellsX + Math.min(cellsX - 1, Math.floor((x / ihdr.width) * cellsX));
      sums[cell] += brightness;
      counts[cell] += 1;
    }
  }

  const SHADES = ' .:-=+*#%@';
  const grid = [];
  for (let cy = 0; cy < cellsY; cy += 1) {
    let line = '';
    for (let cx = 0; cx < cellsX; cx += 1) {
      const index = cy * cellsX + cx;
      const average = sums[index] / (counts[index] || 1);
      const level = Math.min(SHADES.length - 1, Math.round((average / 255) * (SHADES.length - 1)));
      line += SHADES[level];
    }
    grid.push(line);
  }

  // 文本行带：把连续有内容的行合并成 band，便于判断版面纵向分布
  const bands = [];
  let currentBand = null;
  for (let y = 0; y < ihdr.height; y += 1) {
    if (rowLit[y] >= 2) {
      if (!currentBand) currentBand = { start: y, end: y, pixels: 0 };
      currentBand.end = y;
      currentBand.pixels += rowLit[y];
    } else if (currentBand && y - currentBand.end > 2) {
      bands.push(currentBand);
      currentBand = null;
    }
  }
  if (currentBand) bands.push(currentBand);

  return { width: ihdr.width, height: ihdr.height, lit, greenish, grid, bands };
}
