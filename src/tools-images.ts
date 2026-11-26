import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer } from "./bridge-server.js";

/** Экспорт, передача картинок и клон шаблона заметно дольше обычных команд. */
const HEAVY_TIMEOUT_MS = 60_000;

const DEFAULT_OUTPUT_DIR = join(tmpdir(), "guddion-figma");

const outputDirField = z
  .string()
  .optional()
  .describe(`Папка для файлов; создаётся при необходимости. По умолчанию ${DEFAULT_OUTPUT_DIR}`);

const operationIdField = z
  .string()
  .optional()
  .describe("Повтор с тем же значением (например, после CALL_TIMEOUT) вернёт результат первой попытки, а не выполнит запись ещё раз.");

const imageFields = {
  imageHash: z
    .string()
    .optional()
    .describe("Картинка, уже загруженная в файл. Без imageHash и imagePath остаётся текущая картинка ноды"),
  imagePath: z.string().optional().describe("Локальный файл PNG/JPEG/GIF, не больше 4096px по стороне"),
  crop: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional()
    .describe("Видимая область в пикселях исходника. Под пропорции ноды только сужается. Без crop — режим FILL"),
  anchorX: z.enum(["start", "center", "end"]).optional().describe("Куда прижать сузившийся кроп по горизонтали (по умолчанию center)"),
  anchorY: z.enum(["start", "center", "end"]).optional().describe("То же по вертикали; end сохраняет низ и срезает верх"),
};

function detectImageExtension(bytes: Buffer): "png" | "jpg" | "gif" | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  return null;
}

/** У плагина нет доступа к диску — локальный файл уезжает ему как base64. */
async function withImageData(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { imagePath, ...rest } = params;
  if (!imagePath) return rest;
  if (rest.imageHash) throw new Error("Передай что-то одно: imageHash или imagePath");

  const bytes = await readFile(imagePath as string);
  if (!detectImageExtension(bytes)) {
    throw new Error(`${imagePath}: Figma принимает только PNG, JPEG и GIF`);
  }
  return { ...rest, data: bytes.toString("base64") };
}

async function saveFile(outputDir: string | undefined, filename: string, base64: string): Promise<string> {
  const dir = outputDir ?? DEFAULT_OUTPUT_DIR;
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

/** MCP-инструменты для пакетной работы с картинками через Plugin Bridge. */
export function createImageTools(bridge: BridgeServer) {
  return [
    {
      name: "get_node_details",
      description:
        "Полное чтение нод через плагин: дети, размеры, fills (imageHash, scaleMode, imageTransform), эффекты, скругления, clipsContent, Auto Layout, текст и шрифты. Значения по умолчанию опущены. Без nodeIds читает выделение, без выделения — текущую страницу. nodeIds: ['0:0'] вернёт список страниц файла.",
      inputSchema: {
        nodeIds: z.array(z.string()).optional(),
        depth: z.number().int().min(0).optional().describe("Уровней детей (по умолчанию 5). Для обзора страницы бери 1-2"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("get_node_details", params, undefined, HEAVY_TIMEOUT_MS);
      },
    },

    {
      name: "export_node",
      description:
        "Рендерит ноды в PNG/JPG через плагин (без REST и его лимитов) и сохраняет на диск. Возвращает локальные пути — открой файл, чтобы увидеть ноду.",
      inputSchema: {
        nodeIds: z.array(z.string()).min(1),
        format: z.enum(["PNG", "JPG"]).default("PNG"),
        maxSize: z.number().int().min(16).max(4096).optional().describe("Размер большей стороны в px — для превью"),
        scale: z.number().min(0.01).max(4).optional().describe("Игнорируется, если задан maxSize"),
        outputDir: outputDirField,
      },
      handler: async ({ nodeIds, outputDir, ...settings }: Record<string, any>) => {
        const files: { nodeId: string; name: string; path: string }[] = [];
        for (const nodeId of nodeIds as string[]) {
          const result = (await bridge.call("export_node", { nodeId, ...settings }, undefined, HEAVY_TIMEOUT_MS)) as {
            name: string;
            data: string;
          };
          const filename = `${nodeId.replace(/[^\w-]/g, "-")}.${String(settings.format ?? "PNG").toLowerCase()}`;
          files.push({ nodeId, name: result.name, path: await saveFile(outputDir, filename, result.data) });
        }
        return files;
      },
    },

    {
      name: "get_image",
      description:
        "Сохраняет на диск исходную картинку из заливки (imageHash из get_node_details) без обрезки и возвращает путь и размер в пикселях. В этих пикселях задаётся crop.",
      inputSchema: {
        imageHash: z.string(),
        outputDir: outputDirField,
      },
      handler: async ({ imageHash, outputDir }: Record<string, any>) => {
        const result = (await bridge.call("get_image", { imageHash }, undefined, HEAVY_TIMEOUT_MS)) as {
          width: number;
          height: number;
          data: string;
        };
        const extension = detectImageExtension(Buffer.from(result.data.slice(0, 16), "base64")) ?? "bin";
        const filename = `${String(imageHash).replace(/[^\w-]/g, "-")}.${extension}`;
        return { path: await saveFile(outputDir, filename, result.data), width: result.width, height: result.height };
      },
    },

    {
      name: "set_image_fill",
      description:
        "Ставит картинку в заливку ноды и кадрирует её по прямоугольнику в пикселях исходника. Остальные заливки (градиенты) сохраняются. upscale > 1 в ответе означает, что картинка растянута и может мылить.",
      inputSchema: {
        nodeId: z.string(),
        ...imageFields,
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("set_image_fill", await withImageData(rest), operationId as string | undefined, HEAVY_TIMEOUT_MS);
      },
    },

    {
      name: "apply_template",
      description:
        "Одним вызовом клонирует эталонный фрейм, ставит в нужный слой клона свою картинку с кропом и заменяет тексты. targetNodeId везде — id слоёв внутри ШАБЛОНА. Сам шаблон не меняется; при ошибке клон удаляется.",
      inputSchema: {
        templateNodeId: z.string(),
        image: z.object({ targetNodeId: z.string(), ...imageFields }).optional(),
        texts: z.array(z.object({ targetNodeId: z.string(), text: z.string() })).optional(),
        name: z.string().optional(),
        parentNodeId: z.string().optional().describe("Куда положить клон; по умолчанию — на текущую страницу"),
        x: z.number().optional(),
        y: z.number().optional(),
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, image, ...rest } = params;
        const payload = image ? { ...rest, image: await withImageData(image as Record<string, unknown>) } : rest;
        return bridge.call("apply_template", payload, operationId as string | undefined, HEAVY_TIMEOUT_MS);
      },
    },
  ];
}
