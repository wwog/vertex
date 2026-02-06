/* npm:@sqlite.org/sqlite-wasm */
import { DatabaseAdapter } from "../db/orm/adapter";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc";

// 请求状态管理接口
interface PendingRequest {
  resolve: (response: any) => void;
  reject: (error: any) => void;
  timer: NodeJS.Timeout;
}

// 预处理语句实现
class SqliteWasmPrepare implements DatabaseAdapter.ISqlitePrepare {
  public sql: string;
  constructor(
    private adapter: SqliteWasmAdapter,
    sql: string,
  ) {
    this.sql = sql;
  }

  run = async (params?: any[]): Promise<any> => {
    return this.adapter._call("prepare_run", [this.sql, params ?? []]);
  };

  get = async (params?: any[]): Promise<any> => {
    return this.adapter._call("prepare_get", [this.sql, params ?? []]);
  };

  all = async (params?: any[]): Promise<any[]> => {
    return this.adapter._call("prepare_all", [this.sql, params ?? []]);
  };
}

export interface SqliteWasmOptions {
  timeout?: number; // 请求超时时间（毫秒）
  worker: Worker; // Worker脚本URL
}

export class SqliteWasmAdapter implements DatabaseAdapter.IAdapter {
  private worker!: Worker;
  private requestCounter = 0;
  private readonly requestPrefix: string;
  private pendingRequests = new Map<string, PendingRequest>();
  private timedOutRequests = new Set<string>();
  private preparedStatements = new Map<string, SqliteWasmPrepare>();
  private isDisposed = false;
  private options: Required<SqliteWasmOptions>;

  constructor(options: SqliteWasmOptions) {
    this.options = {
      timeout: 60_000,
      ...options,
    };
    this.worker = options.worker;
    this.requestPrefix = Math.random().toString(16).substring(2, 6) + "-";

    this.initializeWorker();
  }

  /**
   * 初始化Web Worker
   */
  private initializeWorker(): void {
    console.log("debug", this.worker);
    this.worker.addEventListener("message", this.handleWorkerMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  /**
   * 生成唯一的请求ID
   */
  private generateRequestId(): string {
    if (this.requestCounter >= Number.MAX_SAFE_INTEGER) {
      this.requestCounter = 0;
    }
    return this.requestPrefix + this.requestCounter++;
  }

  /**
   * 处理Worker消息
   */
  private handleWorkerMessage = (event: MessageEvent<JsonRpcResponse<any>>): void => {
    const response = event.data;

    // 忽略没有ID的通知消息
    if (response.id === null || response.id === undefined) {
      return;
    }

    if (typeof response.id === "number") {
      console.error(`意外的响应ID类型: ${typeof response.id}`);
      return;
    }

    // 处理超时请求的延迟响应
    if (this.timedOutRequests.has(response.id)) {
      this.timedOutRequests.delete(response.id);
      return;
    }

    // 处理正常请求响应
    const pendingRequest = this.pendingRequests.get(response.id);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timer);
      this.pendingRequests.delete(response.id);

      if (response.error) {
        pendingRequest.reject(response.error);
      } else {
        pendingRequest.resolve(response.result);
      }
    } else {
      console.warn(`收到未处理的响应: ${JSON.stringify(response)}`);
    }
  };

  /**
   * 处理Worker错误
   */
  private handleWorkerError = (error: ErrorEvent): void => {
    console.error("Worker错误:", error.message);
    this.dispose("Worker发生错误");
  };

  /**
   * 发送请求到Worker
   */
  public async _call<T>(method: string, params: any[] = []): Promise<T> {
    if (this.isDisposed) {
      throw new Error("适配器已被释放");
    }

    return new Promise<T>((resolve, reject) => {
      const id = this.generateRequestId();

      const timer = setTimeout(() => {
        this.timedOutRequests.add(id);
        this.pendingRequests.delete(id);
        reject({
          code: DatabaseAdapter.ErrorCode.TIMEOUT,
          message: `请求超时 (${this.options.timeout}ms)`,
        });
      }, this.options.timeout);

      // 保存请求信息
      this.pendingRequests.set(id, {
        resolve: (result: T) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });

      // 发送消息到Worker
      const message: JsonRpcRequest<any[]> = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.worker.postMessage(message);
    });
  }

  /**
   * 释放所有资源
   */
  private dispose(reason = "适配器被释放"): void {
    if (this.isDisposed) return;

    this.isDisposed = true;

    // 拒绝所有待处理的请求
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject({
        code: DatabaseAdapter.ErrorCode.WORKER_ERROR,
        message: reason,
      });
    });

    // 清理所有状态
    this.pendingRequests.clear();
    this.timedOutRequests.clear();
    this.preparedStatements.clear();
  }

  // 公共API方法
  connect = async (path: string): Promise<void> => {
    return this._call<void>("connect", [path]);
  };

  disconnect = async (): Promise<void> => {
    this.dispose("连接已断开");
    await this._call<void>("disconnect");
  };

  checkpoint = async () => {
    return this._call<void>("checkpoint");
  };

  transaction = async <T>(sqlList: DatabaseAdapter.SQLList) => {
    return this._call<T>("transaction", [sqlList]);
  };

  execute = async <T>(sql: string, params?: any[]): Promise<T> => {
    return this._call<T>("execute", [sql, params]);
  };

  prepare = async (sql: string): Promise<DatabaseAdapter.ISqlitePrepare> => {
    if (this.preparedStatements.has(sql)) {
      return this.preparedStatements.get(sql)!;
    }

    await this._call<string>("prepare", [sql]);
    const statement = new SqliteWasmPrepare(this, sql);
    this.preparedStatements.set(sql, statement);

    return statement;
  };
}
