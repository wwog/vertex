import { Logger } from '../../utils';
import type { SqliteWasmORM } from '../orm';
import { removeTimezone } from '../utils';
import type { ColumnType } from './column';
import type { OrderByType, SQLWithBindings } from './queryBuilder/lib';
import { QueryBuilder } from './queryBuilder/lib';
import {
  type Table,
  type ColumnInfer,
  type KernelColumnsKeys,
  kernelColumnsKeys,
} from './table';

export interface RemoveOptions {
  /**
   * @description 是否硬删除,默认软删除
   * @description_en Whether to hard delete, default is soft delete
   */
  isHardDelete?: boolean;
  /**
   * @description 限制删除的数量
   * @description_en Limit the number of deletions
   */
  limit?: number;
}

export interface ColClause<T = any> {
  /** === */
  equal?: T | T[];
  /** !== */
  notEqual?: T | T[];
  /** < */
  lt?: number;
  /** > */
  gt?: number;
  /** <= */
  lte?: number;
  /** >= */
  gte?: number;
  /** like */
  like?: string;
  in?: any[];
  /** not in */
  notIn?: any[];
  /** null or not null */
  isNull?: boolean;
  /** between */
  between?: [any, any];
  /** not between */
  $notBetween?: [any, any];
  orderBy?: OrderByType;
}

const operatorsMap = {
  equal: '$eq',
  notEqual: '$ne',
  lt: '$lt',
  gt: '$gt',
  lte: '$lte',
  gte: '$gte',
  like: '$like',
  in: '$in',
  notIn: '$nin',
  between: '$between',
  notBetween: '$notBetween',
  isNull: '$null',
};

export interface QueryClauses {
  limit?: number;
  offset?: number;
}

export type QueryOneClauses = Omit<QueryClauses, 'limit'>;

type ColumnQuery<T extends Record<string, ColumnType>> = {
  [K in keyof T]?: ColClause | T[K]['__type'] | T[K]['__type'][];
};

export class Repository<T extends Table> {
  static insMap = new Map<string, Repository<Table>>();
  static create<T extends Table>(table: T, orm: SqliteWasmORM<[T]>) {
    const key = table.name;
    if (Repository.insMap.has(key)) {
      return Repository.insMap.get(key) as Repository<T>;
    }
    const ins = new Repository(table, orm);
    //@ts-ignore
    Repository.insMap.set(key, ins);
    return ins;
  }
  private logger: Logger;

  get name() {
    return this.table.name;
  }

  get columns() {
    return this.table.columns as Record<string, ColumnType>;
  }

  public primaryKey = 'rowid';
  public uniqueKeys: string[] = ['rowid'];

  private constructor(
    private table: T,
    private orm: SqliteWasmORM<[T]>,
  ) {
    this.logger = Logger.scope(`Repo_${table.name}`);
    this.logger.info('created').print();
    Object.entries(this.columns).forEach(([key, value]) => {
      if (value._primary) {
        this.primaryKey = key;
        this.uniqueKeys.push(this.primaryKey);
      }
    });
    if (table.getIndex) {
      this.uniqueKeys.push(...(table.getIndex().unique ?? []));
    }
  }

  private validateKernelCols(data: Partial<ColumnInfer<T['columns']>>) {
    const keys = Object.keys(data);
    for (const key of keys) {
      if (kernelColumnsKeys.includes(key as KernelColumnsKeys)) {
        throw new Error(`Cannot change kernel columns ${key}`);
      }
    }
  }

  private validateColumns(
    columns:
      | Partial<ColumnInfer<T['columns']>>
      | Partial<ColumnInfer<T['columns']>>[],
  ) {
    const _columns = Array.isArray(columns) ? [...columns] : [columns];
    const columnKeyMap: any = {};
    _columns.forEach((column) => {
      Object.entries(column).forEach(([key, value]) => {
        if (!this.columns[key]) {
          this.logger.warn(
            `The column '${key}' does not exist on table '${this.table.name}'.`,
          );
          delete column[key as keyof typeof column];
          return true;
        }
        const res = this.columns[key].verify(value);

        if (res.length > 0) {
          // 报错
          throw new Error(
            `Validation failed for column ${key}: ${res.join(', ')}, current value is ${value}`,
          );
        }
        if (columnKeyMap[key] === undefined) {
          columnKeyMap[key] = true;
        }
      });
    });

    return Object.keys(columnKeyMap);
  }

  private execSQLWithBindingList(SQLWithBindingsList: SQLWithBindings[]) {
    const result: any[] = [];
    this.orm.dbOriginal.transaction(() => {
      SQLWithBindingsList.forEach(([sql, bind]) => {
        try {
          const res = this.orm.exec(sql, { bind });
          if (Array.isArray(res)) {
            result.push(...res);
          } else {
            throw new Error(`no returning`);
          }
        } catch (error) {
          this.logger.error(`execSQLWithBindingList error: ${error}`).print();
          this.logger.error({ sql, bind }).print();
          throw error;
        }
      });
    });
    return result;
  }

  /**
   * @description 插入单条数据,内部调用`insertMany`,面对冲突会忽略
   * @description_en Insert a single item into the table, ignoring conflicts.
   * @param item
   */
  insert(item: ColumnInfer<T['columns']>) {
    this.insertMany([item]);
  }

  /**
   * @description 插入多条数据,面对冲突会忽略
   * @description_en Insert multiple items into the table, ignoring conflicts.
   * @param items
   * @returns
   */
  insertMany(items: ColumnInfer<T['columns']>[]) {
    if (items.length === 0) {
      return [];
    }
    this.validateColumns(items);
    const inserts = this.orm
      .getQueryBuilder(this.table.name)
      .insert(this.table.name)
      .values(items)
      .returning()
      .onConflict()
      .doNothing()
      .toSQL();
    const result = this.execSQLWithBindingList(inserts);
    return result;
  }

  /**
   * @description 插入单条数据,内部调用`upsertMany`,面对冲突会更新
   * @description Insert a single item into the table, updating conflicts.
   * @param item
   * @param conflictKey 可指定冲突的字段,省略冲突会导致sqlite检查所有唯一性约束，因此在某些情况下可能会有性能开销
   * @param conflictKey Specify the conflict field, omitting conflicts will cause sqlite to check all uniqueness constraints, which may have performance overhead.
   */
  upsert = (item: ColumnInfer<T['columns']>, conflictKey?: string) => {
    this.upsertMany([item], conflictKey);
  };

  /**
   * @description 插入多条数据,面对冲突会更新
   * @description_en Insert multiple items into the table, updating conflicts.
   * @param items
   * @param conflictKey 可指定冲突的字段,省略冲突会导致sqlite检查所有唯一性约束，因此在某些情况下可能会有性能开销
   * @param conflictKey Specify the conflict field, omitting conflicts will cause sqlite to check all uniqueness constraints, which may have performance overhead.
   * @returns
   */
  upsertMany(items: ColumnInfer<T['columns']>[], conflictKey?: string) {
    if (items.length === 0) {
      return [];
    }
    const columnKeys = this.validateColumns(items);
    const excluded = columnKeys.reduce((prev, curr) => {
      prev[curr] = `excluded.${curr}`;
      return prev;
    }, {} as any);

    const now = removeTimezone();
    const merge: any = { _updateAt: now };

    const inserts = this.orm
      .getQueryBuilder(this.table.name)
      .insert(this.table.name)
      .values(items)
      .returning()
      .onConflict(conflictKey as any)
      .doUpdate({
        excluded,
        merge,
      })
      .toSQL();

    const result = this.execSQLWithBindingList(inserts);
    return result;
  }

  /**
   * @description 批量更新数据, 用户可以指定唯一键,如果不指定唯一键,会使用主键
   * @description_en Bulk update data, the user can specify a unique key, if not specified, the primary key will be used.
   * @param items
   * @param uniqueKey
   */
  updateByUniqueKey(newData: ColumnInfer<T['columns']>[], uniqueKey?: string) {
    const primaryKey =
      uniqueKey ||
      Object.keys(this.columns).find((k) => this.columns[k]._primary);

    if (!primaryKey || !this.uniqueKeys.includes(primaryKey)) {
      throw new Error('No unique key found');
    }

    const now = removeTimezone();
    const updateQuery: SQLWithBindings[] = [];
    newData.forEach((item) => {
      const primaryValue = item[primaryKey as keyof ColumnInfer<T['columns']>];
      delete item[primaryKey as keyof ColumnInfer<T['columns']>];
      const query = this.orm
        .getQueryBuilder(this.table.name)
        .update(this.table.name, {
          ...item,
          _updateAt: now as any,
        })
        .where({
          [primaryKey]: primaryValue,
        } as any)
        .returning()
        .toSQL();

      updateQuery.push(query);
    });

    const updateResult = this.execSQLWithBindingList(updateQuery);
    return updateResult;
  }

  private _query(
    conditions: ColumnQuery<T['columns']>,
    queryClauses: QueryClauses = {},
  ) {
    const { orderBy, condition } = transformData(conditions);

    console.log('condition', condition);

    const query = this.orm
      .getQueryBuilder(this.table.name)
      .select()
      .from(this.table.name)
      .where(condition);

    if (this.primaryKey === 'rowid') {
      query.select('rowid');
    }

    if (Object.keys(orderBy).length > 0) {
      Object.entries(orderBy).forEach(([key, value]) => {
        query.orderBy(key as any, value);
      });
    }

    if (queryClauses.limit) {
      query.limit(queryClauses.limit);
    }
    if (queryClauses.offset) {
      query.offset(queryClauses.offset);
    }

    const result = this.execSQLWithBindingList([query.toSQL()]);
    return result;
  }

  query(
    conditions: ColumnQuery<T['columns']>,
    queryClauses?: QueryOneClauses,
  ): ColumnInfer<T['columns']> | undefined {
    const result = this._query(conditions, {
      limit: 1,
      offset: queryClauses?.offset,
    });

    return result[0];
  }

  queryMany(
    conditions: ColumnQuery<T['columns']>,
    queryClauses?: QueryClauses,
  ): ColumnInfer<T['columns']>[] {
    return this._query(conditions, {
      limit: queryClauses?.limit,
      offset: queryClauses?.offset,
    });
  }

  /**
   * 更新单条数据
   * @param conditions 筛选数据条件
   * @param newData 新数据
   * @returns
   */
  update(
    conditions: ColumnQuery<T['columns']>,
    newData: Partial<ColumnInfer<T['columns']>>,
  ) {
    return this._update(conditions, newData);
  }

  private _update(
    conditions: ColumnQuery<T['columns']>,
    newData: Partial<ColumnInfer<T['columns']>>,
  ) {
    const res = this._query(conditions, {
      limit: 1,
    });
    if (res.length === 0) {
      this.logger.info('No record found').print();
      return [];
    }

    this.validateKernelCols(newData);
    this.validateColumns(newData);

    const primaryValues = res.map((item) => item[this.primaryKey]);
    const now = removeTimezone();
    const updateQuery = this.orm
      .getQueryBuilder(this.table.name)
      .update(this.table.name, {
        ...newData,
        _updateAt: now as any,
      })
      .where({
        ...(primaryValues.length === 1
          ? { [this.primaryKey]: primaryValues[0] }
          : { [this.primaryKey]: { $in: primaryValues } }),
      } as any)
      .returning()
      .toSQL();

    const updateResult = this.execSQLWithBindingList([updateQuery]);
    return updateResult;
  }

  updateMany(
    conditions: ColumnQuery<T['columns']>,
    newData: Partial<ColumnInfer<T['columns']>>,
    options: {
      fast?: boolean;
    } = {
      fast: true,
    },
  ) {
    const { fast } = options;
    if (fast) {
      // 快速更新，不查询直接操作数据库
      return this._fastUpdateMany(conditions, newData);
    } else {
      // 先查询数据库，再更新
      return this._updateMany(conditions, newData);
    }
  }

  private _fastUpdateMany(
    conditions: ColumnQuery<T['columns']>,
    newData: Partial<ColumnInfer<T['columns']>>,
  ) {
    this.validateKernelCols(newData);
    // 验证新数据
    this.validateColumns(newData);

    const { condition, orderBy } = transformData(conditions);
    if (Object.keys(orderBy).length > 0) {
      throw new Error('orderBy is not supported in fastUpdate');
    }
    const now = removeTimezone();
    const updateQuery = this.orm
      .getQueryBuilder(this.table.name)
      .update(this.table.name, {
        ...newData,
        _updateAt: now as any,
      })
      .where(condition)
      .returning()
      .toSQL();
    const updateResult = this.execSQLWithBindingList([updateQuery]);
    return updateResult;
  }

  private _updateMany(
    conditions: ColumnQuery<T['columns']>,
    newData: Partial<ColumnInfer<T['columns']>>,
  ) {
    this.validateKernelCols(newData);
    // 验证新数据
    this.validateColumns(newData);
    // 查询满足条件的数据
    const res = this._query(conditions);
    if (res.length === 0) {
      this.logger.info('No record found').print();
      return [];
    }
    const primaryValues = res.map((item) => item[this.primaryKey]);
    const now = removeTimezone();
    const updateQuery = this.orm
      .getQueryBuilder(this.table.name)
      .update(this.table.name, {
        ...newData,
        _updateAt: now as any,
      })
      .where({
        ...(primaryValues.length === 1
          ? { [this.primaryKey]: primaryValues[0] }
          : { [this.primaryKey]: { $in: primaryValues } }),
      } as any)
      .returning()
      .toSQL();
    const updateResult = this.execSQLWithBindingList([updateQuery]);
    return updateResult;
  }

  /**
   * 删除数据
   * @param conditions 筛选数据条件
   * @param options 删除选项
   * @returns
   */
  remove(
    conditions: ColumnQuery<T['columns']>,
    options: RemoveOptions = {
      isHardDelete: false,
      limit: undefined,
    },
  ) {
    const { isHardDelete, limit } = options;
    const { orderBy, condition } = transformData(conditions);
    const now = removeTimezone();
    const queryBuilder = new QueryBuilder<{
      _deleteAt: string;
      _updateAt: string;
    }>();

    const _selectQuery = queryBuilder
      .select('*')
      .from(this.table.name)
      .where(condition);
    if (this.primaryKey === 'rowid') {
      _selectQuery.select('rowid');
    }
    if (orderBy) {
      Object.entries(orderBy).forEach(([key, value]) => {
        _selectQuery.orderBy(key as any, value);
      });
    }
    if (limit) {
      _selectQuery.limit(limit);
    }
    const sql = _selectQuery.toSQL();
    const result = this.execSQLWithBindingList([sql]);
    if (result.length === 0) {
      return result;
    }
    const primaryValues = result.map((item) => item[this.primaryKey]);
    if (isHardDelete === false) {
      const updateQuery = queryBuilder
        .update(this.table.name, {
          _deleteAt: now as any,
          _updateAt: now as any,
        })
        .where({
          ...(primaryValues.length === 1
            ? { [this.primaryKey]: primaryValues[0] }
            : { [this.primaryKey]: { $in: primaryValues } }),
        })
        .returning();
      const updateSql = updateQuery.toSQL();
      const updateResult = this.execSQLWithBindingList([updateSql]);
      return updateResult;
    } else {
      const deleteQuery = queryBuilder
        .delete(this.table.name)
        .where({
          ...(primaryValues.length === 1
            ? { [this.primaryKey]: primaryValues[0] }
            : { [this.primaryKey]: { $in: primaryValues } }),
        })
        .returning();
      const deleteSql = deleteQuery.toSQL();
      const deleteResult = this.execSQLWithBindingList([deleteSql]);
      return deleteResult;
    }
  }
}

function transformData<T extends ColumnQuery<any>>(conditions: T) {
  const condition: Record<string, any> = {};
  const orderBy: Partial<Record<keyof typeof conditions, OrderByType>> = {};

  Object.entries(conditions).forEach(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      Object.entries(operatorsMap).forEach(([operator, sqlOperator]) => {
        if (value.hasOwnProperty(operator)) {
          condition[key] = condition[key] || {};
          condition[key][sqlOperator] = value[operator];
        }
      });

      if (value.hasOwnProperty('orderBy')) {
        orderBy[key as keyof typeof conditions] = value.orderBy;
      }

      if (Array.isArray(value)) {
        condition[key] = condition[key] || {};
        condition[key]['$in'] = value;
      }
    } else {
      condition[key] = value;
    }
  });

  return { condition, orderBy };
}
