import { z } from "zod";
import { BridgeServer } from "./bridge-server.js";

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
        "Создаёт ноду (FRAME, RECTANGLE или TEXT) в открытом файле Figma через плагин. REST API Figma не поддерживает запись — только Plugin Bridge.",
      inputSchema: {
        type: z.enum(["FRAME", "RECTANGLE", "TEXT"]),
        name: z.string().optional(),
        parentNodeId: z.string().optional().describe("Если не задан — нода создаётся на текущей странице"),
        x: z.number().default(0),
        y: z.number().default(0),
        width: z.number().default(100),
        height: z.number().default(100),
        text: z.string().optional().describe("Текст для type=TEXT"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("write_node", params);
      },
    },

    {
      name: "update_node",
      description:
        "Меняет свойства существующей ноды: имя, позицию, размер, fills, видимость, прозрачность, текст (для TEXT-нод). Передавай только те поля, которые нужно изменить.",
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
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("update_node", params);
      },
    },

    {
      name: "delete_node",
      description: "Удаляет ноду из открытого файла Figma по id.",
      inputSchema: {
        nodeId: z.string().describe("ID ноды для удаления"),
      },
      handler: async (params: Record<string, unknown>) => {
        return bridge.call("delete_node", params);
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
  ];
}
