/**
 * 玩家脚本 API 文档的纯数据类型（严格遵循 docs/API_DOCS_SPEC.md）。
 *
 * 故意不依赖 React 与 store：游戏内窗口（ApiDocsPanel）与独立网页（/docs/）共用同一份数据，
 * 窗口标题通过纯函数 `docTitle()` 计算。
 */

export type DocGroup =
  | '上手指南'
  | '全局运行时'
  | 'Game 接口'
  | '实体与数据结构'
  | '常量与返回码'
  | '实战示例';

/** 左侧目录与面包屑的类型标签。 */
export type DocKind = '指南' | '属性' | '方法' | '常量' | '类型';

export type DocParamRequired = 'required' | 'optional' | 'oneOf';

export interface DocParamRow {
  name: string;
  type: string;
  required: DocParamRequired;
  desc: string;
}

export interface DocErrorRow {
  code: string;
  when: string;
}

export interface DocFieldRow {
  name: string;
  type: string;
  desc: string;
}

export interface DocMethodRow {
  signature: string;
  returns: string;
  desc: string;
  id: string;
}

export interface DocLinkItem {
  label: string;
  id: string;
}

export type DocBlock =
  | { kind: 'prose'; text: string }
  /** 标准 TypeScript 签名行，mono 渲染并提供一键复制。 */
  | { kind: 'syntax'; code: string }
  /** 方法输入参数（Input）；无参方法传 rows: []。 */
  | { kind: 'params'; rows: DocParamRow[] }
  /** 方法返回值（Output）；若返回匿名结构对象，可附带 fields 展开说明。 */
  | { kind: 'returns'; type: string; desc?: string; fields?: DocFieldRow[] }
  /** 写方法的同步错误码（调用当场返回的负值 RetCode）。 */
  | { kind: 'errors'; rows: DocErrorRow[] }
  /** 写方法在返回 OK 后、下一 tick 落账阶段仍可能被静默拒绝的条件。 */
  | { kind: 'settlement'; items: string[] }
  /** 实体或数据对象的只读字段表（一行仅限一个字段）。 */
  | { kind: 'fields'; title?: string; rows: DocFieldRow[] }
  /** 对象或命名空间下的方法一览表，每行可跳转至独立方法页。 */
  | { kind: 'methods'; title?: string; rows: DocMethodRow[] }
  /** 通用对照表（配额、ID 约定、错误码矩阵、静态数据速查等）。 */
  | { kind: 'table'; title?: string; headers: string[]; rows: string[][] }
  | { kind: 'note'; level: 'info' | 'warn' | 'danger'; title?: string; text: string }
  | { kind: 'example'; code: string; caption?: string }
  | { kind: 'links'; items: DocLinkItem[] };

export interface DocEntry {
  /** 稳定 id，同时用作独立页 URL 锚点：如 'Game.market.createOrder'、'Ship.dispatch'。 */
  id: string;
  /** 叶子标题（不含父级前缀），用于目录与窗口标题。 */
  title: string;
  group: DocGroup;
  kind: DocKind;
  /** 一句话摘要（末尾不加句号）。 */
  summary: string;
  keywords?: string;
  /** 二级目录父条目 id，如 'Game.market'、'Ship'；留空表示直接挂在 group 下。 */
  parent?: string;
  blocks: DocBlock[];
}

/** 左侧目录的分组顺序。 */
export const DOC_GROUP_ORDER: DocGroup[] = [
  '上手指南',
  '全局运行时',
  'Game 接口',
  '实体与数据结构',
  '常量与返回码',
  '实战示例',
];
