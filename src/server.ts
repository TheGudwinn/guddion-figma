#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaClient } from "./figma-client.js";
import { createTools } from "./tools.js";
import { BridgeServer } from "./bridge-server.js";
import { createPluginTools } from "./tools-plugin.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = process.env.FIGMA_TOKEN;
if (!token) {
  console.error(
    "FIGMA_TOKEN не задан. Создай .env на основе .env.example и укажи Personal Access Token."
  );
  process.exit(1);
}

const bridgePort = Number(process.env.FIGMA_BRIDGE_PORT ?? 9684);
const cacheTtlMs = Number(process.env.FIGMA_CACHE_TTL_MS ?? 5 * 60 * 1000);
const client = new FigmaClient({ token, cacheTtlMs });
const bridge = new BridgeServer(bridgePort);

const server = new McpServer({
  name: "guddion-figma",
  version: "1.0.0",
});

const allTools = [...createTools(client), ...createPluginTools(bridge)];

for (const tool of allTools) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema as any },
    async (args: any) => {
      try {
        const result = await tool.handler(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Ошибка: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

for (const [name, filename] of [
  ["skill", "SKILL.md"],
  ["cookbook", "COOKBOOK.md"],
] as const) {
  const uri = `skill://guddion-figma/${filename}`;
  server.registerResource(
    name,
    uri,
    { title: filename, description: `${filename} — инструкция по использованию инструментов Guddion Figma`, mimeType: "text/markdown" },
    async () => ({
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: readFileSync(join(projectRoot, filename), "utf-8"),
        },
      ],
    })
  );
}

console.error(`Plugin Bridge слушает ws://localhost:${bridgePort}`);

client
  .getMe()
  .then((me) => console.error(`Figma-токен валиден (аккаунт: ${me.handle ?? me.email ?? "?"})`))
  .catch((err) =>
    console.error(
      `Не удалось проверить FIGMA_TOKEN при старте (REST-инструменты скорее всего не заработают): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  );

const transport = new StdioServerTransport();
await server.connect(transport);
