import { z } from "zod";
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
        "Рендерит одну или несколько нод Figma в картинки и возвращает временные ссылки на скачивание (действуют ограниченное время). Передай несколько nodeIds одним вызовом вместо того, чтобы дёргать инструмент по кругу.",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
        nodeIds: z.array(z.string()).min(1).describe("ID нод в формате '123:456'"),
        format: z.enum(["png", "svg", "jpg"]).default("png"),
        scale: z.number().min(0.01).max(4).default(1),
      },
      handler: async ({
        fileKey,
        nodeIds,
        format,
        scale,
      }: {
        fileKey: string;
        nodeIds: string[];
        format: "png" | "svg" | "jpg";
        scale: number;
      }) => {
        const result = await client.exportImage(fileKey, nodeIds, format, scale);
        if (result.err) throw new Error(`Figma export error: ${result.err}`);
        return result.images;
      },
    },
  ];
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
