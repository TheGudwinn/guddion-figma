import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface PluginInfo {
  fileKey: string;
  fileName: string;
}

/**
 * Websocket-сервер для Plugin Bridge. Плагин Figma подключается к нему
 * через UI-iframe (у main thread плагина нет сетевого доступа — см.
 * memory/plugin-bridge/protocol.md). Один активный клиент одновременно,
 * leader/follower координация не нужна для нашего сценария.
 */
export class BridgeServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private pluginInfo: PluginInfo | null = null;
  private pending = new Map<string, PendingCall>();
  private callTimeoutMs: number;
  private bindError: string | null = null;

  constructor(port: number, callTimeoutMs = 10_000) {
    this.callTimeoutMs = callTimeoutMs;
    this.wss = new WebSocketServer({ port });

    // Без этого обработчика ошибка биндинга (например EADDRINUSE, если порт
    // уже занят другим запущенным сервером) убивает весь процесс необработанным
    // исключением — а REST-инструменты от bridge вообще не зависят.
    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      this.bindError =
        err.code === "EADDRINUSE"
          ? `порт ${port} уже занят другим процессом (например, запущенным вручную "npm start"). Останови его и перезапусти guddion-figma.`
          : err.message;
      console.error(`[bridge] не удалось запустить websocket-сервер: ${this.bindError}`);
    });

    this.wss.on("connection", (ws) => {
      // Новый клиент заменяет предыдущего — в сценарии "один открытый файл" это ожидаемо.
      this.client = ws;
      console.error("[bridge] плагин подключился, жду hello...");

      ws.on("message", (raw) => {
        this.handleMessage(raw.toString());
      });

      ws.on("close", () => {
        if (this.client === ws) {
          console.error(
            `[bridge] плагин отключился${this.pluginInfo ? ` (файл: ${this.pluginInfo.fileName})` : ""}`
          );
          this.client = null;
          this.pluginInfo = null;
          this.rejectAllPending(new Error("Plugin отключился"));
        }
      });
    });
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      this.pluginInfo = { fileKey: msg.fileKey, fileName: msg.fileName };
      console.error(`[bridge] hello получен — файл: "${msg.fileName}" (${msg.fileKey})`);
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(msg.id);

    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error ?? "Plugin вернул ошибку без описания"));
  }

  private rejectAllPending(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  getBindError(): string | null {
    return this.bindError;
  }

  getPluginInfo(): PluginInfo | null {
    return this.pluginInfo;
  }

  async call(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.bindError) {
      throw new Error(`Bridge-сервер не запущен: ${this.bindError}`);
    }
    if (!this.isConnected() || !this.client) {
      throw new Error(
        "Plugin не подключён. Открой нужный файл в Figma Desktop и запусти плагин Guddion Figma Bridge (см. memory/plugin-bridge/)."
      );
    }

    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin не ответил за ${this.callTimeoutMs}мс на команду "${command}"`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });

    this.client.send(JSON.stringify({ id, command, params }));
    return promise;
  }

  close() {
    this.rejectAllPending(new Error("Bridge-сервер остановлен"));
    this.wss.close();
  }
}
