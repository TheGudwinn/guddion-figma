# Рецепты

Готовые цепочки вызовов под конкретные задачи. См. также `SKILL.md` для общего порядка.

## Разобрать фрейм по ссылке пользователя

```
resolve_link(url)
  → get_metadata(fileKey, nodeId)          # понять структуру
  → get_node_tree(fileKey, childNodeId, maxDepth: 2)  # детали нужной части
```

Не вызывай `get_node_tree` сразу на корневом nodeId без `maxDepth`, если `get_metadata` показал глубокую вложенность — ответ может быть неоправданно большим.

## Выгрузить дизайн-токены в код

```
export_tokens(outputDir: "<путь-к-проекту>/src/styles")
```

Вернёт `tokens.json` (DTCG) и `tokens.css` (custom properties) на диске — можно сразу импортировать в проект. Если нужен просто предпросмотр содержимого без записи файлов — вызови без `outputDir`.

## Скачать набор иконок/ассетов одним вызовом

```
find_node(query: "icon/", type: "COMPONENT")
  → export_image(fileKey, nodeIds: [...], format: "svg", outputDir: "<путь>/assets")
```

## Создать новый блок на холсте

```
get_plugin_status()                         # убедиться, что плагин подключён
write_node(type: "FRAME", name: "Hero", width: 1440, height: 600)
write_node(type: "TEXT", parentNodeId: <id фрейма>, text: "Заголовок")
```

## Поправить существующий элемент вместо пересоздания

```
find_node(query: "Hero")
  → update_node(nodeId: <id>, width: 1600, name: "Hero v2")
```

## Размножить компонент на несколько экземпляров

```
find_node(query: "Card", type: "COMPONENT")
  → clone_node(nodeId: <id>, x: 0, y: 200, name: "Card 2")
  → clone_node(nodeId: <id>, x: 0, y: 400, name: "Card 3")
```

## Диагностика "не работает"

```
whoami()              # если REST падает с ошибкой авторизации
get_plugin_status()    # если write/variables-инструменты говорят "plugin не подключён"
rate_limit_status()    # если REST отвечает медленно/429
```
