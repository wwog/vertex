/**
 * @description 展示对象的所有字段，强制 TypeScript 简化类型提示
 * 使用嵌套的条件类型和 infer 来触发类型简化
 */
export type Prettier<T> = { [K in keyof T]: T[K] } extends infer O
  ? { [P in keyof O]: O[P] }
  : never;
  
/**
 * @description 将对象的属性转换为可选属性
 * @example
 * ```ts
 * type A = {
 *   a: string;
 *   b: number;
 * }
 * type B = OptionProperty<A, 'a'>
 * {
 *   a?: string;
 *   b: number;
 * }
 */
export type OptionProperty<
  T extends Record<string, any>,
  P extends keyof T,
> = Partial<Pick<T, P>> & Omit<T, P>;
