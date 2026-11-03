import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeServer } from "./bridge-server.js";
import { buildTokenExports, type VariablesPayload } from "./tokens.js";

const typographySchema = z
  .object({
    fontFamily: z.string().optional().describe("Семейство шрифта, например 'Inter'"),
    fontStyle: z.string().optional().describe("Начертание, например 'Regular', 'Bold'"),
    fontSize: z.number().optional(),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    lineHeight: z.any().optional().describe("Число (px), '100%' или объект {unit, value} как в Plugin API"),
    letterSpacing: z.any().optional().describe("Число (px) или объект {unit, value} как в Plugin API"),
  })
  .optional()
  .describe("Типографика — только для TEXT-нод");

const layoutSchema = z
  .object({
    mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Включает/меняет Auto Layout этой ноды как контейнера"),
    gap: z.number().optional().describe("itemSpacing между детьми"),
    padding: z.number().optional().describe("Одинаковый отступ со всех сторон"),
    paddingLeft: z.number().optional(),
    paddingRight: z.number().optional(),
    paddingTop: z.number().optional(),
    paddingBottom: z.number().optional(),
    primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
    sizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Как эта нода ведёт себя как ребёнок auto-layout родителя"),
    sizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  })
  .optional()
  .describe("Auto Layout — задаёт поведение этой ноды как контейнера и/или как ребёнка auto-layout родителя");

const styleFields = {
  fills: z.array(z.any()).optional().describe("Массив Paint как в Figma Plugin API"),
  strokes: z.array(z.any()).optional().describe("Массив Paint для обводки"),
  strokeWeight: z.number().optional(),
  cornerRadius: z.number().optional(),
  effects: z.array(z.any()).optional().describe("Массив Effect (тени и т.п.) как в Figma Plugin API"),
  typography: typographySchema,
  layout: layoutSchema,
};

const operationIdField = z
  .string()
  .optional()
  .describe("Если передан — повторный вызов с тем же значением вернёт закэшированный результат вместо повторного выполнения. Используй при ретраях после таймаута.");

/**
 * MCP-инструменты фазы 2 (Plugin Bridge). Требуют запущенного плагина на
 * открытом файле в Figma Desktop — см. memory/plugin-bridge/.
 */
export function createPluginTools(bridge: BridgeServer) {
  return [
    {
      name: "get_plugin_status",
      description:
        "Проверяет, подключён ли плагин Guddion Figma Bridge и на каком файле (нужно перед использованием write_node / get_variables).",
      inputSchema: {},
      handler: async () => {
        return {
          connected: bridge.isConnected(),
          file: bridge.getPluginInfo(),
          bridgeError: bridge.getBindError(),
        };
      },
    },

    {
      name: "get_variables",
      description:
        "Возвращает локальные Figma variables (design tokens) и их коллекции из открытого в Figma Desktop файла. Работает через плагин, доступно независимо от плана Figma (REST Variables API требует Enterprise).",
      inputSchema: {},
      handler: async () => {
        return bridge.call("get_variables");
      },
    },

    {
      name: "export_tokens",
      description:
        "Выгружает локальные Figma variables в DTCG JSON и CSS custom properties (по первому mode каждой коллекции, ссылки между переменными резолвятся в алиасы). Без outputDir возвращает содержимое файлов в ответе, с outputDir — пишет tokens.json и tokens.css на диск.",
      inputSchema: {
        outputDir: z.string().optional().describe("Папка для tokens.json и tokens.css; создаётся при необходимости"),
      },
      handler: async ({ outputDir }: { outputDir?: string }) => {
        const payload = (await bridge.call("get_variables")) as VariablesPayload;
        const { dtcg, css } = buildTokenExports(payload);

        if (!outputDir) return { dtcg, css };

        await mkdir(outputDir, { recursive: true });
        const dtcgPath = join(outputDir, "tokens.json");
        const cssPath = join(outputDir, "tokens.css");
        await writeFile(dtcgPath, JSON.stringify(dtcg, null, 2));
        await writeFile(cssPath, css);
        return { dtcgPath, cssPath };
      },
    },

    {
      name: "get_selection",
      description: "Возвращает id/имя/тип нод, выделенных сейчас на холсте в Figma Desktop.",
      inputSchema: {},
      handler: async () => {
        return bridge.call("get_selection");
      },
    },

    {
      name: "find_node",
      description:
        "Ищет ноды в открытом файле по имени (подстрока, без учёта регистра) и/или типу. Возвращает id, чтобы передать его в update_node/delete_node/write_node без ручного копирования ссылки из Figma.",
      inputSchema: {
        query: z.string().optional().describe("Подстрока имени ноды для поиска"),
        type: z.string().optional().describe("Фильтр по типу ноды, например FRAME, TEXT, COMPONENT"),
        parentNodeId: z.string().optional().describe("Если не задан — ищет по всей текущей странице"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("find_node", params);
      },
    },

    {
      name: "write_node",
      description:
        "Создаёт ноду (FRAME, RECTANGLE или TEXT) в открытом файле Figma через плагин — с поддержкой fills/strokes/cornerRadius/effects, типографики и Auto Layout. Для компонентов и инстансов используй create_instance. REST API Figma не поддерживает запись — только Plugin Bridge.",
      inputSchema: {
        type: z.enum(["FRAME", "RECTANGLE", "TEXT"]),
        name: z.string().optional(),
        parentNodeId: z.string().optional().describe("Если не задан — нода создаётся на текущей странице"),
        x: z.number().default(0),
        y: z.number().default(0),
        width: z.number().default(100),
        height: z.number().default(100),
        text: z.string().optional().describe("Текст для type=TEXT"),
        ...styleFields,
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("write_node", rest, operationId as string | undefined);
      },
    },

    {
      name: "update_node",
      description:
        "Меняет свойства существующей ноды: имя, позицию, размер, fills/strokes/cornerRadius/effects, видимость, прозрачность, текст и типографику (для TEXT), Auto Layout. Передавай только те поля, которые нужно изменить.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды, которую меняем"),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        visible: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
        text: z.string().optional().describe("Новый текст, только для type=TEXT"),
        ...styleFields,
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("update_node", rest, operationId as string | undefined);
      },
    },

    {
      name: "get_node",
      description: "Точечно читает одну ноду по id: имя, тип, позицию, размер, родителя. Используй сразу после write_node/clone_node, чтобы подтвердить, что нода реально создалась там, где просили.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("get_node", params);
      },
    },

    {
      name: "delete_node",
      description: "Удаляет ноду из открытого файла Figma по id.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды для удаления"),
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("delete_node", rest, operationId as string | undefined);
      },
    },

    {
      name: "clone_node",
      description: "Клонирует ноду, опционально в другого родителя и на новую позицию.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды для клонирования"),
        parentNodeId: z.string().optional().describe("Если не задан — клон остаётся в том же родителе"),
        x: z.number().optional(),
        y: z.number().optional(),
        name: z.string().optional(),
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("clone_node", rest, operationId as string | undefined);
      },
    },

    {
      name: "move_node",
      description: "Перемещает существующую ноду — меняет родителя и/или позицию x/y.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды для перемещения"),
        parentNodeId: z.string().optional().describe("Новый родитель; если не задан — родитель не меняется"),
        x: z.number().optional(),
        y: z.number().optional(),
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("move_node", rest, operationId as string | undefined);
      },
    },

    {
      name: "create_instance",
      description:
        "Создаёт инстанс компонента — локального (componentNodeId) или из этого же файла по key из get_components (componentKey) — и размещает на холсте. write_node компоненты не создаёт, только FRAME/RECTANGLE/TEXT.",
      inputSchema: {
        componentKey: z.string().optional().describe("key компонента из get_components"),
        componentNodeId: z.string().optional().describe("id локального COMPONENT-узла, например из find_node"),
        parentNodeId: z.string().optional().describe("Если не задан — инстанс создаётся на текущей странице"),
        x: z.number().default(0),
        y: z.number().default(0),
        name: z.string().optional(),
        operationId: operationIdField,
      },
      handler: async (params: Record<string, unknown>) => {
        const { operationId, ...rest } = params;
        return bridge.call("create_instance", rest, operationId as string | undefined);
      },
    },

    {
      name: "set_variable",
      description:
        "Устанавливает значение Figma variable для конкретного режима (mode). Используй get_variables, чтобы узнать variableId и modeId.",
      inputSchema: {
        variableId: z.string(),
        modeId: z.string(),
        value: z.any().describe("Новое значение — тип зависит от resolvedType переменной (COLOR/FLOAT/STRING/BOOLEAN)"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("set_variable", params);
      },
    },

    {
      name: "set_variable_binding",
      description:
        "Привязывает Figma variable к свойству ноды (а не просто копирует текущее значение) — так значение остаётся живым при смене mode. Для fills/strokes указывай paintIndex (по умолчанию 0); для остальных полей (cornerRadius, opacity, itemSpacing, paddingLeft и т.п.) — просто field.",
      inputSchema: {
        nodeId: z.string(),
        field: z.string().describe("Например: fills, strokes, cornerRadius, opacity, itemSpacing, paddingLeft"),
        variableId: z.string(),
        paintIndex: z.number().int().min(0).optional().describe("Индекс в массиве fills/strokes, только если field — fills или strokes"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("set_variable_binding", params);
      },
    },
  ];
}
