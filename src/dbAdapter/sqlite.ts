import { DatabaseAdapter } from "../db/orm/adapter";
import _sqlite3, { Database } from "sqlite3";

const sqlite3 = _sqlite3.verbose();

class SqliteNodePrepare implements DatabaseAdapter.ISqlitePrepare {
  public sql: string;
  private stmt: _sqlite3.Statement;
  constructor(db: Database, sql: string) {
    this.sql = sql;
    this.stmt = db!.prepare(sql);
  }

  run = async (params?: any[]): Promise<any> => {
    return new Promise((res, rej) => {
      this.stmt.run(...(params || []), (err: Error | null) => {
        if (err) {
          return rej(err);
        }
        res([]);
      });
    });
  };

  get = async (params?: any[]): Promise<any> => {
    return new Promise((res, rej) => {
      this.stmt.get(...(params || []), (err: Error | null, rows: any[]) => {
        if (err) {
          return rej(err);
        }
        res(rows);
      });
    });
  };

  all = async (params?: any[]): Promise<any[]> => {
    return new Promise((res, rej) => {
      this.stmt.all(...(params || []), (err: Error | null, rows: any[]) => {
        if (err) {
          return rej(err);
        }
        res(rows);
      });
    });
  };
}

export class NodeSqliteAdapter implements DatabaseAdapter.IAdapter {
  private db: Database | null = null;
  private connected: boolean = false;
  private prepareStatement: Map<string, SqliteNodePrepare>;

  constructor() {
    this.prepareStatement = new Map();
  }
  transaction = async (sqlList: DatabaseAdapter.SQLList) => {
    if (!this.db) throw new Error("Not connected to a database.");

    return new Promise<any[]>((res, rej) => {
      const results: any[] = new Array(sqlList.length);
      let completedCount = 0;
      let hasError = false;

      this.db!.serialize(() => {
        // Start transaction
        this.db!.exec("BEGIN TRANSACTION", (beginErr) => {
          if (beginErr) {
            return rej(new Error(`Failed to begin transaction: ${beginErr.message}`));
          }

          // Execute all queries
          sqlList.forEach(({ sql, params }, index) => {
            this.db!.all(sql, params, (err, rows) => {
              if (hasError) return; // Skip if already errored

              if (err) {
                hasError = true;
                this.db!.exec("ROLLBACK", () => {
                  rej(new Error(`SQL Error: ${err.message}, SQL: ${sql}, Params: ${JSON.stringify(params)}`));
                });
                return;
              }

              results[index] = rows;
              completedCount++;

              // All queries completed successfully
              if (completedCount === sqlList.length && !hasError) {
                this.db!.exec("COMMIT", (commitErr) => {
                  if (commitErr) {
                    this.db!.exec("ROLLBACK", () => {
                      rej(new Error(`Failed to commit transaction: ${commitErr.message}`));
                    });
                  } else {
                    res(results);
                  }
                });
              }
            });
          });

          // Handle empty sqlList case
          if (sqlList.length === 0) {
            this.db!.exec("COMMIT", (commitErr) => {
              if (commitErr) {
                this.db!.exec("ROLLBACK", () => {
                  rej(new Error(`Failed to commit transaction: ${commitErr.message}`));
                });
              } else {
                res([]);
              }
            });
          }
        });
      });
    });
  };

  /**
   * @param path 这里做了点更改，不能耦合业务，所以path要求node环境提供完整路径
   */
  connect: (path: string) => Promise<void> = async (path: string) => {
    if (this.db) {
      throw new Error("Already connected to a database.");
    }
    return new Promise((res, rej) => {
      this.db = new sqlite3.Database(path, async (err) => {
        if (err) {
          return rej(err);
        }
        try {
          await this.exec("PRAGMA journal_mode=WAL");
          this.connected = true;
          res();
        } catch (err) {
          rej(err);
        }
      });
    });
  };
  disconnect: () => Promise<void> = async () => {
    this.prepareStatement.clear();
    this.connected = false;
    await this.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return new Promise((res, rej) => {
      if (!this.db) {
        return res();
      }
      this.db.close((err) => {
        if (err) {
          return rej(err);
        }
        this.db = null;
        res();
      });
    });
  };

  private exec: <T>(sql: string, params?: any[]) => Promise<T> = async (sql: string, params?: any[]) => {
    if (!this.db) throw new Error("Not connected to a database.");
    if (/RETURNING|SELECT|PRAGMA|WITH/i.test(sql)) {
      return new Promise<any[]>((res, rej) => {
        this.db!.all(sql, params, (err, rows) => {
          if (err) {
            return rej(err);
          }
          res(rows);
        });
      });
    }
    return new Promise<any>((res, rej) => {
      this.db!.run(sql, params, (err) => {
        if (err) {
          return rej(err);
        }
        res([]);
      });
    });
  };

  execute: <T>(sql: string, params?: any[]) => Promise<T> = async <T>(sql: string, params?: any[]) => {
    if (!this.connected) throw new Error("Not connected to a database.");
    const sqlArr = sql.split(";");
    let idx = 0;
    let result: any[] = [];
    let cbCount = 0;
    return new Promise<T>((resolve, reject) => {
      this.db!.serialize(() => {
        for (const item of sqlArr) {
          if (item.trim()) {
            // eslint-disable-next-line no-useless-escape
            const count = item.replace(/[^\?]/g, "").length;
            this.exec<T>(item, params?.slice(idx, idx + count))
              .then((res) => {
                result = result.concat(res);
                cbCount += 1;
                if (cbCount === sqlArr.length) {
                  resolve(result as any);
                }
              })
              .catch((err) => {
                reject(err);
              });
            idx += count;
          } else {
            cbCount += 1;
            if (cbCount === sqlArr.length) {
              resolve(result as any);
            }
          }
        }
      });
    });
  };

  prepare: (sql: string) => Promise<DatabaseAdapter.ISqlitePrepare> = async (sql: string) => {
    if (!this.db) throw new Error("Not connected to a database.");
    if (this.prepareStatement.get(sql)) {
      return this.prepareStatement.get(sql)!;
    }
    const stmt = new SqliteNodePrepare(this.db!, sql);
    this.prepareStatement.set(sql, stmt);
    return stmt;
  };
}