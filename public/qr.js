(() => {
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsEncode(data, ecLen) {
    const gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= mul(gen[j], EXP[i]);
        next[j + 1] ^= gen[j];
      }
      gen.splice(0, gen.length, ...next);
    }
    const out = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = out[i];
      if (!coef) continue;
      for (let j = 0; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
    return out.slice(data.length);
  }

  const VERS = [];
  function add(v, size, data, ec, groups, align) {
    VERS[v] = { v, size, data, ec, groups, align };
  }
  add(1, 21, 16, 10, [[1, 16]], []);
  add(2, 25, 28, 16, [[1, 28]], [18]);
  add(3, 29, 44, 26, [[1, 44]], [22]);
  add(4, 33, 64, 18, [[2, 32]], [26]);
  add(5, 37, 86, 24, [[2, 43]], [30]);
  add(6, 41, 108, 16, [[4, 27]], [34]);
  add(7, 45, 124, 18, [[4, 31]], [22, 38]);
  add(8, 49, 154, 22, [[2, 38], [2, 39]], [24, 42]);
  add(9, 53, 182, 22, [[3, 36], [2, 37]], [26, 46]);
  add(10, 57, 216, 26, [[4, 43], [1, 44]], [28, 50]);

  function bitsToBytes(bits) {
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let n = 0;
      for (let j = 0; j < 8; j++) n = (n << 1) | (bits[i + j] || 0);
      bytes.push(n);
    }
    return bytes;
  }

  function encodeData(text, ver) {
    const info = VERS[ver];
    const bytes = Array.from(new TextEncoder().encode(text));
    const bits = [];
    const push = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const total = info.data * 8;
    const remain = total - bits.length;
    if (remain < 0) return null;
    push(0, Math.min(4, remain));
    while (bits.length % 8) bits.push(0);
    const data = bitsToBytes(bits);
    const pad = [0xec, 0x11];
    let p = 0;
    while (data.length < info.data) data.push(pad[p++ % 2]);
    const blocks = [];
    let offset = 0;
    for (const [count, len] of info.groups) {
      for (let i = 0; i < count; i++) {
        const chunk = data.slice(offset, offset + len);
        offset += len;
        blocks.push({ data: chunk, ec: rsEncode(chunk, info.ec) });
      }
    }
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.data.length));
    const maxE = info.ec;
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < maxE; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  function reserved(size, align) {
    const r = Array.from({ length: size }, () => new Uint8Array(size));
    const mark = (x, y, w, h) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (y + j >= 0 && x + i >= 0 && y + j < size && x + i < size) r[y + j][x + i] = 1;
      }
    };
    const finder = (x, y) => mark(x - 1, y - 1, 9, 9);
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);
    mark(8, size - 8, 1, 1);
    for (let i = 0; i < size; i++) {
      r[6][i] = 1;
      r[i][6] = 1;
    }
    mark(0, 8, 9, 1);
    mark(8, 0, 1, 9);
    mark(size - 8, 8, 8, 1);
    mark(8, size - 8, 1, 8);
    const pos = [6, ...align];
    for (const a of pos) for (const b of pos) {
      if ((a === 6 && b === 6) || (a === 6 && b === pos[pos.length - 1]) || (a === pos[pos.length - 1] && b === 6)) continue;
      mark(a - 2, b - 2, 5, 5);
    }
    return r;
  }

  function placeFinders(mod, size) {
    const draw = (x, y) => {
      for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) {
        const edge = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        mod[y + j][x + i] = edge || core ? 1 : 0;
      }
    };
    draw(0, 0);
    draw(size - 7, 0);
    draw(0, size - 7);
  }

  function placeAlign(mod, align) {
    for (const y of align) for (const x of [6, ...align]) {
      if ((x === 6 && y === 6) || (x === 6 && y === align[align.length - 1] && align.length) || (y === 6 && x === align[align.length - 1])) continue;
      if (x === 6 && y === 6) continue;
      if ((x < 8 && y < 8) || (x > mod.length - 9 && y < 8) || (x < 8 && y > mod.length - 9)) continue;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const a = Math.max(Math.abs(i), Math.abs(j));
        mod[y + j][x + i] = a !== 1 ? 1 : 0;
      }
    }
  }

  function timing(mod, size) {
    for (let i = 0; i < size; i++) {
      mod[6][i] = i % 2 === 0 ? 1 : 0;
      mod[i][6] = i % 2 === 0 ? 1 : 0;
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let d = data << 10;
    const poly = 0b10100110111;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= poly << (i - 10);
    const bits = (data << 10 | d) ^ 0b101010000010010;
    return bits;
  }

  function placeFormat(mod, size, mask) {
    const bits = formatBits(mask);
    const set = (x, y, b) => {
      mod[y][x] = b;
    };
    for (let i = 0; i < 15; i++) {
      const b = (bits >> i) & 1;
      if (i < 6) set(i, 8, b);
      else if (i < 8) set(i + 1, 8, b);
      else set(size - 15 + i, 8, b);
      if (i < 8) set(8, size - 1 - i, b);
      else if (i < 9) set(8, 15 - i, b);
      else set(8, 14 - i, b);
    }
    mod[size - 8][8] = 1;
  }

  function placeData(mod, res, data) {
    const size = mod.length;
    const bits = [];
    for (const byte of data) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    let k = 0;
    let dir = -1;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let n = 0; n < size; n++) {
        const y = dir < 0 ? size - 1 - n : n;
        for (const x of [col, col - 1]) {
          if (res[y][x]) continue;
          mod[y][x] = bits[k++] || 0;
        }
      }
      dir *= -1;
    }
  }

  function applyMask(mod, res, mask) {
    const size = mod.length;
    const fn = MASKS[mask];
    const out = mod.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!res[y][x] && fn(x, y)) out[y][x] ^= 1;
    }
    return out;
  }

  function score(mod) {
    const size = mod.length;
    let s = 0;
    const run = (get) => {
      for (let a = 0; a < size; a++) {
        let last = get(a, 0);
        let n = 1;
        for (let b = 1; b < size; b++) {
          const v = get(a, b);
          if (v === last) n++;
          else {
            if (n >= 5) s += 3 + (n - 5);
            last = v;
            n = 1;
          }
        }
        if (n >= 5) s += 3 + (n - 5);
      }
    };
    run((r, c) => mod[r][c]);
    run((r, c) => mod[c][r]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const v = mod[y][x];
      if (v === mod[y][x + 1] && v === mod[y + 1][x] && v === mod[y + 1][x + 1]) s += 3;
    }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += mod[y][x];
    s += Math.abs(Math.floor((dark * 100) / (size * size) / 5) - 10) * 10;
    return s;
  }

  function build(text) {
    const raw = new TextEncoder().encode(text);
    let ver = 1;
    while (ver <= 10) {
      const cap = VERS[ver].data - 2;
      if (raw.length <= cap) break;
      ver++;
    }
    if (ver > 10) return null;
    const info = VERS[ver];
    const data = encodeData(text, ver);
    if (!data) return null;
    const size = info.size;
    const res = reserved(size, info.align);
    const base = Array.from({ length: size }, () => new Uint8Array(size));
    placeFinders(base, size);
    timing(base, size);
    if (info.align.length) placeAlign(base, info.align);
    placeData(base, res, data);
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const masked = applyMask(base, res, mask);
      placeFinders(masked, size);
      timing(masked, size);
      if (info.align.length) placeAlign(masked, info.align);
      placeFormat(masked, size, mask);
      const sc = score(masked);
      if (sc < bestScore) {
        bestScore = sc;
        best = masked;
      }
    }
    return best;
  }

  function svg(text, px = 200) {
    const mod = build(String(text || ""));
    if (!mod) return "";
    const n = mod.length;
    const quiet = 4;
    const dim = n + quiet * 2;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (mod[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="#fff"/><path fill="#111" d="${d}"/></svg>`;
  }

  function draw(el, text, px) {
    if (!el) return false;
    try {
      const mark = svg(text, px);
      if (!mark) return false;
      el.innerHTML = mark;
      return true;
    } catch {
      return false;
    }
  }

  window.QR = { svg, draw };
})();
