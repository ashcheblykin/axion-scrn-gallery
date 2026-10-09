# Каталог: как описывать продукты, флоу и экраны

Каталог лежит в `catalog/`:

| Файл | Что внутри |
|---|---|
| `products/<id>.yaml` | продукт: стенды, вход, правила съёмки и обезличивания, флоу |
| `anonymize.yaml` | общий словарь: персоны, реальные люди, заказчики, шаблоны PII, блок-лист |
| `taxonomy.yaml` | словарь паттернов, элементов и действий флоу (как в Mobbin) и пять экранов брифа |
| `discovered/<id>.yaml` | подсказки от `scrn discover` (движок их не читает, это черновик для переноса) |

В начале каждого YAML стоит строка `# yaml-language-server: $schema=…`, поэтому VS Code с расширением YAML подсказывает поля и названия действий. Ошибки показывает `./scrn doctor`.

## Продукт

```yaml
id: gen                                  # kebab-case, входит в id экранов и пути файлов
name: Axion Gen
environments:
  stage:
    baseUrl: https://axion-gen-staging1.dev.axionx.ai
    vars: { org: 9 }                     # подставляются в url: /{org}/dashboard
auth:
  profile: gen                           # .auth/gen-stage.json; продукты на одном хосте делят профиль
  startUrl: /dashboards                  # куда вести при входе и проверке сессии
  loggedIn:
    selector: "aside nav"                # что видно только залогиненному (ускоряет проверку)
    # urlNotMatches: "login|sso"         # по умолчанию распознаются типовые URL логина
platforms: [desktop, mobile]
themes:                                  # необязательно: каждая тема снимается отдельно (файлы *.dark.png)
  - { id: default }
  - { id: dark, colorScheme: dark, localStorage: { theme: dark } }
locales:
  - { id: en, locale: en-US }
  - { id: ar, locale: ar-SA, localStorage: { lang: ar } }   # файлы *.ar.png
capture:
  waitForHidden: ["[aria-busy=true]", ".ant-spin-spinning"] # лоадеры, которые должны исчезнуть
  backdrop: [html, body, "#root", main]  # что считать фоном для .clear.png
  chrome: [aside, header]                # что прятать в .cards.png
  hide: ["[class*='toast' i]"]           # всегда прятать (тосты, виджеты поддержки)
  ignoreInDiff: [".mapboxgl-canvas"]     # живые области, которые не должны порождать новые версии
  scrollContainer: main                  # внутренний скролл (обычно определяется сам)
  css: ".beta-badge { display: none }"   # любой CSS перед съёмкой
discover:
  maxPages: 150                          # страниц на продукт; 0 — не обходить продукт
  maxStates: 150                         # вкладок, панелей и карточек-состояний на продукт
  depth: 3                               # 1 — разделы меню, 2 — их карточки, 3 — ещё уровень
  exclude: [logout, settings/billing]    # части URL, куда не ходить
  navSelectors: [nav, aside, "[role=navigation]", header]   # где искать разделы
  platforms: [desktop]                   # где снимать найденное (mobile — если вёрстка адаптивная)
```

### Обход разделов

`scrn discover` и `scrn refresh` проходят приложение так, как это сделал бы человек: раскрывают свёрнутые группы меню (`aria-expanded`, `<details>`), нажимают пункты без ссылок, заходят в каждый раздел и на карточку из его таблицы, открывают каждую вкладку и панели фильтров, колонок и вида. Каждая группа меню становится флоу `_<раздел>`: страницы раздела, вкладки (`…-tab-list`), панели (`…-panel-filters`) и карточки (`…-id`). Экраны, которые уже описаны в каталоге, не повторяются, но их вкладки и панели попадают во флоу раздела.

Нажимается только безопасное. Кнопки с текстом вроде «Удалить», «Отправить», «Сохранить», «Подтвердить», «Экспорт», «Выйти» (и их английские и арабские аналоги) обход не трогает никогда, «Создать» — тоже. Такие экраны описывай в каталоге шагами с `actions`.

Продукты на одном стенде с одной сессией (C&C и Sense) обходятся один раз. Разделы раскладываются по продуктам по маршрутам их каталогов: раздел с `/frames…` уйдёт в Sense, остальные — в C&C. Найденное пишется в `catalog/discovered/<product>.yaml`: оттуда флоу и шаги можно перенести в каталог как есть.

## Флоу и шаги

```yaml
flows:
  - id: inspectors
    name: Инспекторы
    brief: executive-summary          # если флоу закрывает экран из брифа
    actions: [Viewing, Monitoring]    # действия флоу из taxonomy.yaml
    tags: [field-operations]
    platforms: [desktop]              # по умолчанию — все платформы продукта
    steps:
      - id: list
        name: Инспекторы
        url: /{org}/inspectors        # переход перед действиями
        patterns: [List & Table, Map view]
        sections:                     # плашки: изолированные элементы на прозрачном фоне
          - { id: kpi, name: KPI смены, selector: "[data-testid=shift-kpi]", padding: 24 }
      - id: profile
        name: Профиль инспектора
        actions:                      # продолжаем с состояния предыдущего шага
          - click: "table tbody tr >> nth=0"
          - waitFor: "[data-testid=timeline]"
        after:
          - press: Escape             # вернуть состояние для следующего шага
        on:
          mobile:                     # переопределения для платформы
            actions:
              - click: "button[aria-label=Menu]"
              - click: "text=Inspectors"
```

Поля шага:

| Поле | Зачем |
|---|---|
| `url` | открыть страницу (путь от `baseUrl` или полный URL, `{vars}` подставляются) |
| `actions` / `after` | действия до и после съёмки |
| `patterns`, `elements`, `tags`, `description` | метаданные для поиска; Claude дополнит их сам |
| `sections` | плашки: `selector`, `nth`, `padding` (поле под тень), `radius` (принудительное скругление), `fill` (фон, если у карточки его нет) |
| `viewport` | другой размер окна для этого шага (`{ height: 1400 }`) |
| `full` | `true` или `false` — принудительно включить или выключить `.full.png` |
| `delay`, `waitFor`, `hide`, `ignoreInDiff` | тонкая настройка стабильности |
| `figma` | взять экран из Figma вместо стенда: `{ file: XDOceRokvyikE1cuk6HO9S, node: "2115:61550" }`. Нужен `FIGMA_TOKEN` |
| `platforms`, `enabled`, `todo` | где снимать; выключить; что ещё не известно (шаг пропускается) |

## Действия

Каждое действие — объект с одним ключом. Селекторы — это [селекторы Playwright](https://playwright.dev/docs/locators): CSS, `text=…`, `role=button[name="…"]`, `>> nth=0`. Лучше всего работают `data-testid`.

| Действие | Пример |
|---|---|
| `goto` | `- goto: /{org}/planning` |
| `click`, `dblclick`, `hover` | `- click: "text=Insights"` или `- click: { selector: ".card", nth: 2, force: true }` |
| `fill`, `type` | `- fill: { selector: "input[type=search]", value: "Riyadh" }` |
| `press` | `- press: Escape` или `- press: { selector: "textarea", key: Enter }` |
| `select`, `check`, `uncheck` | `- select: { selector: "select#period", value: "7d" }` |
| `scroll`, `scrollIntoView` | `- scroll: { selector: main, to: bottom }`, `- scrollIntoView: "#charts"` |
| `wait`, `waitFor`, `waitForUrl`, `waitForNetworkIdle` | `- waitFor: { selector: ".chart", state: visible }` |
| `localStorage`, `reload`, `emulate` | `- localStorage: { sidebarCollapsed: "true" }` |
| `setViewport`, `mouse`, `evaluate` | `- evaluate: "document.documentElement.classList.add('dark')"` |

## Обезличивание продукта

```yaml
anonymize:
  rules:                                   # поля, где имена и номера заранее неизвестны
    - { selector: "[data-col=inspector]", kind: person }   # → персона (арабское имя → арабская персона)
    - { selector: ".org-name", kind: org }
    - { selector: ".phone", kind: digits }                 # формат сохраняется, цифры меняются
    - { selector: ".plate", kind: chars }
    - { selector: ".address", kind: text, value: "King Fahd Rd, Riyadh" }
  images:
    - { selector: ".avatar img", with: avatar }            # инициалы персоны
    - { selector: "img[src*=momra i]", with: logo }        # логотип Axion (assets/anonymize/logo.svg, на тёмном — белый)
    - { selector: ".frame img", with: blur }               # или hide, или путь к своей картинке
  blur: [".video-frame"]
  hide: [".debug-panel"]
  network:
    - { url: "**/api/**", anonymize: true, keepKeys: [code, slug] }
    - { url: "**/api/me", merge: { name: "Alex Morgan", email: "alex.morgan@example.com" } }
  blocklist: ["Codename Falcon"]           # чего не должно быть на экране этого продукта
```

Правила меняют только значения: `chars` — то, что похоже на номер (есть цифры, нет строчных слов), `email` — текст с `@`, `person` — имя из нескольких слов без цифр. Внутри навигации, меню, вкладок и деревьев правила не применяются (кроме `person` и `email`: имя пользователя часто стоит в сайдбаре). Если под селектором оказался большой блок текста, это контейнер, и он пропускается. Селекторы лучше писать по началу класса: `[class*='plate' i]` совпадает и с `template`.

Логотип для подмены — `assets/anonymize/logo.svg`. Чёрный знак на тёмном фоне автоматически становится белым; свой вариант для тёмного фона можно положить в `assets/anonymize/logo-on-dark.svg`.

## Отладка

- `./scrn capture gen/executive-summary --headed` — смотреть в окне браузера, что происходит.
- `./scrn capture … --dry-run` — снять в `.scrn/dry-run/`, не трогая библиотеку.
- `.scrn/failures/<run>/<id>.png` — скриншот момента ошибки и URL (локально, в git не попадает).
- `.scrn/quarantine/<id>.json` — что именно нашёл guard. Добавь правило в `anonymize` и пересними.
- `./scrn -v capture …` — подробный лог (повторы, лоадеры, которые не исчезли).
