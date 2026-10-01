# Axion Screens — библиотека экранов Gen, Command & Control и Sense

Движок, который сам снимает интерфейсы продуктов Axion, раскладывает их по флоу в духе Mobbin, обезличивает данные, хранит версии и регулярно обновляет базу. Агенты (Claude Code, Claude Desktop, Cursor) работают с библиотекой через MCP: находят нужный экран и забирают готовый к слайду файл.

Зачем: визуалы для презентации ПЧДК и сайта, бренд-гайд (экраны на прозрачном фоне и отдельные плашки), единый архив скриншотов, который сам обновляется вслед за стендами.

```
scrn refresh
  ├─ обход навигации (discover) ─ поверхностные экраны всех разделов
  ├─ флоу из catalog/products/*.yaml ─ шаги → экраны → плашки
  │    └─ для каждого экрана: обезличивание (API → DOM) → guard → съёмка Retina
  │         → варианты: с фоном / .clear / .cards / .full / плашки
  ├─ диф с прошлой версией → новая версия, только если экран реально изменился
  ├─ автотеги и privacy-аудит (Claude)
  ├─ галерея library/index.html
  └─ git commit + push (PNG в Git LFS)
```

## Быстрый старт

```bash
git lfs install
npm install                      # заодно собирает dist/
npx playwright install chromium
cp .env.example .env             # ANTHROPIC_API_KEY — автотеги, FIGMA_TOKEN — мобильные макеты

./scrn auth gen                  # откроется браузер: войди через SSO/2FA, сессия сохранится сама
./scrn auth cnc                  # одна сессия на Command & Control и Sense
./scrn doctor                    # проверка каталога, браузера, сессий и ключей
./scrn capture brief             # 5 экранов из брифа презентации
./scrn gallery --open            # посмотреть, что получилось
```

`./scrn` — обёртка над `node dist/cli/index.js`. Если хочется глобальную команду `scrn`, выполни `npm link`.

## Как устроена библиотека (механика Mobbin)

| Mobbin | Здесь |
|---|---|
| App + платформа | продукт (`gen`, `cnc`, `sense`) × `desktop` / `mobile` |
| Flow — последовательность экранов | флоу в `catalog/products/<product>.yaml`: шаги выполняются по порядку в одной вкладке |
| Screen с паттернами и элементами | шаг = экран; `patterns` и `elements` из `catalog/taxonomy.yaml` плюс автотеги Claude |
| Sections | `sections` шага: изолированные плашки (KPI, графики, таблицы) без фона |
| Версии приложения | новая версия экрана появляется, только если изменилось больше 0.4% пикселей; история хранится в git |

Отдельный слой — **бриф**: у флоу стоит `brief: <id>` для одного из пяти экранов презентации. И в галерее, и в MCP их можно отфильтровать.

| Бриф | Где снимаем | Статус |
|---|---|---|
| `quality-check` — проверка качества | Sense → `/frames?imageQuality=rejected` + разбор кадра | готово к съёмке |
| `executive-summary` — сводка для руководителя | Gen → `/dashboards`, C&C → `/{org}/dashboard` | готово к съёмке |
| `decision-card` — карточка решения (HITL) | C&C | `todo`: актуального интерфейса может не быть |
| `agent-work` — агентная работа, диалоги | Gen | `todo`: нужен URL ассистента |
| `customer-system-task` — задача во внешней системе | C&C | `todo`: интерфейса может не быть |

Флоу с `todo:` пропускаются, пока их не уточнят (`./scrn doctor` выводит их список). Подробнее о формате — в [docs/catalog.md](docs/catalog.md).

### Что лежит в `library/`

```
library/
  index.json                                   ← каталог: экраны, флоу, версии, теги, прогоны
  index.html                                   ← галерея
  gen/desktop/executive-summary/
    01-dashboards.png                          ← экран с фоном, 2880×1800 (@2x)
    01-dashboards.clear.png                    ← фон приложения прозрачный, карточки на месте
    01-dashboards.cards.png                    ← только плашки: без фона, сайдбара и шапки
    01-dashboards.full.png                     ← вся страница, если контент не влез в первый экран
    01-dashboards.thumb.webp                   ← превью (лежит в обычном git)
    02-dashboard--kpi-row.png                  ← изолированная плашка со своими скруглениями и тенью
  gen/desktop/_discovered/…                    ← поверхностные экраны из обхода навигации
```

Мобильные экраны снимаются в разрешении iPhone 15 Pro: 1179×2556 (@3x), десктоп — 2880×1800 (@2x). Такие картинки без пересчёта вставляются в макапы устройств. Разрешения задаются в `scrn.config.yaml → platforms`. Полноразмерные PNG хранятся в Git LFS, превью и `index.json` — в обычном git, поэтому галерея работает и без `git lfs pull`.

## Команды

| Команда | Что делает |
|---|---|
| `scrn doctor` | Проверяет каталог (схемы, CSS-селекторы, TODO), браузер, сессии, ключи, LFS |
| `scrn auth <product>` | Открывает браузер для входа через SSO/2FA и сохраняет сессию в `.auth/` (в git не попадает). `--check` проверяет сессии без окна |
| `scrn capture [targets]` | Снимает экраны: `brief`, `gen`, `gen/executive-summary`, `cnc/inspectors/profile`. Флаги: `-p mobile`, `--headed`, `--dry-run`, `--force`, `--tag` |
| `scrn discover [product]` | Обходит навигацию, снимает разделы, которых нет в каталоге, и пишет подсказку в `catalog/discovered/<product>.yaml` |
| `scrn refresh` | Полное обновление: discover → все флоу → диф → автотеги → галерея. Флаги: `--commit --push`, `--prune`, `--no-tag` |
| `scrn tag` | Автотеги и privacy-аудит через Claude для новых и изменившихся экранов |
| `scrn export <запрос или id>` | Файлы для слайдов: `--variant framed --bg blur`, `clear`, `cards`, `layers` (SVG со слоями для Figma) |
| `scrn list`, `scrn history <id>` | Список экранов и их версии в git |
| `scrn gallery --open`, `scrn serve` | Галерея: открыть с диска или раздать по http://127.0.0.1:4567 |
| `scrn mcp` | MCP-сервер (stdio) |
| `scrn watch`, `scrn schedule install` | Периодическое обновление |

Примеры экспорта:

```bash
./scrn export "сводка KPI" --variant framed --bg blur          # экран на размытом фоне из самого себя
./scrn export gen.desktop.executive-summary.dashboard --variant cards --padding 32
./scrn export gen.desktop.executive-summary.dashboard --variant layers   # в Figma фон можно выключить или заблюрить
```

Имена файлов понятны сами по себе: `Axion Gen · Сводка для руководителя · 02 Дашборд с KPI (desktop, en, framed).png`.

## Обезличивание: безопасно по умолчанию

Экраны могут стать публичными, поэтому реальных данных на них быть не должно.

1. **API.** JSON-ответы (`anonymize.network`) проходят через словарь ещё до отрисовки. Так обезличиваются и графики на canvas, и карты, и тултипы. Идентификаторы и enum-константы не трогаются, чтобы не сломать логику приложения.
2. **DOM.** Текст, атрибуты, инпуты, SVG-подписи графиков, shadow DOM. Селекторные правила (`person`, `org`, `email`, `digits`, `chars`, `text`) работают для полей, где имена заранее неизвестны (инспекторы, пользователь в сайдбаре). Логотипы заказчиков заменяются нейтральной «A», аватары — инициалами персоны, фото можно размыть.
3. **Guard.** Перед публикацией всё, что видно на экране, проверяется по блок-листу (реальные люди, Momra/Balady и т. д.) и по шаблонам PII. Если что-то нашлось, экран в библиотеку не попадает и уходит в `.scrn/quarantine/`.
4. **Privacy-аудит Claude** (`scrn tag`) смотрит на пиксели: лица, номера машин, логотипы, имена не из списка персон. Подозрительный экран получает статус `review`, и MCP не отдаёт его по умолчанию.

Замены детерминированы: реальный человек на всех экранах и при каждом обновлении превращается в одну и ту же персону, арабские имена — в арабские. Словарь лежит в `catalog/anonymize.yaml`, правила под конкретный продукт — в `catalog/products/*.yaml → anonymize`.

> Репозиторий должен оставаться приватным: в словаре перечислены заказчики, которых нельзя светить. Сессии (`.auth/`), карантин и дампы ошибок (`.scrn/`) в git не попадают.

## Периодическое обновление

Стенды требуют SSO, поэтому обновление крутится на машине дизайнера, а не в CI:

```bash
npm run build
./scrn schedule install            # macOS: launchd, Linux: crontab — по cron из scrn.config.yaml (пн 07:00)
./scrn schedule install --cron "0 7 * * 1-5"
```

Расписание запускает `scrn refresh --commit --push`. Если сессия истекла, придёт системное уведомление, в логе `.scrn/schedule.log` будет подсказка, а старые версии экранов останутся на месте. Чтобы не ставить в планировщик, есть `./scrn watch --now` — процесс, который сам запускает обновление по расписанию.

## MCP: экраны для агентов

В репозитории лежит `.mcp.json`, поэтому Claude Code, открытый в этой папке, сразу видит сервер `axion-screens`. Для Claude Desktop добавь в `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axion-screens": { "command": "node", "args": ["/ПУТЬ/К/axion-scrn-gallery/dist/cli/index.js", "mcp"] }
  }
}
```

| Инструмент | Зачем |
|---|---|
| `search_screens` | Поиск экранов по смыслу на русском и английском, фильтры `product`, `platform`, `pattern`, `element`, `brief` |
| `search_flows` | Сценарии: последовательности экранов, как в Mobbin |
| `search_sections` | Отдельные плашки: KPI, графики, таблицы на прозрачном фоне |
| `get_screen`, `get_flow` | Карточка экрана или флоу с превью |
| `export_screen` | Готовые файлы: `clear`, `cards`, `framed`, `layers` |
| `list_products`, `library_status` | Что есть в библиотеке, покрытие брифа, ошибки, карантин, сессии |
| `capture` | Переснять экран со стенда |

Ресурсы: `screen://<id>` (PNG) и `library://index`. Промпт `screens_for_slide` подбирает экраны под тезис слайда.

Пример запроса агенту: «Найди в axion-screens экран сводки KPI из Gen и сделай framed на размытом фоне для слайда про руководителей».

## Разработка

```bash
npm test              # юнит-тесты + e2e на мок-приложении (test/fixtures/mock-app) + MCP-клиент
npm run typecheck
npm run mock          # мок-стенд на http://127.0.0.1:4580 с «грязными» данными для экспериментов
npm run schemas       # перегенерировать schemas/*.json (автодополнение YAML в VS Code)
```

Стек: TypeScript, Playwright (Chromium), sharp, pixelmatch, MCP SDK, Anthropic SDK (vision + structured outputs; модель — `scrn.config.yaml → tagging.model`).

## Ограничения

- Текст, который приложение рисует на canvas или WebGL из захардкоженных строк (а не из API), DOM-слой не видит. Такие места закрывает только сетевой слой или privacy-аудит Claude.
- Фото с камер (лица, номера) по умолчанию не размываются: это суть продукта Sense. Для публичных материалов включи `anonymize.blur` в `catalog/products/sense.yaml`.
- Селекторы в каталоге подобраны общие (`[class*='user-name' i]` и т. п.). После первого `./scrn capture --headed` их стоит уточнить по реальной вёрстке, а лучше договориться с фронтендом о `data-testid`.
