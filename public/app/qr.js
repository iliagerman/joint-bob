// A QR code encoder (ISO/IEC 18004) for showing short addresses to a phone camera.
// Byte mode with UTF-8 text, error correction level M (about 15% of the code can be lost),
// the smallest version that fits, and the mask with the lowest penalty score.

// Error correction codewords per block, and number of blocks, for level M by version (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
// Level M's two format bits are 00.
const FORMAT_LEVEL = 0;

/** The modules of a QR code for the text, as rows of booleans (true is dark), without the quiet zone. */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = smallestVersion(bytes.length);
  const data = dataCodewords(bytes, version);
  const code = new Grid(version);
  code.drawFunctionPatterns();
  code.drawCodewords(withErrorCorrection(data, version));
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    code.applyMask(mask);
    code.drawFormatBits(mask);
    const score = code.penalty();
    if (score < lowest) { best = mask; lowest = score; }
    code.applyMask(mask);
  }
  code.applyMask(best);
  code.drawFormatBits(best);
  return code.modules;
}

/** The text's QR code as an SVG image with a four-module light border, dark on light whatever the theme. */
export function qrSvg(text, label) {
  const modules = qrMatrix(text);
  const size = modules.length + 8;
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const background = document.createElementNS(svgNs, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#fff");
  const path = document.createElementNS(svgNs, "path");
  let d = "";
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(background, path);
  return svg;
}

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCapacity(version) {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

const countBits = (version) => (version < 10 ? 8 : 16);

function smallestVersion(length) {
  for (let version = 1; version <= 40; version += 1) {
    if (4 + countBits(version) + length * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError("Text is too long for a QR code");
}

function dataCodewords(bytes, version) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const result = [];
  for (let i = 0; i < bits.length; i += 8) result.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  return result;
}

/** Splits the data into blocks, appends each block's Reed–Solomon codewords and interleaves them. */
function withErrorCorrection(data, version) {
  const blockCount = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const total = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i += 1) {
    const block = data.slice(offset, offset + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    offset += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]); });
  }
  return result;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

const bit = (value, index) => ((value >>> index) & 1) !== 0;

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((x, i) => positions.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    // Reserve the format areas now; the real bits are drawn once the mask is chosen.
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  drawFormatBits(mask) {
    const data = (FORMAT_LEVEL << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const { size } = this;
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit(bits, i));
      this.set(b, a, bit(bits, i));
    }
  }

  /** Places the codewords in the two-column zigzag from the bottom right, skipping the timing column. */
  drawCodewords(codewords) {
    const { size } = this;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < size; step += 1) {
        const y = upward ? size - 1 - step : step;
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          if (this.reserved[y][x] || index >= codewords.length * 8) continue;
          this.modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
          index += 1;
        }
      }
    }
  }

  /** Masking twice with the same pattern undoes it. */
  applyMask(mask) {
    const flip = MASKS[mask];
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.reserved[y][x] && flip(x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty() {
    const { size, modules } = this;
    const column = (x) => modules.map((row) => row[x]);
    let score = 0;
    for (let i = 0; i < size; i += 1) score += this.linePenalty(modules[i]) + this.linePenalty(column(i));
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (modules[y][x]) dark += 1;
        if (x < size - 1 && y < size - 1) {
          const color = modules[y][x];
          if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  /** Runs of five or more same-colored modules, and 1:1:3:1:1 finder-like patterns with light space beside them. */
  linePenalty(line) {
    const { size } = this;
    let score = 0;
    let color = false;
    let length = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (run) => {
      if (history[0] === 0) run += size;
      history.pop();
      history.unshift(run);
    };
    const finderLike = () => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    for (const module of line) {
      if (module === color) {
        length += 1;
        if (length === 5) score += 3;
        else if (length > 5) score += 1;
      } else {
        addHistory(length);
        if (!color) score += finderLike() * 40;
        color = module;
        length = 1;
      }
    }
    if (color) { addHistory(length); length = 0; }
    addHistory(length + size);
    return score + finderLike() * 40;
  }
}
