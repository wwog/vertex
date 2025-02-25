export function isOK(result: any[]) {
  return result.length > 0;
}

export type DiffActionType = 'add' | 'remove' | 'update';
export interface IDiffResult {
  [key: string]: { _diffAct: DiffActionType } | undefined | IDiffResult;
}
/**
 * @description diffObj不会处理obj中的数组，因为不同类型的数组对比方式无法确定。例如[1,2,3]和[2,3,4]，是按位对比还是按成员对比效果是截然不同的，所以diffObj只处理对象
 * @param processArray {function} - 可选参数，用于处理数组的对比，如果传入该参数，diffObj会调用该函数处理数组对比
 * @example
 *diffObj({a:1,b:{name:"jac",age:18}}, {a:2,b:{name:"jac"},c:"da"})
 *--->
 *{
 *  a:{_diffAct:"update"},
 *  b:{age:{_diffAct: "remove"}},
 *  c:{_diffAct: "add"}
 *}
 */
export function diffObj<T extends Record<string, any>>(
  from: T,
  to: T,
  exclude?: (layer: number, key: string) => boolean,
): IDiffResult {
  const result: IDiffResult = {};

  function compareObjects(_from: T, _to: T, res: IDiffResult, layer = 0) {
    for (const key in _from) {
      if (_from.hasOwnProperty(key)) {
        if (exclude?.(layer, key)) continue;
        if (
          typeof _from[key] === 'object' &&
          _from[key] !== null &&
          _to[key] !== undefined
        ) {
          res[key] = {};
          compareObjects(
            _from[key],
            _to[key],
            res[key] as IDiffResult,
            layer + 1,
          );
          if (Object.keys(res[key] as IDiffResult).length === 0) {
            delete res[key];
          } else {
            if (res[key]) {
              //@ts-ignore
              res[key]._diffAct = 'update';
            }
          }
        } else if (_to[key] === undefined) {
          res[key] = { _diffAct: 'remove' };
        } else if (_from[key] !== _to[key]) {
          res[key] = { _diffAct: 'update' };
        }
      }
    }

    for (const key in _to) {
      if (_to.hasOwnProperty(key)) {
        if (exclude?.(layer, key)) continue;
        if (_from[key] === undefined) {
          res[key] = { _diffAct: 'add' };
        }
      }
    }
  }

  compareObjects(from, to, result);
  return result;
}

export function diffStringArray(
  from: string[],
  to: string[],
): IDiffResult | undefined {
  const result: IDiffResult = {};
  const allKeys = new Set([...from, ...to]);
  for (const key of allKeys) {
    if (!from.includes(key) && to.includes(key)) {
      result[key] = { _diffAct: 'add' };
    } else if (from.includes(key) && !to.includes(key)) {
      result[key] = { _diffAct: 'remove' };
    }
  }
  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result;
}

export function diffStringArrayRecord<T extends Record<string, string[]>>(
  from: T,
  to: T,
): IDiffResult | undefined {
  const result: IDiffResult = {};
  const allKeys = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const key of allKeys) {
    const fromVal = from[key];
    const toVal = to[key];

    if (!fromVal && toVal) {
      result[key] = { _diffAct: 'add' };
    } else if (fromVal && !toVal) {
      result[key] = { _diffAct: 'remove' };
    } else if (fromVal && toVal) {
      const diff = diffStringArray(fromVal, toVal);
      if (diff) {
        result[key] = diff;
      }
    }
  }
  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result;
}

export function escapeSqlValue(value: any[]): string[] {
  return value.map((v) => {
    if (typeof v === 'string') {
      // 处理字符串中的单引号
      return `'${v.replace(/'/g, "''")}'`;
    }
    return v;
  });
}

/**
 * 去除时间中的时区信息
 * @param date 需要处理的日期字符串
 * @returns 去除时区后的日期字符串
 */
export function removeTimezone(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
