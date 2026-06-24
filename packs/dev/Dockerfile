# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only
#
# Песочница для dev MCP-сервера ("ИИ-программист").
#
# Слой 4 защиты: весь сервер (файлы + shell + git) исполняется ВНУТРИ контейнера,
# куда смонтирована ТОЛЬКО рабочая папка агента (/workspace). Исходники ядра
# nanokernel контейнеру физически недоступны — даже `rm -rf /` снесёт лишь
# эфемерную ФС контейнера и смонтированный workspace, но не хост.
#
# Сборка:  docker build -t nanokernel-dev-mcp packs/dev
# Запуск:  поднимается платформой через config/mcp.json (command: docker).
FROM node:22-alpine

# git нужен инструменту git_status; остальное — стандартный busybox alpine.
RUN apk add --no-cache git

WORKDIR /app

# Зависимости MCP-сервера. Версии повторяют корневой package.json ядра.
RUN npm install --omit=dev --no-save \
      "@modelcontextprotocol/sdk@^1.29.0" \
      "zod@^4.3.6"

COPY index.mjs ./

# Точка монтирования хост-папки агента; владелец — непривилегированный node.
RUN mkdir -p /workspace && chown -R node:node /app /workspace
USER node

ENV DEV_WORKSPACE_ROOT=/workspace
ENTRYPOINT ["node", "/app/index.mjs"]
