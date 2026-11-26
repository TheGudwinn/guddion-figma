import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
}

export interface PluginInfo {
  fileKey: string | null;
  fileName: string;
  pageId?: string;
  pageName?: string;
  url: string | null;
}

/** Ошибка с машинно-читаемым кодом — агент может ветвиться по err.code, а не парсить текст. */
export class BridgeError extends Error {
  constructor(
    public code: "BRIDGE_NOT_RUNNING" | "PLUGIN_DISCONNECTED" | "CALL_TIMEOUT",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "BridgeError";
  }
}

const HEARTBEAT_INTERVAL_MS = 20_000;

function timeoutError(timeoutMs: number, command: string): BridgeError {
  return new BridgeError("CALL_TIMEOUT", `Plugin не ответил за ${timeoutMs}мс на команду "${command}"`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, command: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeoutMs, command)), timeoutMs);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Websocket-сервер для Plugin Bridge. Плагин Figma подключается к нему
 * через UI-iframe (у main thread плагина нет сетевого доступа — см.
 * memory/plugin-bridge/protocol.md). Один активный клиент одновременно,
 * leader/follower координация не нужна для нашего сценария.
 *
 * Держит keepalive пингами (браузерный WebSocket отвечает на ping pong'ом
 * автоматически, без участия кода плагина) — если клиент не ответил за
 * два цикла, считаем соединение мёртвым и закрываем его, чтобы плагин
 * переподключился, а не висел в псевдо-живом состоянии.
 */
export class BridgeServer {
  private wss: WebSocketServer;
  private client: (WebSocket & { isAlive?: boolean }) | null = null;
  private pluginInfo: PluginInfo | null = null;
  private pending = new Map<string, PendingCall>();
  private operations = new Map<string, Promise<unknown>>();
  private callTimeoutMs: number;
  private bindError: string | null = null;
  private heartbeat: NodeJS.Timeout;

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

    this.wss.on("connection", (ws: WebSocket & { isAlive?: boolean }) => {
      // Новый клиент заменяет предыдущего — в сценарии "один открытый файл" это ожидаемо.
      this.client = ws;
      ws.isAlive = true;
      console.error("[bridge] плагин подключился, жду hello...");

      ws.on("pong", () => {
        ws.isAlive = true;
      });

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
          this.rejectAllPending(new BridgeError("PLUGIN_DISCONNECTED", "Plugin отключился"));
        }
      });
    });

    this.heartbeat = setInterval(() => {
      if (!this.client) return;
      if (this.client.isAlive === false) {
        console.error("[bridge] плагин не ответил на ping, закрываю соединение для переподключения");
        this.client.terminate();
        return;
      }
      this.client.isAlive = false;
      this.client.ping();
    }, HEARTBEAT_INTERVAL_MS).unref();
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const fileKey = msg.fileKey ?? null;
      this.pluginInfo = {
        fileKey,
        fileName: msg.fileName,
        pageId: msg.pageId,
        pageName: msg.pageName,
        url: fileKey ? `https://www.figma.com/design/${fileKey}/${encodeURIComponent(msg.fileName ?? "")}` : null,
      };
      console.error(`[bridge] hello получен — файл: "${msg.fileName}" (${fileKey ?? "fileKey недоступен"})`);
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

  /**
   * operationId делает вызов идемпотентным: повторный call с тем же
   * operationId вернёт результат первой попытки вместо повторной записи — даже
   * если та отвалилась по CALL_TIMEOUT, а плагин ответил (или ещё ответит) позже.
   */
  async call(
    command: string,
    params: Record<string, unknown> = {},
    operationId?: string,
    timeoutMs: number = this.callTimeoutMs
  ): Promise<unknown> {
    let result = operationId ? this.operations.get(operationId) : undefined;

    if (!result) {
      if (this.bindError) {
        throw new BridgeError("BRIDGE_NOT_RUNNING", `Bridge-сервер не запущен: ${this.bindError}`);
      }
      if (!this.isConnected() || !this.client) {
        throw new BridgeError(
          "PLUGIN_DISCONNECTED",
          "Plugin не подключён. Открой нужный файл в Figma Desktop и запусти плагин Guddion Figma Bridge."
        );
      }
      result = this.send(this.client, command, params, operationId ? undefined : timeoutMs);
      if (operationId) {
        this.operations.set(operationId, result);
        // Неудачную операцию забываем, чтобы повтор действительно выполнился.
        result.catch(() => this.operations.delete(operationId));
      }
    }

    return withTimeout(result, timeoutMs, command);
  }

  /**
   * Без timeoutMs запрос ждёт ответа плагина до разрыва соединения — так поздний
   * ответ на операцию с operationId не теряется.
   */
  private send(
    client: WebSocket,
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(timeoutError(timeoutMs, command));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      client.send(JSON.stringify({ id, command, params }));
    });
  }

  close() {
    clearInterval(this.heartbeat);
    this.rejectAllPending(new BridgeError("PLUGIN_DISCONNECTED", "Bridge-сервер остановлен"));
    this.wss.close();
  }
}
