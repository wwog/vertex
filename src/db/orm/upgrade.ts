import { Emitter, Logger } from '../../utils';
import {
  diffObj,
  diffStringArray,
  diffStringArrayRecord,
  isOK,
  type IDiffResult,
} from '../utils';
import type { ColumnParams, ColumnType } from './column';
import type { SqliteWasmORM } from './orm';
import type { IndexDesc, Table } from './table';

enum MetadataEnum {
  VERSION = 'version',
  SNAPSHOT = 'snapshot',
}

export type NeedMigrateMap = Record<
  string,
  {
    diffResult: IDiffResult;
    info: string;
    needMigrateKey: string;
  }[]
>;

export type SnapshotTable = {
  columns: Record<string, ColumnParams>;
  indexMap?: IndexDesc;
};

export type SnapshotTableMap = {
  [key: string]: SnapshotTable;
};

export interface UpdateMetadata {
  version: number;
  snapshot: SnapshotTableMap;
}

export interface DiffTableMap {
  [key: string]: {
    type: 'add' | 'remove' | 'update';
    columns?:
    | {
      [key: string]: {
        type: 'add' | 'remove' | 'update';
        column: ColumnParams;
      };
    }
    | undefined;
  };
}

export class Upgrade<T extends Table[]> {
  private logger = Logger.scope('ORM.Upgrade');
  private _onFirstRun = new Emitter();
  public onFirstRun = this._onFirstRun.event;

  private _onNeedMigrate = new Emitter<{
    migrateMap: NeedMigrateMap;
    restUpgradeSql: string[];
  }>();
  public onNeedMigrate = this._onNeedMigrate.event;

  constructor(private orm: SqliteWasmORM<T>) {
    this.onFirstRun(() => {
      this.createTable();
    });
  }

  private createTable() {
    this.logger.info('Loading models:', this.orm.tables).print();
    const sql = this.orm.tables
      .map((table) => {
        return table.genCreateSql();
      })
      .join('\n');
    this.logger.info('Create table SQL:', sql).print();
    try {
      this.orm.exec("BEGIN TRANSACTION;" + "\n" + sql + "\n" + "COMMIT;");
    } catch (error) {
      console.error("Create table failed, rolled back.", error);
      this.orm.exec("ROLLBACK;");
      //同时删除 metadata表
      this.orm.exec(`DROP TABLE IF EXISTS metadata;`);
      throw error;
    }
  }

  snapshotTable() {
    const result: SnapshotTableMap = {};
    this.orm.tables.forEach((table) => {
      if (result[table.name]) {
        throw new Error(`duplicate table name: ${table.name}`);
      }
      result[table.name] = {
        columns: table.toJSON(),
      };
      if (table.getIndex) {
        result[table.name].indexMap = table.getIndex();
      }
    });
    return result;
  }

  get version() {
    return this.orm.version;
  }

  public init(): boolean {
    this.logger.info('Initializing metadata').print();
    //查询是否存在metadata表
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name='metadata';`;
    const result = this.orm.exec<any[]>(sql);
    const hasMetadata = isOK(result);
    if (hasMetadata === false) {
      this.logger.info('Creating metadata table').print();
      const tables = this.snapshotTable();
      this.orm.dbOriginal.exec([
        //创建metadata表
        `CREATE TABLE metadata (key TEXT NOT NULL,value TEXT NOT NULL);`,
        //创建metadata表的key的唯一索引
        `CREATE UNIQUE INDEX metadata_key ON metadata (key);`,
        //写入版本号
        `INSERT INTO metadata (key,value) VALUES ('${MetadataEnum.VERSION}','${this.version}');`,
        //写入快照
        `INSERT INTO metadata (key,value) VALUES ('${MetadataEnum.SNAPSHOT}','${JSON.stringify(
          tables,
        )}');`,
      ]);
      this._onFirstRun.fire();
      return true;
    } else {
      return this.check();
    }
  }

  private diffIndex(from: SnapshotTableMap, to: SnapshotTableMap) {
    const diffIndexResult: IDiffResult = {};
    const fromIndexKeys = Object.keys(from);
    const toIndexKeys = Object.keys(to);
    const mergeUniqueKeys = new Set([...fromIndexKeys, ...toIndexKeys]);

    for (const tableName of mergeUniqueKeys) {
      if (from[tableName] && to[tableName]) {
        //只处理from和to都存在的表，新增表在创建时创建索引，不需要对比，删除表会删除索引
        const indexDesc = from[tableName].indexMap;
        const toIndexDesc = to[tableName].indexMap;
        //index
        const fromIndexKeys = indexDesc?.index ?? [];
        const toIndexKeys = toIndexDesc?.index ?? [];
        //unique index
        const fromUniqueKeys = indexDesc?.unique ?? [];
        const toUniqueKeys = toIndexDesc?.unique ?? [];
        //composite index
        const fromCompositeKeys = indexDesc?.composite ?? {};
        const toCompositeKeys = toIndexDesc?.composite ?? {};
        //diff result
        const diffIndex = diffStringArray(fromIndexKeys, toIndexKeys);
        const diffUnique = diffStringArray(fromUniqueKeys, toUniqueKeys);
        const diffComposite = diffStringArrayRecord(
          fromCompositeKeys,
          toCompositeKeys,
        );
        diffIndexResult[tableName] = {};
        if (diffIndex) {
          diffIndexResult[tableName].index = diffIndex;
        }
        if (diffUnique) {
          diffIndexResult[tableName].unique = diffUnique;
        }
        if (diffComposite) {
          diffIndexResult[tableName].composite = diffComposite;
        }
        if (Object.keys(diffIndexResult[tableName]).length === 0) {
          delete diffIndexResult[tableName];
        }
      }
    }
    return diffIndexResult;
  }

  diff(fromSnapshot: SnapshotTableMap, toSnapshot: SnapshotTableMap) {
    const diffColumnsResult = diffObj(
      fromSnapshot,
      toSnapshot,
      (layer, key) => {
        if (layer === 1 && key === 'indexMap') {
          return true;
        }
        return false;
      },
    );
    const diffIndexResult = this.diffIndex(fromSnapshot, toSnapshot);
    this.logger.info('Diff result:', diffColumnsResult).print();
    this.logger.info('Diff index result:', diffIndexResult).print();
    return this.generateSql(diffColumnsResult, diffIndexResult);
  }

  generateSql(diffColumns: IDiffResult, diffIndex: IDiffResult) {
    const sqlList: string[] = ['BEGIN TRANSACTION;'];
    const needMigrateMap: NeedMigrateMap = {};
    const addMigration = (
      tableName: string,
      obj: { diffResult: IDiffResult; info: string; needMigrateKey: string },
    ) => {
      if (needMigrateMap[tableName]) {
        needMigrateMap[tableName].push(obj);
      } else {
        needMigrateMap[tableName] = [obj];
      }
    };
    const handleColumns = (tableName: string, columns: IDiffResult) => {
      if (columns) {
        for (const columnName of Object.keys(columns)) {
          if (columns[columnName]?._diffAct) {
            switch (columns[columnName]._diffAct) {
              case 'add':
                {
                  const table = this.orm.findTable(tableName);
                  const column = table.columns[columnName] as
                    | undefined
                    | ColumnType;
                  if (!column) {
                    throw new Error('fatal error: column not found');
                  }
                  const columnType = column.unwrap();
                  if (
                    columnType._required === true &&
                    columnType._default === undefined
                  ) {
                    addMigration(tableName, {
                      diffResult: columns,
                      info: `Column ${columnName} is required but has no default value`,
                      needMigrateKey: columnName,
                    });
                    continue;
                  }
                  sqlList.push(
                    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${column.unwrap().genCreateSql().join(' ')};`,
                  );
                }
                break;
              case 'update':
                addMigration(tableName, {
                  diffResult: columns,
                  info: `fatal error: update column not support,SQLite does not support direct modification of existing field constraints, but can only be implemented indirectly by rebuilding the table.`,
                  needMigrateKey: columnName,
                });
                continue;
              case 'remove':
                addMigration(tableName, {
                  diffResult: columns,
                  info: `fatal error: remove column not support,SQLite does not support direct modification of existing field constraints, but can only be implemented indirectly by rebuilding the table.`,
                  needMigrateKey: columnName,
                });
                continue;
              default:
                break;
            }
          }
        }
      }
    };

    for (const tableName of Object.keys(diffColumns)) {
      if (diffColumns[tableName]?._diffAct) {
        switch (diffColumns[tableName]._diffAct) {
          case 'add':
            sqlList.push(this.orm.findTable(tableName).genCreateSql());
            break;
          case 'remove':
            sqlList.push(`DROP TABLE ${tableName};`);
            break;
          case 'update':
            //@ts-ignore
            handleColumns(tableName, diffColumns[tableName].columns);
            break;
          default:
            throw new Error('fatal error: Invalid diff act');
        }
      }
    }

    for (const tableName of Object.keys(diffIndex)) {
      const indexDiff = diffIndex[tableName] as unknown as {
        index?: IDiffResult;
        unique?: IDiffResult;
        composite?: IDiffResult;
      };

      if (indexDiff.index) {
        for (const indexName of Object.keys(indexDiff.index)) {
          if (indexDiff.index[indexName]?._diffAct) {
            switch (indexDiff.index[indexName]._diffAct) {
              case 'add':
                sqlList.push(
                  `CREATE INDEX IF NOT EXISTS idx_${tableName}_${indexName} ON ${tableName} (${indexName});`,
                );
                break;
              case 'remove':
                sqlList.push(
                  `DROP INDEX IF EXISTS idx_${tableName}_${indexName};`,
                );
                break;
              case 'update':
                addMigration(tableName, {
                  diffResult: indexDiff.index,
                  info: `fatal error: for-of Object.keys(indexDiff.index): Invalid diff act`,
                  needMigrateKey: indexName,
                });
                continue;
              default:
                throw new Error(
                  'fatal error: for-of Object.keys(indexDiff.index): Invalid diff act',
                );
            }
          }
        }
      }

      if (indexDiff.unique) {
        for (const indexName of Object.keys(indexDiff.unique)) {
          if (indexDiff.unique[indexName]?._diffAct) {
            switch (indexDiff.unique[indexName]._diffAct) {
              case 'add':
                sqlList.push(
                  `CREATE UNIQUE INDEX IF NOT EXISTS idx_${tableName}_${indexName} ON ${tableName} (${indexName});`,
                );
                break;
              case 'remove':
                sqlList.push(
                  `DROP INDEX IF EXISTS idx_${tableName}_${indexName};`,
                );
                break;
              case 'update':
                addMigration(tableName, {
                  diffResult: indexDiff.unique,
                  info: `fatal error: for-of Object.keys(indexDiff.unique): Invalid diff act`,
                  needMigrateKey: indexName,
                });
                continue;
              default:
                throw new Error(
                  'fatal error: for-of Object.keys(indexDiff.unique): Invalid diff act',
                );
            }
          }
        }
      }

      if (indexDiff.composite) {
        for (const indexName of Object.keys(indexDiff.composite)) {
          if (indexDiff.composite[indexName]?._diffAct) {
            switch (indexDiff.composite[indexName]._diffAct) {
              case 'add':
                const table = this.orm.findTable(tableName);
                const index = table.getIndex?.() ?? {};
                const cols = index.composite?.[indexName] ?? [];
                sqlList.push(
                  `CREATE INDEX IF NOT EXISTS idx_${tableName}_${indexName} ON ${tableName} (${cols.join(',')});`,
                );
                break;
              case 'remove':
                sqlList.push(
                  `DROP INDEX IF EXISTS idx_${tableName}_${indexName};`,
                );
                break;
              case 'update':
                addMigration(tableName, {
                  diffResult: indexDiff.composite,
                  info: `fatal error: for-of Object.keys(indexDiff.composite): Invalid diff act`,
                  needMigrateKey: indexName,
                });
                continue;
              default:
                throw new Error(
                  'fatal error: for-of Object.keys(indexDiff.composite): Invalid diff act',
                );
            }
          }
        }
      }
    }

    sqlList.push(
      `UPDATE metadata SET value='${this.version}' WHERE key='${MetadataEnum.VERSION}';`,
    );
    sqlList.push(
      `UPDATE metadata SET value='${JSON.stringify(
        this.snapshotTable(),
      )}' WHERE key='${MetadataEnum.SNAPSHOT}';`,
    );
    sqlList.push('COMMIT;');
    if (Object.keys(needMigrateMap).length > 0) {
      this.logger.warn('Upgrade Version failed', needMigrateMap).print();
      this._onNeedMigrate.fire({
        migrateMap: needMigrateMap,
        restUpgradeSql: sqlList,
      });
      return false;
    } else {
      this.logger.info('Upgrade SQL:\n', sqlList).print();
      this.orm.exec(sqlList.join('\n'));
      this.logger.info('Upgrade Version success').print();
      return true;
    }
  }

  private check() {
    const metadataVersion = Number(
      this.orm.exec<{ value: string }[]>(
        `SELECT value FROM metadata WHERE key='${MetadataEnum.VERSION}';`,
      )[0].value,
    );
    this.logger.info('Checking version:', metadataVersion).print();
    if (
      isNaN(metadataVersion) ||
      metadataVersion > this.version ||
      metadataVersion < 1
    ) {
      throw new Error('fatal error: Invalid version number');
    }
    if (metadataVersion === this.version) {
      return true;
    }
    if (metadataVersion < this.version) {
      const snapshot = this.orm.exec<any[]>(
        `SELECT value FROM metadata WHERE key='${MetadataEnum.SNAPSHOT}';`,
      )[0].value as string;
      if (snapshot.length === 0) {
        throw new Error('fatal error: Invalid snapshot');
      }
      const fromSnapshot = JSON.parse(snapshot);
      const from = {
        version: metadataVersion,
        snapshot: fromSnapshot,
      };
      const to = {
        version: this.version,
        snapshot: this.snapshotTable(),
      };

      this.logger
        .info('Will Upgrading database from\n', from, '\n', to)
        .print();
      return this.diff(from.snapshot, to.snapshot);
    }

    return false;
  }
}
