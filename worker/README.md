# voice-lab token-minter

Выдаёт одноразовые токены ElevenLabs клиенту и проксирует LLM-запросы (текст).
Аудио через Worker не течёт — только короткий JSON с токеном.

## Деплой

Зон в аккаунте нет, поэтому адрес будет `*.workers.dev`.

```sh
cd worker
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put VIBE_TOKEN           # выдаётся кандидату на день собеса
wrangler deploy
```

Секреты в файлы не пишем никогда. `VIBE_TOKEN` после собеса перевыпускаем.

После деплоя записать выданный адрес (`https://voice-lab-token-minter.<subdomain>.workers.dev`)
в `VITE_WORKER_URL` сборки фронта — см. корневой `README`.

## Кто может дёргать

`ALLOWED_ORIGINS` в `wrangler.toml` — список origin'ов, которым Worker отвечает.
Всем остальным `403`. Меняется без правки кода: поправить `[vars]` и `wrangler deploy`.

Origin GitHub Pages — только хост (`https://<org>.github.io`), без пути проекта.

## Локальная разработка

`.dev.vars` (в `.gitignore`, не коммитить):

```
ELEVENLABS_API_KEY=...
OPENROUTER_API_KEY=...
VIBE_TOKEN=dev
```

`wrangler dev` → http://localhost:8787
