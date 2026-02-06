export namespace DatabaseAdapter {

    export interface ISqlitePrepare {
        run: (params?: any[]) => Promise<boolean>;
        get: (params?: any[]) => Promise<any>;
        all: (params?: any[]) => Promise<any[]>;
    }

    export type SQLList = {
        sql: string;
        params?: any[];
    }[];

    export interface IAdapter {
        connect: (path: string) => Promise<void>;
        disconnect: () => Promise<void>;
        execute: <T>(sql: string, params?: any[]) => Promise<T>;
        // prepare: (sql: string) => Promise<ISqlitePrepare>;
        // checkpoint: () => Promise<void>;
        transaction: (sqlList: SQLList) => Promise<any>;
    }

    export enum ErrorCode {
        TIMEOUT = -1,
        WORKER_ERROR = -2,
        RPC_INVALID_REQUEST = -32600,
    }

}

export namespace LoggerAdapter {
    export interface IAdapter {
        scope(name: string): IAdapter
        info(...messages: any[]): void;
        error(...messages: any[]): void;
        warn(...messages: any[]): void;
    }
}