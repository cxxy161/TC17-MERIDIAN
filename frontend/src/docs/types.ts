/**
 * 脚本 API 文档的纯数据类型。
 *
 * 这里故意不依赖 React、不依赖 store：游戏内窗口（ApiDocsPanel）和独立网页（/docs/）共用同一份
 * 数据，标题还要靠 `docTitle()` 在纯函数里算出来（见 layout/paneRegistry.ts 的 paneTitle）。
 */

export type DocGroup = '总览' | '常量' | 'Game' | '实体' | '运行时' | '示例' | '错误码';

/** TOC 上的徽标：属性 / 方法 / 常量 / 类型 / 章节。 */
export type DocKind = '章节' | '属性' | '方法' | '常量' | '类型';

export interface DocParamRow {
  name: string;
  type: string;
  required?: boolean;
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

export interface DocLinkItem {
  label: string;
  id: string;
}

export type DocBlock =
  | { kind: 'prose'; text: string }
  /** 签名行，mono 渲染并提供复制。 */
  | { kind: 'syntax'; code: string }
  | { kind: 'params'; rows: DocParamRow[] }
  | { kind: 'returns'; type: string; desc?: string }
  | { kind: 'errors'; rows: DocErrorRow[] }
  | { kind: 'fields'; rows: DocFieldRow[] }
  /** 自由三列表格：错误码矩阵、对照表等。 */
  | { kind: 'table'; headers: [string, string, string]; rows: Array<[string, string, string]> }
  | { kind: 'note'; level: 'info' | 'warn' | 'danger'; text: string }
  | { kind: 'example'; code: string; caption?: string }
  | { kind: 'links'; items: DocLinkItem[] };

export interface DocEntry {
  /** 稳定 id，也是独立页的锚点：如 'Game.market.createOrder'、'ERR_FULL'。 */
  id: string;
  /** 叶子标题（不含父级前缀），TOC 与窗口标题都用它。 */
  title: string;
  group: DocGroup;
  kind: DocKind;
  summary: string;
  keywords?: string;
  /** 二级 TOC 分组，例如 'Game.market'；留空表示直接挂在 group 下。 */
  parent?: string;
  blocks: DocBlock[];
}

/** 左侧 TOC 的分组顺序。 */
export const DOC_GROUP_ORDER: DocGroup[] = ['总览', '常量', 'Game', '实体', '运行时', '示例', '错误码'];
