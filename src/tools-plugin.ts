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
  ];
}
