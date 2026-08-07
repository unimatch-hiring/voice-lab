#!/usr/bin/env python3
"""Собирает спрайты рта из сгенерированных кадров в public/face/.

Два неочевидных требования, каждое стоило заметного времени отладки:

1. Вне зоны рта все кадры обязаны быть ПОБИТОВО одинаковыми. Генератор
   перерисовывает картинку целиком, поэтому мех, костюм и фон гуляют — при
   смене визимы мерцает весь персонаж. Лечится композитом: один фон + вклеенная
   область рта под размытой маской.

2. Палитру считаем ОДИН раз на все кадры. Независимая адaptive-палитра на кадр
   расходится на единицы значений, и «идентичный» фон снова начинает дрожать.

Проверяет результат тест src/scene/sprites.test.ts.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vl-face/racoon"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "face")

WORK = 768          # разрешение композита
FINAL = 384         # что кладём в public: окно рендерится в ~400px
COLORS = 220

# Зона рта в долях кадра — подобрана по сетке на эталоне.
X0, X1, Y0, Y1 = 0.34, 0.64, 0.455, 0.615

VISEMES = ["MBP", "AI", "E", "O", "U", "FV", "L", "WQ"]


def mouth_mask(size: int) -> Image.Image:
    box = (int(X0 * size), int(Y0 * size), int(X1 * size), int(Y1 * size))
    blur = size * 0.022
    pad = int(blur * 1.5)
    mask = Image.new("L", (size, size), 0)
    # Эллипс уменьшен на радиус размытия, иначе маска расползается за box и
    # тянет за собой фон, который обязан остаться неизменным.
    ImageDraw.Draw(mask).ellipse(
        (box[0] + pad, box[1] + pad, box[2] - pad, box[3] - pad), fill=255
    )
    mask = mask.filter(ImageFilter.GaussianBlur(blur))

    hard = Image.new("L", (size, size), 0)
    hard.paste(255, box)
    return Image.composite(mask, Image.new("L", (size, size), 0), hard)


def main() -> int:
    base_path = os.path.join(SRC, "base.png")
    if not os.path.exists(base_path):
        print(f"нет эталона: {base_path}", file=sys.stderr)
        return 1

    base = Image.open(base_path).convert("RGB").resize((WORK, WORK), Image.LANCZOS)
    mask = mouth_mask(WORK)

    frames = {"rest": base.copy()}
    for name in VISEMES:
        # Три фазы раскрытия на визиму: q (четверть) -> h (половина) -> полная.
        # С двумя точками шаг амплитуды между соседними кадрами слишком велик и
        # кроссфейд читается как рывок.
        for suffix in ("", "h", "q"):
            path = os.path.join(SRC, f"{name}{suffix}.png")
            if not os.path.exists(path):
                print(f"пропуск (нет кадра): {name}{suffix}")
                continue
            src = Image.open(path).convert("RGB").resize((WORK, WORK), Image.LANCZOS)
            frames[f"{name}{suffix}"] = Image.composite(src, base, mask)

    # Фазы сортируем по ФАКТИЧЕСКОМУ раскрытию, а не по имени файла: генератор
    # не всегда попадает в заказанную амплитуду (у смычных /ф/, /м/ «четверть» и
    # «половина» выходят почти одинаковыми и иногда меняются местами). Если
    # оставить порядок по имени, рот на такой визиме сначала откроется шире, а
    # потом захлопнется — это видимый рывок.
    def openness(img: Image.Image) -> float:
        ref = frames["rest"].convert("L").crop(
            (int(0.36 * WORK), int(0.46 * WORK), int(0.64 * WORK), int(0.62 * WORK))
        )
        cur = img.convert("L").crop(
            (int(0.36 * WORK), int(0.46 * WORK), int(0.64 * WORK), int(0.62 * WORK))
        )
        dark = sum(
            1 for a, b in zip(ref.getdata(), cur.getdata()) if a - b > 25
        )
        return dark / (ref.width * ref.height)

    for name in VISEMES:
        phases = [f"{name}q", f"{name}h", name]
        if not all(p in frames for p in phases):
            continue
        by_open = sorted(phases, key=lambda p: openness(frames[p]))
        if by_open != phases:
            print(f"  {name}: фазы переставлены по факту -> {' < '.join(by_open)}")
            reordered = {slot: frames[src] for slot, src in zip(phases, by_open)}
            frames.update(reordered)

    order = list(frames)
    small = {n: frames[n].resize((FINAL, FINAL), Image.LANCZOS) for n in order}

    # Вне зоны рта берём пиксели ИЗ rest, а не свои. Композит уже делал фон
    # одинаковым, но квантование в палитру назначало соседним оттенкам разные
    # индексы, и фон снова расходился на десятки уровней — вся морда дрожала при
    # смене визимы. Здесь расхождение невозможно по построению.
    keep = Image.new("L", (FINAL, FINAL), 0)
    keep.paste(
        255,
        (
            int(X0 * FINAL),
            int(Y0 * FINAL),
            int(X1 * FINAL),
            int(Y1 * FINAL),
        ),
    )
    for name in order:
        if name != "rest":
            small[name] = Image.composite(small[name], small["rest"], keep)

    # Общая палитра на все кадры: одна и та же таблица цветов у всех файлов.
    sheet = Image.new("RGB", (FINAL, FINAL * len(order)))
    for i, name in enumerate(order):
        sheet.paste(small[name], (0, i * FINAL))
    palette = sheet.quantize(colors=COLORS, method=Image.MEDIANCUT)

    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name in order:
        out = small[name].quantize(palette=palette, dither=Image.NONE)
        path = os.path.join(OUT, f"{name}.png")
        out.save(path, optimize=True)
        total += os.path.getsize(path)
        print(f"  {name:6} {os.path.getsize(path) / 1024:6.1f} КБ")

    print(f"итого: {total / 1024 / 1024:.2f} МБ, кадров: {len(order)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
