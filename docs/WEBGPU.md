# WebGPU в Figma Linux NG

Проверено 23.10.2026: Ubuntu 24.04, X11, NVIDIA GeForce RTX 4060, драйвер 580.178.04,
Electron 45.0.0 (Chromium 156.0.8078.48).

## Коротко

- **Аппаратный WebGPU в клиенте работает.** `navigator.gpu` есть, `requestAdapter()` отдаёт
  адаптер NVIDIA (`vendor: nvidia`, `architecture: lovelace`, `isFallbackAdapter: false`),
  `requestDevice()` создаёт устройство, тестовый треугольник рисуется (проверено чтением
  пикселей), GPU-процесс остаётся в seccomp-sandbox.
- **Редактор Figma умеет рисовать через WebGPU в этом клиенте.** С отладочным параметром
  самой Figma `?force-webgpu=1` Figma пишет в консоль
  `[GPU] graphicsAPI:"WebGPU" … webGPUVendor:"nvidia" deviceArchitecture:"lovelace"`, а
  счётчики показывают тысячи `GPUQueue.submit` и ноль вызовов отрисовки WebGL.
- **По умолчанию на Linux Figma сама выбирает WebGL.** В коде Figma для платформы Linux
  WebGPU отключён жёстким условием. С User-Agent Windows (он нужен и для Font Agent) решение
  принимает серверный feature-gate Figma `use_webgpu_windows_chromeos`. Для анонимных
  профилей в тестах он был выключен, для одного профиля с сохранённой сессией был включён.
  Повлиять на gate клиент не может. Принудительное включение мы **не** делаем по умолчанию.

## Флаги Chromium: что реально даёт аппаратный адаптер

`npm run diag:webgpu` (скрипт `scripts/diag/run-webgpu-probe.mjs`) запускает чистый
Electron-тест с наборами флагов каждого профиля:

| Набор флагов | Результат | GPU sandbox |
|---|---|---|
| без флагов | `requestAdapter()` = `null` (исходная проблема) | да |
| `--enable-unsafe-webgpu` | **SwiftShader**, программный (`isFallbackAdapter: true`) | да |
| `--enable-features=Vulkan` | NVIDIA, аппаратный | да |
| `--enable-features=Vulkan --disable-vulkan-surface` (**профиль по умолчанию**) | NVIDIA, аппаратный | да |
| `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE` (рецепт из Chromium) | NVIDIA, аппаратный | **нет**: seccomp у GPU-процесса выключен |
| `--enable-features=VulkanFromANGLE` без `--use-angle=vulkan` | `null`: Vulkan не инициализируется | да |

Выводы:

1. `--enable-unsafe-webgpu` для аппаратного WebGPU не нужен. Сам по себе он даёт
   программный адаптер, то есть «WebGPU есть», но рисует CPU.
2. Рецепт `--use-angle=vulkan …` работает, но Chromium при ANGLE/Vulkan запускает GPU-процесс
   без seccomp-sandbox. Поэтому он вынесен в отдельный профиль `angle-vulkan` с предупреждением.
3. На X11 WebGPU требует Vulkan и для композитора. Путь Chromium «WebGPU на Vulkan +
   композитор на GL» (`webgpu_on_vk_via_gl_interop`) платформа Ozone объявляет только для
   Wayland (`ui/ozone/platform/wayland/ozone_platform_wayland.cc`), а для X11 нет
   (`gpu/ipc/service/gpu_init.cc`).
4. `--ozone-platform=x11` не нужен: Electron 45 сам выбирает X11 в X11-сессии.

### Почему `--disable-vulkan-surface`

С Vulkan-композитором кадры выводятся через Vulkan-swapchain драйвера NVIDIA. На этой машине
это стоило GPU-процессу **целое ядро CPU** при любой непрерывной перерисовке, даже при
анимации крошечного спиннера (101 % против 3–5 %). С `--disable-vulkan-surface` Chromium
выводит кадр через blit: WebGPU остаётся аппаратным, нагрузка в простое падает до уровня GL.
Цифры есть в [PERFORMANCE.md](PERFORMANCE.md). Если важнее частота кадров на мониторе выше
60 Гц, выберите профиль `vulkan-swapchain`.

## Использует ли WebGPU сама Figma

### Как проверялось

1. **Пассивные счётчики.** С флагом `--webgpu-diag` (или настройкой «Count WebGPU/WebGL calls»)
   до загрузки страницы в main world внедряется
   `src/renderer/DesktopAPI/webgpuInstrumentation.ts`. Он только считает вызовы
   (`requestAdapter`, `requestDevice`, `GPUQueue.submit`, `GPUCanvasContext.getCurrentTexture`,
   `getContext(...)`, WebGL `draw*`) и ничего не меняет. Наличие `navigator.gpu` или адаптера
   доказательством не считается. Доказательство — это `submit` и кадры `getCurrentTexture` на
   холсте редактора при отсутствии WebGL-отрисовки. Результат виден в
   *Help → Diagnostics* (колонка «Renderer verdict»).
2. **Собственный лог Figma.** При загрузке файла Figma пишет в консоль вкладки строку
   `[GPU] graphicsAPI:"…"`. Это прямое свидетельство от движка Figma. Чтобы увидеть её:
   *Help → Toggle Developer Tools* → Console → фильтр `[GPU]`.
3. **Нагрузка.** Зум и панорамирование холста через CDP
   (`scripts/diag/interact.mjs`, `scripts/diag/pan-bench.mjs`) показывают, какой API реально
   рисует новые кадры.

### Результаты (публичный файл из документации Figma, без входа в аккаунт)

| Условие | Строка Figma `[GPU]` | Счётчики при зуме |
|---|---|---|
| UA Windows, новые анонимные профили (5 из 5) | `WebGL 2` | WebGL: 318 → 2867 draw calls; WebGPU: только 2 submit от теста совместимости |
| UA Windows, профиль с сохранённой анонимной сессией (1 прогон) | — | WebGPU: холст 661×860 `webgpu`, 58 submit, 0 WebGL draw calls |
| UA Linux | `WebGL 2` | WebGL: 318 → 3021 draw calls |
| UA Linux + `?force-webgpu=1` | `WebGPU … webGPUVendor:"nvidia" deviceArchitecture:"lovelace" bindings:"emdawnwebgpu"` | WebGPU: 191 → 1720 submit, 20 → 147 кадров; WebGL: 0 |
| профиль `angle-vulkan`, UA Windows | `WebGL 2` (рендерер `ANGLE (NVIDIA, Vulkan 1.4.312 …)`) | WebGL |

Гипотезы «мешает GL-interop» и «мешает фоновая загрузка вкладки» проверены и отвергнуты.

### Как Figma выбирает бэкенд

Логика находится в JS-бандле Figma (модуль `853966`, функция `wO` = `isWebGPUSupportedAndAllowed`).
Читалась только публично отдаваемая минифицированная версия, ничего не изменялось. Упрощённо:

```
platformAllowsWebGPU =
  override == WebGPU ||
  !(safari || firefox < 141 || android || ios || ipad
    || (linux && !PN())            // PN() == true только на внутренних тест-страницах Figma
    || chrome < minimum_chromium_version)
  && navigator.gpu !== undefined

isWebGPUSupportedAndAllowed("editor") =
  platformAllowsWebGPU && override не WebGL && (
    override == WebGPU ||
    mac            ? gate("use_webgpu") :
    windows|chromeos ? gate("use_webgpu_windows_chromeos") :
    linux && PN()  ? gate("use_webgpu" | "use_webgpu_windows_chromeos" | ...) : false)

override: gate webgpu_override / webgl2_override / webgl1_override
          или URL ?force-webgpu=1 / ?force-webgl2=1 / ?force-webgl1=1
```

ОС Figma определяет по User-Agent. Поэтому:

- **UA Linux**: WebGPU в редакторе выключен самой Figma для любого пользователя.
- **UA Windows** (по умолчанию в NG ради Font Agent): WebGPU включается, если для вашего
  аккаунта открыт gate `use_webgpu_windows_chromeos`. Это решает сервер Figma.
- Тест `webgpu_compatibility`, который Figma запускает всегда (флаг `log_webgpu_compatibility`),
  — это телеметрия. Он и даёт те 1–2 `submit` в WebGL-сессиях, и он не причина выбора WebGL.

### Что это значит для вас

После входа в свой аккаунт откройте файл и посмотрите строку `[GPU]` в консоли или вердикт в
*Help → Diagnostics* (запуск с `--webgpu-diag`). Если там `WebGPU`, Figma рисует через WebGPU.
Если `WebGL 2`, это решение Figma для вашего аккаунта, а не ограничение клиента.

Параметр `?force-webgpu=1` — штатный отладочный переключатель Figma. По умолчанию клиент его
**не** добавляет, потому что это означало бы переопределять выбор Figma. Для разовой ручной
проверки можно открыть ссылку на файл с `?force-webgpu=1` через
*File → Open File URL from Clipboard*.
