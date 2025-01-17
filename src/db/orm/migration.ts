import { Emitter, Logger } from '../../utils';
import {
  diffObj,
  diffStringArray,
  diffStringArrayRecord,
  isOK,
  type IDiffResult,
} from '../utils';
import type { ColumnParams } from './column';
import type { SqliteWasmORM } from './orm';
import type { IndexDesc, Table } from './table';

enum MetadataEnum {
  VERSION = 'version',
  SNAPSHOT = 'snapshot',
}

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

export class Migration<T extends Table[]> {
  private logger = Logger.scope('ORM.Migration');
  private _onFirstRun = new Emitter();
  public onFirstRun = this._onFirstRun.event;
  private _onWillUpgrade = new Emitter<{
    from: UpdateMetadata;
    to: UpdateMetadata;
  }>();
  public onWillUpgrade = this._onWillUpgrade.event;

  constructor(private orm: SqliteWasmORM<T>) {
    this.onFirstRun(() => {
      this.createTable();
    });
    this.onWillUpgrade((e) => {
      this.logger
        .info('Will Upgrading database from\n', e.from, '\n', e.to)
        .print();
      this.diff(e.from.snapshot, e.to.snapshot);
    });
  }

  private createTable() {
    this.logger.info('Loading models:', this.orm.tables).print();
    const sql = this.orm.tables
      .map((table) => {
        return table.genCreateSql();
      })
      .join('\n');
    return this.orm.exec(sql);
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

  public init() {
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
    } else {
      this.check();
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
        return false
      },
    );
    const diffIndexResult = this.diffIndex(fromSnapshot, toSnapshot);
    this.logger.info('feat:Diff result:', diffColumnsResult).print();
    this.logger.info('feat:Diff index result:', diffIndexResult).print();
    this.generateSql(diffColumnsResult, diffIndexResult);
  }

  generateSql(diffColumns: IDiffResult, diffIndex: IDiffResult) {
    const sqlList: string[] = [
      'BEGIN TRANSACTION;',
      //修改version
      `UPDATE metadata SET value='${this.version}' WHERE key='${MetadataEnum.VERSION}';`,
    ];
    //第一层是表
    for (const tableName of Object.keys(diffColumns)) {
      if (diffColumns[tableName]?._diffAct) {
        switch (diffColumns[tableName]._diffAct) {
          case 'add':
            sqlList.push(
              this.orm.tables
                .find((table) => table.name === tableName)
                ?.genCreateSql() as string,
            );
            break;
          case 'remove':
            sqlList.push(`DROP TABLE ${tableName};`);
            break;
          case 'update':
            break;
          default:
            break;
        }
      }
    }

    sqlList.push('COMMIT;');

    this.logger.info('feat: sqlList:', sqlList).print();
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
      return;
    }
    if (metadataVersion < this.version) {
      const snapshot = this.orm.exec<any[]>(
        `SELECT value FROM metadata WHERE key='${MetadataEnum.SNAPSHOT}';`,
      )[0].value as string;
      if (snapshot.length === 0) {
        throw new Error('fatal error: Invalid snapshot');
      }
      const fromSnapshot = JSON.parse(snapshot);
      this.logger.info('Upgrading database').print();
      this._onWillUpgrade.fire({
        from: {
          version: metadataVersion,
          snapshot: fromSnapshot,
        },
        to: {
          version: this.version,
          snapshot: this.snapshotTable(),
        },
      });
    }
  }
}
