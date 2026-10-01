---
description: Подобрать экраны Axion под тезис слайда и подготовить файлы (clear / cards / framed / layers)
argument-hint: "<тезис слайда> [стиль: framed | clear | cards | layers]"
allowed-tools: mcp__axion-screens__search_screens, mcp__axion-screens__search_sections, mcp__axion-screens__search_flows, mcp__axion-screens__get_screen, mcp__axion-screens__export_screen
---

Подбери 1–3 экрана из библиотеки Axion Screens для слайда: $ARGUMENTS

1. `search_screens` (и `search_sections`, если нужен отдельный виджет или KPI-плашка). Посмотри превью — выбирай наглядные экраны без пометок о проблемах качества.
2. `export_screen` с подходящим вариантом: `framed` (на фоне, с отступом и тенью) — по умолчанию; `clear` / `cards` — если слайд со своим фоном; `layers` — если дальше Figma.
3. Верни пути к файлам и одной строкой — почему выбран каждый экран.
