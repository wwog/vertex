export type JsonRpcVersion = "2.0";

/**
 * null is intended for 1.0 and is avoided
 */
export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export type JsonRpcParams = any[] | Record<string, any>;

export interface JsonRpcRequest<P extends JsonRpcParams> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<T> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  result?: T | null;
  error?: JsonRpcError;
}

// //ttl防止任务堆积,timeout防止无限等待(内存泄漏)
// export type RpcOpts = {
//   priority?: number;
//   /**
//    * 任务在队列中允许存在的最长时间，超过就丢弃。任务在被执行前的存活时间。是 Worker 内部调度用的。
//    * 一旦任务被取出来执行，ttl 不再起作用（除非你在执行阶段额外做执行超时）。
//    */
//   ttl?: number;
//   /**
//    *  等待调用结果的最大时间，超过就认为失败,针对整个调用过程（发请求 → 执行 → 收到响应），是调用方设置的。
//    */
//   timeout?: number;
//   // 暂时不考虑利用transferable来传输数据，目的是先保证wasm和node一致性的最小化封装
//   // transferable?: Transferable[];
// };
