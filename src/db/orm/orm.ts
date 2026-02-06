import type { Table } from "./table";
import { Repository } from "./repository";
import { Upgrade } from "./upgrade";
import { QueryBuilder } from "./queryBuilder/query";
import type { ColumnInfer } from "./table";
import type { DatabaseAdapter, LoggerAdapter } from "./adapter";

export interface SqliteORMOptions<T extends Table[]> {
  name: string;
  tables: T;
  version: number;
  dbAdapter: DatabaseAdapter.IAdapter;
  loggerAdapter: LoggerAdapter.IAdapter;
}
function isPositiveInt(num: number) {
  const isDecimal = num % 1 !== 0;
  if (isDecimal) {
    return false;
  }
  return num > 0;
}
export class SqliteORM<T extends Table[]> {
  public logger: LoggerAdapter.IAdapter 
  public version: number;
  public tables: T;
  public upgrade: Upgrade<T>;
  public dbAdapter: DatabaseAdapter.IAdapter;
  public name: string;

  constructor(options: SqliteORMOptions<T>) {
    if (isPositiveInt(options.version) === false) {
      throw new Error("version must be an integer greater than 0");
    }
    this.version = options.version;
    this.tables = options.tables;
    this.dbAdapter = options.dbAdapter;
    this.logger = options.loggerAdapter.scope("ORM");
    this.name = options.name;
    this.upgrade = new Upgrade(this);
  }

  async connect() {
    try {
      await this.dbAdapter.connect(this.name);
      await this.upgrade.init();
      return true;
    } catch (error) {
      await this.dbAdapter.disconnect();
      this.logger.error("Failed to install OPFS VFS:", error);
      return false;
    }
  }

  findTable<N extends T[number]["name"]>(name: N): Extract<T[number], { name: N }> {
    const table = this.tables.find((table) => table.name === name) as Extract<T[number], { name: N }>;
    if (!table) {
      throw new Error(`Table ${name} not found`);
    }
    return table;
  }

  getRepository<N extends T[number]["name"]>(name: N) {
    const table = this.findTable(name);
    return Repository.create(table, this as any);
  }

  dispose = async () => {
    Repository.insMap.clear()
    await this.dbAdapter.disconnect();
  };

  async exec<R>(sql: string, params: any[]) {
    try {
      const startTime = performance.now();
      const result = await this.dbAdapter.execute(sql, params);
      this.logger
        .info("Exec:\n", {
          sql,
          bind: params,
          result,
          time: performance.now() - startTime,
        })
      return result as R;
    } catch (error) {
      this.logger.error(`Exec :${sql}`, error);
      throw error;
    }
  }

  callRepo<N extends T[number]["name"]>(name: N) {
    return this.getRepository(name);
  }

  /**
   * @param name 这里传递的`name`只是为了便捷的锁定表的类型，并不具备约束queryBuilder中表名的作用
   */
  getQueryBuilder<N extends T[number]["name"]>(name: N) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const table = this.findTable(name);
    const queryBuilder = new QueryBuilder<ColumnInfer<(typeof table)["columns"]>>();
    return queryBuilder;
  }
}
