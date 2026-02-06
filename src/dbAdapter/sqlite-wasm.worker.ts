import sqlite3InitModule, {
  type OpfsSAHPoolDatabase,
  type PreparedStatement,
  type SAHPoolUtil,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type { JsonRpcId } from "./rpc";
import type { SQLList } from "./base";

console.log("sqlite wasm worker started");

let modulePromise = sqlite3InitModule({
  print: console.log,
  printErr: console.error,
});

function normalizePath(path: string) {
  const segments = path.split("/").filter(Boolean);
  let filename = segments.pop();
  if (!filename) {
    filename = "def_filename.sqlite";
  }
  const extIndex = filename.lastIndexOf(".");
  if (extIndex !== -1) {
    filename = filename.slice(0, extIndex);
  }
  const dirName = segments.join("_");

  return {
    dirName: dirName !== "" ? dirName : "def",
    filename,
  };
}

function postErrorResponse(id: JsonRpcId, code: number, message: string, data?: any) {
  const errorResponse = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  };
  self.postMessage(errorResponse);
}

function postResultResponse(id: JsonRpcId, result: any) {
  const response = {
    jsonrpc: "2.0",
    id,
    result,
  };
  self.postMessage(response);
}

class SqliteWorkerHandler {
  connected = false;
  sqlite3: Sqlite3Static | null = null;
  poolUtil: SAHPoolUtil | null = null;
  db: OpfsSAHPoolDatabase | null = null;
  sqlToStmtMap: Map<string, PreparedStatement> = new Map();

  constructor() {
    console.log("SqliteWorkerHandler Constructor");
  }

  connect = async (path: string) => {
    if (this.connected) {
      throw new Error("Already connected to SQLite database");
    }
    const { dirName, filename } = normalizePath(path);
    console.log("Connecting to SQLite database at:", dirName, filename);
    this.sqlite3 = await modulePromise;
    this.poolUtil = await this.sqlite3.installOpfsSAHPoolVfs({
      name: dirName,
    });
    const { OpfsSAHPoolDb } = this.poolUtil;
    this.db = new OpfsSAHPoolDb(filename);
    this.db.exec("pragma locking_mode=exclusive");
    this.db.exec("PRAGMA journal_mode=WAL");

    if (this.db && this.db.isOpen && this.db.isOpen()) {
      this.connected = true;
    } else {
      throw new Error("Failed to connect to SQLite database");
    }
  };
  disconnect = async () => {
    if (!this.connected) return;
    try {
      if (this.db && typeof this.db.close === "function") {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const fileNames = this.poolUtil!.getFileNames();
        console.log("disconnect fileNames", fileNames);
        this.db.close();
      }
    } finally {
      this.db = null;
      this.poolUtil = null;
      this.sqlite3 = null;
      try {
        for (const [sql, stmt] of this.sqlToStmtMap.entries()) {
          stmt.finalize();
        }
      } finally {
        this.sqlToStmtMap.clear();
      }
      this.connected = false;
      console.log("Disconnected from SQLite database");
    }
  };
  execute = async (sql: string, params: any[]) => {
    if (!this.connected) {
      throw new Error("Not connected to SQLite database");
    }
    const db = this.db;
    if (!db) throw new Error("DB not available");
    const options: { rowMode: "object"; bind?: any[] } = {
      rowMode: "object",
    };
    if (params && Array.isArray(params) && params.length) {
      options.bind = params;
    }

    const result = this.db!.exec(sql, options);
    return result;
  };
  checkpoint = async () => {
    if (!this.connected) {
      throw new Error("Not connected to SQLite database");
    }
    this.db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  };
  prepare = async (sql: string) => {
    if (!this.connected) {
      throw new Error("Not connected to SQLite database");
    }
    const existing = this.sqlToStmtMap.get(sql);
    if (existing) return existing;
    const db = this.db!;
    const stmt = db.prepare(sql);
    this.sqlToStmtMap.set(sql, stmt);
    return sql;
  };

  prepare_run = async (sql: string, params: any[]) => {
    const stmt = this.sqlToStmtMap.get(sql);
    throw new Error("暂时不支持");
  };

  prepare_get = async (sql: string, params: any[]) => {
    const stmt = this.sqlToStmtMap.get(sql);
    throw new Error("暂时不支持");
  };

  prepare_all = async (sql: string, params: any[]) => {
    const stmt = this.sqlToStmtMap.get(sql);
    throw new Error("暂时不支持");
  };

  transaction = async (sqlList: SQLList) => {
    if (!this.connected) {
      throw new Error("Not connected to SQLite database");
    }
    const db = this.db!;
    db.exec("BEGIN TRANSACTION");
    try {
      for (const { sql, params } of sqlList) {
        db.exec(sql, {
          bind: params,
          rowMode: "object",
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

const handler = new SqliteWorkerHandler();

self.addEventListener("message", async (event) => {
  const request = event.data;

  if (!request || request.jsonrpc !== "2.0" || !request.method) {
    postErrorResponse(request?.id ?? null, -32600, "Invalid Request", request);
    return;
  }
  const params = Array.isArray(request.params) ? request.params : [];
  try {
    let result;
    switch (request.method) {
      case "connect":
        result = await handler.connect(params[0]);
        break;
      case "disconnect":
        result = await handler.disconnect();
        break;
      case "execute":
        result = await handler.execute(params[0], params[1]);
        break;
      case "prepare":
        result = await handler.prepare(params[0]);
        break;
      case "prepare_run":
        result = await handler.prepare_run(params[0], params[1]);
        break;
      case "prepare_get":
        result = await handler.prepare_get(params[0], params[1]);
        break;
      case "prepare_all":
        result = await handler.prepare_all(params[0], params[1]);
        break;
      case "transaction":
        result = await handler.transaction(params[0]);
        break;
      case "checkpoint":
        result = await handler.checkpoint();
        break;
      default:
        postErrorResponse(request.id ?? null, -32601, `Method not found: ${request.method}`);
        return;
    }
    postResultResponse(request.id, result);
  } catch (error) {
    //@ts-ignore
    postErrorResponse(request.id ?? null, error?.code ?? -32603, error?.message ?? "Internal error", error);
  }
});

self.addEventListener("error", (error) => {
  console.error("Worker error:", error);
});

self.addEventListener("unhandledrejection", (event) => {
  console.error("Worker unhandled rejection:", event.reason);
});
