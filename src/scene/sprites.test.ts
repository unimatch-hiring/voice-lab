import { expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { MOUTH_SPRITES, HALF_SPRITES, QUARTER_SPRITES } from "./Mouth";

/**
 * Тесты на сами спрайты, а не на числа, которые компонент выставляет в opacity.
 *
 * Предыдущая версия проверяла только амплитуду и удержание формы — и была
 * полностью зелёной на анимации, которая читалась как мыло: промежуточные кадры
 * оказались альфа-смесью «закрыто»+«открыто», то есть двойной экспозицией с
 * призрачными зубами. Числа были гладкие, картинка — сломанная. Здесь мы меряем
 * пиксели, поэтому именно тот дефект не проходит.
 */

const FACE_DIR = `${process.cwd()}/public/`;

interface Bitmap {
  width: number;
  height: number;
  /** Яркость по пикселям, построчно. */
  luma: Float64Array;
}

/**
 * Минимальный декодер PNG: только то, что нужно тесту. Готовый пакет тянуть не
 * стали — правило репозитория «ноль новых зависимостей», а спрайты пишет наш же
 * генератор в предсказуемом виде (8 бит, палитра или RGB, один IDAT-поток).
 */
function decodePng(buf: Buffer): Bitmap {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  if (depth !== 8) throw new Error(`ожидали 8 бит на канал, получили ${depth}`);

  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IDAT") idat.push(body);
    else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }

  const channels = colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const luma = new Float64Array(width * height);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    raw.copy(line, 0, src, src + stride);
    src += stride;
    // Разворачиваем построчные фильтры PNG (спека 9.2).
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      let r: number;
      let g: number;
      let bl: number;
      if (colorType === 3) {
        const idx = line[x] * 3;
        r = palette![idx];
        g = palette![idx + 1];
        bl = palette![idx + 2];
      } else {
        const p = x * channels;
        r = line[p];
        g = line[p + 1];
        bl = line[p + 2];
      }
      luma[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * bl;
    }
  }
  return { width, height, luma };
}

function load(rel: string): Bitmap {
  const path = FACE_DIR + rel;
  if (!existsSync(path)) throw new Error(`нет спрайта: ${rel}`);
  return decodePng(readFileSync(path));
}

/** Яркость в зоне рта (доли кадра — та же рамка, что у генератора). */
function mouthLuma(bmp: Bitmap): Float64Array {
  const x0 = Math.round(0.36 * bmp.width);
  const x1 = Math.round(0.64 * bmp.width);
  const y0 = Math.round(0.46 * bmp.height);
  const y1 = Math.round(0.62 * bmp.height);
  const out = new Float64Array((x1 - x0) * (y1 - y0));
  let i = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[i++] = bmp.luma[y * bmp.width + x];
  }
  return out;
}

/** Резкость: средний перепад яркости между соседями по строке. */
function sharpness(luma: Float64Array, width: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < luma.length; i++) {
    if (i % width === 0) continue;
    sum += Math.abs(luma[i] - luma[i - 1]);
    n++;
  }
  return sum / n;
}

const MOUTH_W = () => {
  const bmp = load(MOUTH_SPRITES.rest);
  return Math.round(0.64 * bmp.width) - Math.round(0.36 * bmp.width);
};

test("каждый кадр рта существует на диске", () => {
  for (const rel of [
    ...Object.values(MOUTH_SPRITES),
    ...Object.values(HALF_SPRITES),
    ...Object.values(QUARTER_SPRITES),
  ]) {
    expect(() => load(rel), rel).not.toThrow();
  }
});

test("вне зоны рта кадры идентичны — меняется только рот", () => {
  // Иначе при смене визимы мерцает весь персонаж: мех, костюм, фон.
  const rest = load(MOUTH_SPRITES.rest);
  // Границы усекаем, как сборщик спрайтов (Python int()), а не округляем: иначе
  // в проверку фона попадает однопиксельная рамка самой зоны рта.
  const x0 = Math.trunc(0.34 * rest.width);
  const x1 = Math.trunc(0.64 * rest.width);
  const y0 = Math.trunc(0.455 * rest.height);
  const y1 = Math.trunc(0.615 * rest.height);

  for (const [name, rel] of Object.entries(MOUTH_SPRITES)) {
    if (name === "rest") continue;
    const bmp = load(rel);
    let worst = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        const i = y * bmp.width + x;
        worst = Math.max(worst, Math.abs(bmp.luma[i] - rest.luma[i]));
      }
    }
    expect(worst, `${name}: фон отличается от rest`).toBeLessThanOrEqual(8);
  }
});

test("промежуточный кадр — настоящая поза, а не смесь закрытого с открытым", () => {
  // Тот самый дефект: half = (rest + full) / 2 давал полупрозрачное наложение
  // двух ртов. Такая смесь почти точно равна среднему, поэтому ловим по
  // расстоянию до него: настоящая поза так близко к среднему не лежит.
  const width = MOUTH_W();
  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const rest = mouthLuma(load(MOUTH_SPRITES.rest));
    const full = mouthLuma(load(MOUTH_SPRITES[key]));
    const half = mouthLuma(load(HALF_SPRITES[key]));

    let dist = 0;
    for (let i = 0; i < half.length; i++) {
      dist += Math.abs(half[i] - (rest[i] + full[i]) / 2);
    }
    dist /= half.length;
    expect(dist, `${key}h слишком похож на альфа-смесь rest+full`).toBeGreaterThan(4);

    // И он не должен быть мягче обоих: размытие — прямой признак наложения.
    const sHalf = sharpness(half, width);
    const sRest = sharpness(rest, width);
    expect(sHalf, `${key}h размытее закрытого рта`).toBeGreaterThan(sRest * 0.85);
  }
});

test("промежуточный кадр не распахнут сильнее самой формы", () => {
  // Полость рта темнее морды, поэтому «сколько потемнело против rest» —
  // прямая мера того, насколько открыт рот.
  //
  // Строгое `half < full` требовать нельзя: у смычных и малоамплитудных визим
  // (MBP, WQ, FV, U, E) полпути почти совпадает с самой формой, и генератор
  // законно отдаёт их равными. Ловим только настоящую поломку — когда
  // промежуточный кадр открыт ЗАМЕТНО шире конечного, то есть рот сначала
  // распахивается, а потом захлопывается на той же визиме.
  const rest = mouthLuma(load(MOUTH_SPRITES.rest));
  const openness = (luma: Float64Array) => {
    let n = 0;
    for (let i = 0; i < luma.length; i++) if (rest[i] - luma[i] > 25) n++;
    return n / luma.length;
  };

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const half = openness(mouthLuma(load(HALF_SPRITES[key])));
    const full = openness(mouthLuma(load(MOUTH_SPRITES[key])));
    expect(half, `${key}h должен быть приоткрыт`).toBeGreaterThan(0.01);
    expect(half, `${key}h распахнут шире, чем ${key}`).toBeLessThan(full * 1.15);
  }
});

test("фазы одной визимы раскрываются строго по возрастанию", () => {
  // Генератор не всегда попадает в заказанную амплитуду: у смычных /м/, /ф/
  // «четверть» выходит шире «половины». Сборщик спрайтов переставляет фазы по
  // факту, и этот порядок обязан держаться — иначе рот на такой визиме сначала
  // откроется шире, а потом захлопнется посреди звука.
  const rest = mouthLuma(load(MOUTH_SPRITES.rest));
  const openness = (luma: Float64Array) => {
    let n = 0;
    for (let i = 0; i < luma.length; i++) if (rest[i] - luma[i] > 25) n++;
    return n / luma.length;
  };

  for (const key of Object.keys(HALF_SPRITES) as Array<keyof typeof HALF_SPRITES>) {
    const q = openness(mouthLuma(load(QUARTER_SPRITES[key])));
    const h = openness(mouthLuma(load(HALF_SPRITES[key])));
    const full = openness(mouthLuma(load(MOUTH_SPRITES[key])));
    expect(q, `${key}: четверть шире половины (${q.toFixed(4)} > ${h.toFixed(4)})`)
      .toBeLessThanOrEqual(h);
    expect(h, `${key}: половина шире полной формы (${h.toFixed(4)} > ${full.toFixed(4)})`)
      .toBeLessThanOrEqual(full);
  }
});
