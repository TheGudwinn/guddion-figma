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
      },
      handler: async ({ fileKey, nodeId }: { fileKey: string; nodeId: string }) => {
        const result = await client.getFileNodes(fileKey, [nodeId]);
        return result.nodes[nodeId] ?? result;
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
        "Рендерит ноду Figma в картинку и возвращает временную ссылку на скачивание (действует ограниченное время).",
      inputSchema: {
        fileKey: z.string().describe("Ключ файла Figma"),
        nodeId: z.string().describe("ID ноды в формате '123:456'"),
        format: z.enum(["png", "svg", "jpg"]).default("png"),
        scale: z.number().min(0.01).max(4).default(1),
      },
      handler: async ({
        fileKey,
        nodeId,
        format,
        scale,
      }: {
        fileKey: string;
        nodeId: string;
        format: "png" | "svg" | "jpg";
        scale: number;
      }) => {
        const result = await client.exportImage(fileKey, [nodeId], format, scale);
        if (result.err) throw new Error(`Figma export error: ${result.err}`);
        return { url: result.images[nodeId] };
      },
    },
  ];
}
