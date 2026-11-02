import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FigmaClient } from "./figma-client.js";
import { resolveFigmaLink } from "./resolve-link.js";

/**
 * Определения MCP-инструментов фазы 1 (REST). Экспортируем как массив
 * { name, description, inputSchema, handler }, чтобы server.ts мог
 * зарегистрировать их единообразно через registerTool.
 */
export function createTools(client: FigmaClient) {
  return [
    {
      name: "resolve_link",
      description:
        "Разбирает ссылку Figma на фрейм/файл и возвращает fileKey и nodeId для использования в других инструментах.",
      inputSchema: {
        url: z.string().describe("Ссылка на файл или фрейм Figma"),
      },
      handler: async ({ url }: { url: string }) => {
        const resolved = resolveFigmaLink(url);
        return resolved;
      },
    },

    {
      name: "get_node_tree",
      description:
        "Возвращает дерево конкретной ноды (фрейма/секции) Figma: layout, fills, strokes, текст, инлайн-стили и компоненты. Не скачивает весь файл.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
        nodeId: z.string().describe("ID ноды в формате '123:456' (не '123-456')"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Ограничить глубину вложенности детей — полезно на больших фреймах, чтобы не раздувать ответ"),
      },
      handler: async ({
        fileKey,
        nodeId,
        maxDepth,
      }: {
        fileKey: string;
        nodeId: string;
        maxDepth?: number;
      }) => {
        const result = await client.getFileNodes(fileKey, [nodeId]);
        const node = result.nodes[nodeId] ?? result;
        if (maxDepth !== undefined && node && typeof node === "object" && "document" in node) {
          pruneDepth((node as { document: unknown }).document, maxDepth);
        }
        return node;
      },
    },

    {
      name: "get_metadata",
      description:
        "Лёгкое дерево ноды: только id, name, type и bounds, без стилей/fills/текста. Используй, чтобы сначала осмотреться на большом фрейме и понять структуру, а потом точечно запросить get_node_tree для нужной ветки — экономит токены по сравнению с полным деревом.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
        nodeId: z.string().describe("ID ноды в формате '123:456'"),
      },
      handler: async ({ fileKey, nodeId }: { fileKey: string; nodeId: string }) => {
        const result = await client.getFileNodes(fileKey, [nodeId]);
        const entry = result.nodes[nodeId];
        if (!entry) throw new Error(`Нода ${nodeId} не найдена в файле ${fileKey}`);
        return buildMetadata(entry.document);
      },
    },

    {
      name: "whoami",
      description: "Проверяет FIGMA_TOKEN и возвращает аккаунт, которому он принадлежит.",
      inputSchema: {},
      handler: async () => {
        return client.getMe();
      },
    },

    {
      name: "rate_limit_status",
      description:
        "Сколько запросов к Figma REST API ушло за последнюю минуту с этого сервера. Figma не публикует точные квоты по эндпоинтам — это фактический счётчик, а не официальный лимит.",
      inputSchema: {},
      handler: async () => {
        return { requestsLastMinute: client.getRequestsLastMinute() };
      },
    },

    {
      name: "get_styles",
      description:
        "Возвращает метаданные стилей файла (id → имя/описание/тип) для маппинга значений из get_node_tree на человекочитаемые имена.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
      },
      handler: async ({ fileKey }: { fileKey: string }) => {
        const result = await client.getFileStyles(fileKey);
        return result.meta.styles;
      },
    },

    {
      name: "get_components",
      description: "Возвращает компоненты и component sets файла Figma.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
      },
      handler: async ({ fileKey }: { fileKey: string }) => {
        const { components, componentSets } = await client.getFileComponents(fileKey);
        return {
          components: components.meta.components,
          componentSets: componentSets.meta.component_sets,
        };
      },
    },

    {
      name: "export_image",
      description:
        "Рендерит одну или несколько нод Figma в картинки. Без outputDir возвращает временные ссылки на скачивание (действуют ограниченное время). С outputDir — скачивает файлы на диск и возвращает локальные пути. Передай несколько nodeIds одним вызовом вместо того, чтобы дёргать инструмент по кругу.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
        nodeIds: z.array(z.string()).min(1).describe("ID нод в формате '123:456'"),
        format: z.enum(["png", "svg", "jpg"]).default("png"),
        scale: z.number().min(0.01).max(4).default(1),
        outputDir: z
          .string()
          .optional()
          .describe("Если задан — картинки скачиваются в эту папку (создаётся при необходимости), ответ содержит локальные пути вместо ссылок"),
      },
      handler: async ({
        fileKey,
        nodeIds,
        format,
        scale,
        outputDir,
      }: {
        fileKey: string;
        nodeIds: string[];
        format: "png" | "svg" | "jpg";
        scale: number;
        outputDir?: string;
      }) => {
        const result = await client.exportImage(fileKey, nodeIds, format, scale);
        if (result.err) throw new Error(`Figma export error: ${result.err}`);
        if (!outputDir) return result.images;

        await mkdir(outputDir, { recursive: true });
        const paths: Record<string, string> = {};
        for (const [nodeId, url] of Object.entries(result.images)) {
          if (!url) continue;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Не удалось скачать рендер ${nodeId}: HTTP ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const filename = `${nodeId.replace(/[:/]/g, "-")}.${format}`;
          const filePath = join(outputDir, filename);
          await writeFile(filePath, buffer);
          paths[nodeId] = filePath;
        }
        return paths;
      },
    },
  ];
}

/** Строит лёгкое дерево: id/name/type/bounds, без стилей и прочих деталей. */
function buildMetadata(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  const box = (n.absoluteBoundingBox ?? null) as { x?: number; y?: number; width?: number; height?: number } | null;

  const result: Record<string, unknown> = {
    id: n.id,
    name: n.name,
    type: n.type,
  };
  if (box) {
    result.x = box.x;
    result.y = box.y;
    result.width = box.width;
    result.height = box.height;
  }

  const children = n.children;
  if (Array.isArray(children) && children.length > 0) {
    result.children = children.map(buildMetadata);
  }

  return result;
}

/**
 * Обрезает дерево ноды до maxDepth уровней детей — чтобы get_node_tree не
 * раздувал ответ на больших фреймах. Мутирует node на месте.
 */
function pruneDepth(node: unknown, maxDepth: number, depth = 0): void {
  if (!node || typeof node !== "object") return;
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return;

  if (depth >= maxDepth) {
    (node as { children?: unknown[]; truncatedChildCount?: number }).truncatedChildCount = children.length;
    delete (node as { children?: unknown[] }).children;
    return;
  }

  for (const child of children) {
    pruneDepth(child, maxDepth, depth + 1);
  }
}
