import type { TileContent } from './paneRegistry';

export type SplitDirection = 'horizontal' | 'vertical';

export type SplitNode =
  | {
      id: string;
      type: 'leaf';
      content: TileContent | null;
    }
  | {
      id: string;
      type: 'split';
      direction: SplitDirection;
      /** Fraction [0.12..0.88] allocated to `first`. */
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

let nodeSeq = 1;
export function nextNodeId(prefix = 'tile'): string {
  return `${prefix}-${Date.now()}-${nodeSeq++}`;
}

export function makeLeaf(content: TileContent | null): SplitNode {
  return { id: nextNodeId('leaf'), type: 'leaf', content };
}

export function makeSplit(
  direction: SplitDirection,
  ratio: number,
  first: SplitNode,
  second: SplitNode,
): SplitNode {
  return { id: nextNodeId('split'), type: 'split', direction, ratio, first, second };
}

/** Split target leaf into two halves: existing content on first half, empty window on second half. */
export function splitLeaf(
  node: SplitNode,
  targetId: string,
  direction: SplitDirection,
): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== targetId) return node;
    return makeSplit(direction, 0.5, node, makeLeaf(null));
  }
  return {
    ...node,
    first: splitLeaf(node.first, targetId, direction),
    second: splitLeaf(node.second, targetId, direction),
  };
}

/** Close a leaf tile; if it is the root leaf, convert it to an empty tile instead of disappearing. */
export function closeLeaf(node: SplitNode, targetId: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.id === targetId) {
      return { ...node, content: null };
    }
    return node;
  }

  if (node.first.type === 'leaf' && node.first.id === targetId) {
    return node.second;
  }
  if (node.second.type === 'leaf' && node.second.id === targetId) {
    return node.first;
  }

  return {
    ...node,
    first: closeLeaf(node.first, targetId),
    second: closeLeaf(node.second, targetId),
  };
}

/** Turn a tile into an empty window (`content = null`) so user can search or drop a floating window. */
export function clearLeaf(node: SplitNode, targetId: string): SplitNode {
  if (node.type === 'leaf') {
    return node.id === targetId ? { ...node, content: null } : node;
  }
  return {
    ...node,
    first: clearLeaf(node.first, targetId),
    second: clearLeaf(node.second, targetId),
  };
}

/** Assign or replace content of a target tile. */
export function setLeafContent(
  node: SplitNode,
  targetId: string,
  content: TileContent | null,
): SplitNode {
  if (node.type === 'leaf') {
    return node.id === targetId ? { ...node, content } : node;
  }
  return {
    ...node,
    first: setLeafContent(node.first, targetId, content),
    second: setLeafContent(node.second, targetId, content),
  };
}

/** Update title of a specific leaf tile without resetting content. */
export function setLeafTitle(node: SplitNode, targetId: string, title: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== targetId || !node.content) return node;
    if (node.content.title === title) return node;
    return { ...node, content: { ...node.content, title } };
  }
  return {
    ...node,
    first: setLeafTitle(node.first, targetId, title),
    second: setLeafTitle(node.second, targetId, title),
  };
}

/** Update split divider ratio clamped to [0.12, 0.88]. */
export function updateSplitRatio(node: SplitNode, splitId: string, ratio: number): SplitNode {
  if (node.type === 'leaf') return node;
  const clamped = Math.max(0.12, Math.min(0.88, ratio));
  if (node.id === splitId) {
    return { ...node, ratio: clamped };
  }
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, clamped),
    second: updateSplitRatio(node.second, splitId, clamped),
  };
}
