# voice-lab — project context for AI coding agents

Интерактивный explainer конвейера голосового агента. Говоришь фразу — видишь, как
она течёт по стадиям (`capture → vad → stt → llm → tts → playback`) с реальными
таймингами, и слышишь ответ голосом. Клиентский SPA, своего бэкенда нет.

## Stack & commands

- Vite + React 19 + TypeScript (strict).
- `npm ci` — install. `npm run dev` → http://localhost:5173. `npm run build` → `dist/`.
- `npm test` — vitest. Type-check входит в build (`tsc -b`).

## Layout

- `src/lib/pipeline/*` — стадии конвейера, каждая с узким интерфейсом.
- `src/lib/pipeline/orchestrator.ts` — прогон turn'а, сбор метрик, эмит событий.
- `src/lib/transport.ts` — единственное место, знающее про token-minter.
- `src/lib/visemes.ts` — символ → визима поверх `alignment` от TTS.
- `src/scene/*` — сцена. Читает только поток событий.
- `src/lib/fixtures/` — записанные turn'ы для оффлайн-режима.
- `worker/` — Cloudflare Worker, выдаёт одноразовые токены ElevenLabs.

## Правила, которые нельзя нарушать

**1. Никогда `setState` на высокочастотные данные.** Аудио-чанки, токены LLM,
кадры анимации, прогресс стадии — только в `useRef`. Один `requestAnimationFrame`
читает refs и рисует. Ноль рендеров React на кадр.

Что ломается, если нарушить: поток событий на 100 Hz превращается в 100 рендеров/с,
UI начинает лагать, и сцена перестаёт показывать честные тайминги — то есть продукт
начинает врать о том, для чего он вообще существует. На это есть тест
(`src/scene/render-count.test.ts`), он упадёт.

Конкретно нельзя: `setState` на аудио-чанк или токен; анимировать 200 SVG-нод как
React-детей; живой мс-счётчик как React-текст без троттлинга до ~10 Hz.

**2. Границы модулей.** `src/scene/*` не импортирует `src/lib/pipeline/*` (только
`types.ts` и `events.ts`). Пайплайн не знает, что его рисуют. Любую половину можно
менять, не ломая другую.

## Conventions

- Ноль новых runtime-зависимостей. Только react + react-dom.
- Русский STT — всегда `language_code=rus`. Дефолтный `eng` на русской речи даёт мусор.
- Оффлайн-режим на фикстурах должен работать всегда — он прогоняется в CI.
