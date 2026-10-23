# Проверка Figma Linux NG

## Что уже проверено автоматически (23.10.2026, на этой машине)

| Проверка | Результат |
|---|---|
| Запуск Electron 45 (dev-сборка, `linux-unpacked`, AppImage) | ✅ |
| Vulkan / аппаратный WebGPU-адаптер NVIDIA / треугольник с чтением пикселей | ✅ (`npm run diag:webgpu`) |
| Sandbox: renderer'ы Figma (seccomp + свой PID namespace), GPU-процесс (seccomp; `chrome://gpu`: Sandboxed true) | ✅ |
| Полный редактор Figma (публичный файл, без входа) | ✅ открывается и рисуется |
| Использование WebGPU самой Figma | ⚠️ по умолчанию WebGL (решение Figma), с `?force-webgpu=1` — WebGPU ✅ — см. [WEBGPU.md](WEBGPU.md) |
| Внешние ссылки → системный браузер; `javascript:`/`file:` блокируются | ✅ |
| Буфер обмена: `navigator.clipboard` (текст, PNG) и мост desktop API (PNG, SVG, HTML Figma) | ✅ |
| Чужой origin не может читать/писать буфер, читать файлы через `getFontFile` | ✅ |
| Drop файла во вкладку не уводит её на `file://` | ✅ |
| Несколько окон, закрытие окна освобождает его процессы | ✅ |
| Сохранение и ленивое восстановление вкладок | ✅ |
| Окно настроек, окно диагностики, отчёт `--diag-report` | ✅ |
| Превью Theme Creator (webview в sandbox, свой preload) | ✅ |

Позже, с аккаунтом: вход и desktop-режим Figma, редактирование своего файла (размер, выравнивание,
смена шрифта), локальные шрифты без Font Agent (DIN Pro и др.; совпадение с выдачей агента
2615/2615 файлов), WebGPU в редакторе (`[GPU] graphicsAPI:"WebGPU"`) — ✅.

**Не проверено автоматически:** экспорт через диалог сохранения (`writeFiles`); локальные
плагины; горячие клавиши на реальной клавиатуре; голосовые звонки; системный буфер обмена между
NG и другими приложениями (в тестах проверялся программно).

## Ручная проверка после входа

1. Запустите клиент с счётчиками WebGPU:

   ```bash
   figma-linux-ng --webgpu-diag
   ```

2. Войдите: «Log in with browser» откроет **встроенное** окно входа. Так `figma://`-ссылка не
   уйдёт старому клиенту.
3. Откройте рабочий файл и сделайте несколько зумов/панорамирований.
4. *Help → Diagnostics (RAM, CPU, GPU, WebGPU)…* (`Ctrl+Shift+Alt+D`):
   - «WebGPU self-test» должен показать «Hardware WebGPU works» и `nvidia/lovelace`;
   - в таблице вкладок колонка **Renderer verdict** показывает, чем рисует Figma.
     `WebGPU (submits + canvas frames, no WebGL draws)` означает, что Figma использует WebGPU.
     `WebGL (Figma only probed WebGPU…)` — Figma выбрала WebGL;
   - там же время загрузки (`Figma ready` — по сигналу самой Figma), ошибки сети, память и CPU
     процессов, VRAM по nvidia-smi.
5. Дополнительное подтверждение от самой Figma: *Help → Toggle Developer Tools* (`Ctrl+Alt+I`)
   → Console → фильтр `[GPU]`. Там будет `graphicsAPI:"WebGPU"` или `graphicsAPI:"WebGL 2"`.
6. *Help → Save Diagnostics Report* — JSON в `~/.config/figma-linux-ng/diagnostics/`.

Отчёт без интерфейса: клиент сам завершится через 90 с.

```bash
figma-linux-ng --webgpu-diag --diag-report=$HOME/flng-report.json --diag-delay=90 --diag-exit
```

Трейс GPU (Perfetto, открывается в <https://ui.perfetto.dev>): *Help → Record GPU Trace (10 s)*.

## Чек-лист функций

- [ ] Вход, повторный запуск без повторного входа (сессия сохраняется в `~/.config/figma-linux-ng`)
- [ ] Открытие/редактирование файла, несколько вкладок, перетаскивание вкладок
- [ ] Горячие клавиши Figma (`Ctrl+C/V/Z`, `Shift+1`, `Ctrl+/` …), `F11` — полноэкранный режим
- [ ] Копирование между NG и другими приложениями (текст, PNG, «Copy as SVG»)
- [ ] Drag & Drop картинки/файла на холст
- [ ] Экспорт (кнопка Export) — диалог сохранения, файл записан
- [ ] Ссылки из комментариев/документации открываются в системном браузере
- [ ] Масштаб интерфейса (Settings → Scale UI / Scale Tabs)
- [ ] Локальные плагины: Plugins → Development → Import plugin from manifest…
- [ ] Второе окно (`Ctrl+N`), закрытие окна
- [ ] Локальные шрифты: видны и применяются в Figma без Font Agent (встроенный сканер)

## Сравнение со старым клиентом (если он установлен)

```bash
python3 scripts/diag/cpu-report.py /snap/figma-linux/197/figma-linux 10
```

```bash
python3 scripts/diag/cpu-report.py "/opt/Figma Linux NG/figma-linux-ng" 10
```

Память по процессам (PSS, seccomp, namespace):

```bash
python3 scripts/diag/proc-report.py $(pgrep -o -f /snap/figma-linux/197/figma-linux)
```

```bash
python3 scripts/diag/proc-report.py $(pgrep -o -f "/opt/Figma Linux NG/figma-linux-ng")
```

## Инструменты для разработчика

- `npm run diag:webgpu` — матрица флагов Chromium → адаптер, программный/аппаратный, sandbox.
- Запуск с `--remote-debugging-port=9333`, затем `node scripts/diag/cdp.mjs list|eval|shot|console`.
- `node scripts/diag/interact.mjs <часть URL>` — счётчики WebGPU/WebGL до и после зума
  (нужен `--webgpu-diag`).
- `node scripts/diag/pan-bench.mjs <часть URL> 6` — FPS при непрерывном панорамировании.
- `--diag-no-desktop-bridge` — **только для тестов**: вкладки работают как обычный браузер.
  Так можно смотреть публичные файлы без входа: десктоп-режим Figma без аккаунта пишет
  `Not signed in, aborting init!`.
