import type { Prettier } from "../../utils.type";
import type { ColumnOptional, ColumnParams, ColumnPrimary, ColumnType } from "./column";

/**
 * 从Column对象中提取Typescript类型
 */
export type ColumnInfer<T extends Record<string, ColumnType>> = Prettier<
  {
    [K in keyof T as T[K] extends ColumnOptional<ColumnType> ? never : K]: T[K]["__type"];
  } & {
    [K in keyof T as T[K] extends ColumnOptional<ColumnType> ? K : never]?: T[K]["__type"];
  }
>;

/**
 * 从Column对象中提取更新类型
 * 主键必填，其他字段可选
 * 用于更新操作，确保至少提供主键用于冲突检测
 */
export type ColumnUpdateInfer<T extends Record<string, ColumnType>> = Prettier<
  {
    [K in keyof T as T[K] extends ColumnPrimary<any> ? K : never]: T[K]["__type"];
  } & {
    [K in keyof T as T[K] extends ColumnPrimary<any> ? never : K]?: T[K]["__type"];
  }
>;

/**
 * 从Column对象中提取主键的key
 */
export type ColumnPrimaryKeyInfer<T extends Record<string, ColumnType>> = {
  [K in keyof T]: T[K] extends ColumnPrimary<any> ? K : never;
}[keyof T];

export interface IndexDesc<T extends string = string> {
  unique?: T[];
  index?: T[];
  composite?: {
    [index: string]: T[];
  };
}

type GetIndexFn<T> = () => IndexDesc<keyof T & string>;

type TableColumns<T extends Record<string, ColumnType>> = T;
export class Table<N extends string = any, T extends Record<string, ColumnType> = any> {
  public name: N;
  public columns: TableColumns<T>;
  public getIndex: GetIndexFn<T> | undefined = undefined;

  constructor(name: N, columns: T, getIndex?: GetIndexFn<T>) {
    this.name = name;
    this.columns = columns;
    this.getIndex = getIndex;
  }

  toJSON() {
    const result: Record<string, ColumnParams> = {};
    Object.entries(this.columns).forEach(([name, column]) => {
      result[name] = column.toJSON();
    });
    return result;
  }

  private genCreateIndexSql() {
    if (!this.getIndex) {
      return "";
    }
    const { composite = [], index = [], unique = [] } = this.getIndex();

    //如果index和unique中有相同的字段，报错
    const conflict = index.filter((i) => unique.includes(i));
    if (conflict.length > 0) {
      throw new Error(`index and unique has conflict column: ${conflict}`);
    }
    const indexSql = [...index].map(
      (colName) => `CREATE INDEX IF NOT EXISTS idx_${this.name}_${colName} ON ${this.name} (${colName});`,
    );
    const uniqueSql = unique.map(
      (colName) => `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.name}_${colName} ON ${this.name} (${colName});`,
    );
    const compositeSql = Object.entries(composite).map(([indexName, cols]) => {
      return `CREATE INDEX IF NOT EXISTS idx_${this.name}_${indexName} ON ${this.name} (${cols.join(",")});`;
    });
    return "\n" + [...indexSql, ...uniqueSql, ...compositeSql].join("\n");
  }

  genCreateSql() {
    const columns = Object.entries(this.columns).map(([name, column]) => {
      const columnDesc = column.unwrap();
      const sql = columnDesc.genCreateSql();
      sql.unshift(name);
      return sql.join(" ");
    });

    const createTableSql = `CREATE TABLE IF NOT EXISTS ${this.name} (${columns.join(", ")});`;
    const indexSql = this.genCreateIndexSql();
    return createTableSql + indexSql;
  }
}

/**
 * @param name 表名
 * @param columns 列
 * @param getIndex 返回索引描述对象
 */
export function table<N extends string, T extends Record<string, ColumnType>>(
  name: N,
  columns: T,
  getIndex?: GetIndexFn<T>,
) {
  return new Table<N, T>(name, columns, getIndex);
}
