// @ts-nocheck -- 测试里用鸭子类型模型与故意畸形的输入，断言精确。
import { describe, it, expect } from 'vitest';
import {
  EDGE_KINDS,
  USER_EDGE_KINDS,
  CONTEXT_EDGE_KINDS,
  EDGE_DERIVED_AT,
  LINEAGE_ID_PREFIX,
  assertEdgeSet,
  contextEdges,
  createUserEdge,
  deriveLineageEdges,
  edgesOfNode,
  isLineageEdge,
  isUserEditableEdge,
  lineageEdgeId,
  mergeEdges,
  nodeIdsOf,
  participatesInContext,
  removeUserEdge,
} from '@/canvas/edges';
import type { CanvasEdge } from '@/shared/types';

/**
 * 三类边（S0-2 / FR-12 / D25）的本地验证。
 * 锁四件事：
 *   1. lineage 只从谱系推导、不进库、不受用户增删影响
 *   2. context / input 走用户路径，重复边与悬空端点被硬拒
 *   3. 只有 context / input 参与模型上下文
 *   4. 纯函数：同一输入两次调用结果相等（推导边没有 `new Date()`）
 */

const ISO = '2026-10-18T09:00:00.000Z';

function edge(edgeId: string, kind: CanvasEdge['kind'], from: string, to: string): CanvasEdge {
  return { edgeId, kind, from, to, createdAt: ISO };
}

const nodeIds = new Set(['a', 'b', 'c', 'd']);

describe('边类别枚举', () => {
  it('三类边齐全且顺序固定为 lineage → context → input', () => {
    expect(EDGE_KINDS).toEqual(['lineage', 'context', 'input']);
    expect(Object.isFrozen(EDGE_KINDS)).toBe(false); // 常量数组可被调用方 readonly 化，语义靠类型
    expect(USER_EDGE_KINDS).toEqual(['context', 'input']);
    expect(CONTEXT_EDGE_KINDS).toEqual(['context', 'input']);
  });

  it('lineage 不在「用户可创建」与「参与上下文」两个集合里', () => {
    expect(USER_EDGE_KINDS.includes('lineage')).toBe(false);
    expect(CONTEXT_EDGE_KINDS.includes('lineage')).toBe(false);
  });
});

describe('血缘边推导', () => {
  it('从 threads 的 parentId 推导，id 幂等且带 lineage 前缀', () => {
    const derived = deriveLineageEdges({
      threads: [
        { id: 'a', parentId: null },
        { id: 'b', parentId: 'a' },
        { id: 'c', parentId: 'b' },
      ],
    });
    expect(derived.map(item => [item.kind, item.from, item.to])).toEqual([
      ['lineage', 'a', 'b'],
      ['lineage', 'b', 'c'],
    ]);
    // 全部是 lineage，且 id 由父子派生（重复推导不会造新边）
    for (const item of derived) {
      expect(item.kind).toBe('lineage');
      expect(item.edgeId.startsWith(LINEAGE_ID_PREFIX)).toBe(true);
      expect(item.edgeId).toBe(lineageEdgeId(item.from, item.to));
    }
  });

  it('纯函数：同一快照两次推导结果完全相等（没有 new Date()）', () => {
    const snapshot = { threads: [{ id: 'a' }, { id: 'b', parentId: 'a' }] };
    const first = deriveLineageEdges(snapshot);
    const second = deriveLineageEdges(snapshot);
    expect(first).toEqual(second);
    expect(first[0].createdAt).toBe(EDGE_DERIVED_AT);
  });

  it('两端都存在才产出边：父节点缺失时整条边不出现', () => {
    const derived = deriveLineageEdges({
      nodes: [{ nodeId: 'a' }],
      threads: [{ id: 'b', parentId: 'ghost' }, { id: 'c', parentId: 'a' }],
    });
    // b 的父 ghost 不在已知节点里 → 没有边；c 的父 a 存在 → 有边
    expect(derived.map(item => item.to)).toEqual(['c']);
  });

  it('节点自带 parentId 也会被推导，且与 thread 谱系不重复', () => {
    const derived = deriveLineageEdges({
      nodes: [
        { nodeId: 'a' },
        { nodeId: 'b', parentId: 'a' },
      ],
      threads: [{ id: 'b', parentId: 'a' }],
    });
    expect(derived.length).toBe(1);
    expect(derived[0].from).toBe('a');
  });

  it('自环被跳过，不抛错', () => {
    const derived = deriveLineageEdges({ nodes: [{ nodeId: 'a', parentId: 'a' }] });
    expect(derived).toEqual([]);
  });

  it('空快照与畸形输入返回空数组，不抛错', () => {
    expect(deriveLineageEdges({})).toEqual([]);
    expect(deriveLineageEdges({ threads: null, nodes: null })).toEqual([]);
    expect(deriveLineageEdges({ threads: [null, 1, 'x', { id: 'a', parentId: 42 }] })).toEqual([]);
  });

  it('显式传入 nodeIds 时以它为准，快照里的 nodes/threads 被忽略', () => {
    const derived = deriveLineageEdges({ nodes: [{ nodeId: 'a' }, { nodeId: 'b', parentId: 'a' }] }, new Set(['b']));
    expect(derived).toEqual([]);
  });
});

describe('用户建边', () => {
  it('context / input 可以创建，字段原样保留', () => {
    const created = createUserEdge({ edgeId: 'e1', kind: 'context', from: 'a', to: 'b', createdAt: ISO }, nodeIds);
    expect(created).toEqual(edge('e1', 'context', 'a', 'b'));
    const input = createUserEdge({ edgeId: 'e2', kind: 'input', from: 'b', to: 'c', createdAt: ISO }, nodeIds);
    expect(input.kind).toBe('input');
  });

  it('lineage 被硬拒：系统推导，不能手工创建', () => {
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'lineage', from: 'a', to: 'b', createdAt: ISO }, nodeIds)).toThrow(/lineage/);
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'lineage', from: 'a', to: 'b', createdAt: ISO }, nodeIds)).toThrow(/不能手工创建/);
  });

  it('自环、悬空端点、重复边、重复 id 全部被拒', () => {
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'context', from: 'a', to: 'a', createdAt: ISO }, nodeIds)).toThrow(/自环/);
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'context', from: 'a', to: 'ghost', createdAt: ISO }, nodeIds)).toThrow(/不存在的节点/);
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'context', from: 'ghost', to: 'a', createdAt: ISO }, nodeIds)).toThrow(/不存在的节点/);
    const existing = [edge('e9', 'context', 'a', 'b')];
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'context', from: 'a', to: 'b', createdAt: ISO }, nodeIds, existing)).toThrow(/重复的边/);
    const sameId = [edge('e1', 'input', 'b', 'c')];
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'context', from: 'a', to: 'b', createdAt: ISO }, nodeIds, sameId)).toThrow(/已存在/);
  });

  it('同端点不同 kind 不算重复（语义不同）', () => {
    const existing = [edge('e9', 'context', 'a', 'b')];
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'input', from: 'a', to: 'b', createdAt: ISO }, nodeIds, existing)).not.toThrow();
  });

  it('非法 kind 被拒', () => {
    expect(() => createUserEdge({ edgeId: 'e1', kind: 'wired' as CanvasEdge['kind'], from: 'a', to: 'b', createdAt: ISO }, nodeIds)).toThrow(/kind/);
  });
});

describe('删除用户边', () => {
  it('context 边可删，返回新数组且不改入参', () => {
    const edges = [edge('e1', 'context', 'a', 'b'), edge('e2', 'input', 'b', 'c')];
    const next = removeUserEdge(edges, 'e1');
    expect(next.map(item => item.edgeId)).toEqual(['e2']);
    expect(edges.length).toBe(2);
  });

  it('lineage 边不能删：显式抛错而不是静默忽略', () => {
    const edges = [edge('lineage:a->b', 'lineage', 'a', 'b')];
    expect(() => removeUserEdge(edges, 'lineage:a->b')).toThrow(/不能删除/);
  });

  it('不存在的边抛错', () => {
    expect(() => removeUserEdge([edge('e1', 'context', 'a', 'b')], 'ghost')).toThrow(/不存在/);
  });
});

describe('可编辑性与上下文归属', () => {
  it('只有 context / input 可编辑，lineage 只读', () => {
    expect(isUserEditableEdge(edge('e1', 'lineage', 'a', 'b'))).toBe(false);
    expect(isUserEditableEdge(edge('e2', 'context', 'a', 'b'))).toBe(true);
    expect(isUserEditableEdge(edge('e3', 'input', 'a', 'b'))).toBe(true);
    expect(isUserEditableEdge(null)).toBe(false);
    expect(isLineageEdge(edge('e1', 'lineage', 'a', 'b'))).toBe(true);
    expect(isLineageEdge(edge('e2', 'context', 'a', 'b'))).toBe(false);
  });

  it('lineage 不参与模型上下文，context / input 参与', () => {
    const edges = [edge('l', 'lineage', 'a', 'b'), edge('c', 'context', 'a', 'c'), edge('i', 'input', 'a', 'd')];
    expect(participatesInContext(edges[0])).toBe(false);
    expect(participatesInContext(edges[1])).toBe(true);
    expect(participatesInContext(edges[2])).toBe(true);
    expect(contextEdges(edges).map(item => item.kind)).toEqual(['context', 'input']);
  });
});

describe('边集合成', () => {
  it('合并顺序固定为 lineage → context → input', () => {
    const stored = [edge('i1', 'input', 'b', 'c'), edge('c1', 'context', 'a', 'b')];
    const derived = [edge('lineage:a->d', 'lineage', 'a', 'd')];
    const merged = mergeEdges(stored, derived);
    expect(merged.map(item => item.kind)).toEqual(['lineage', 'context', 'input']);
  });

  it('库里走私的 lineage 被丢弃，以推导结果为准', () => {
    const stored = [edge('forged', 'lineage', 'a', 'b')];
    const derived = [edge('lineage:a->c', 'lineage', 'a', 'c')];
    const merged = mergeEdges(stored, derived);
    expect(merged.map(item => item.edgeId)).toEqual(['lineage:a->c']);
  });

  it('同 edgeId 只出现一次', () => {
    const stored = [edge('dup', 'context', 'a', 'b'), edge('dup', 'context', 'a', 'b')];
    expect(mergeEdges(stored, []).length).toBe(1);
  });

  it('输出元素被冻结，调用方改不到库里的边', () => {
    const stored = [edge('e1', 'context', 'a', 'b')];
    const merged = mergeEdges(stored, []);
    expect(Object.isFrozen(merged[0])).toBe(true);
    expect(() => {
      (merged[0] as { from: string }).from = 'zzz';
    }).toThrow();
    expect(stored[0].from).toBe('a');
  });

  it('畸形存储项被跳过，不抛错', () => {
    const merged = mergeEdges([null, 1, 'x', { kind: 'context' }, { edgeId: 'ok', kind: 'context', from: 'a', to: 'b', createdAt: ISO }], []);
    expect(merged.map(item => item.edgeId)).toEqual(['ok']);
  });
});

describe('边集完整性', () => {
  it('合法边集通过', () => {
    expect(() =>
      assertEdgeSet([edge('l', 'lineage', 'a', 'b'), edge('c', 'context', 'b', 'c')], nodeIds),
    ).not.toThrow();
  });

  it('悬空端点、重复 edgeId、重复语义边都被拒', () => {
    expect(() => assertEdgeSet([edge('e1', 'context', 'a', 'ghost')], nodeIds)).toThrow(/终点不存在/);
    expect(() => assertEdgeSet([edge('e1', 'context', 'ghost', 'a')], nodeIds)).toThrow(/起点不存在/);
    expect(() => assertEdgeSet([edge('e1', 'context', 'a', 'b'), edge('e1', 'input', 'b', 'c')], nodeIds)).toThrow(/edgeId 重复/);
    expect(() => assertEdgeSet([edge('e1', 'context', 'a', 'b'), edge('e2', 'context', 'a', 'b')], nodeIds)).toThrow(/重复的边/);
  });

  it('空边集合法', () => {
    expect(() => assertEdgeSet([], nodeIds)).not.toThrow();
  });
});

describe('按节点取边', () => {
  const edges = [edge('l', 'lineage', 'a', 'b'), edge('c', 'context', 'b', 'c'), edge('i', 'input', 'd', 'b')];

  it('both 取进出的全部边', () => {
    expect(edgesOfNode(edges, 'b').map(item => item.edgeId)).toEqual(['l', 'c', 'i']);
  });

  it('from / to 分别只取出边与入边', () => {
    expect(edgesOfNode(edges, 'b', 'from').map(item => item.edgeId)).toEqual(['c']);
    expect(edgesOfNode(edges, 'b', 'to').map(item => item.edgeId)).toEqual(['l', 'i']);
  });

  it('未知节点与空 id 返回空数组', () => {
    expect(edgesOfNode(edges, 'ghost')).toEqual([]);
    expect(edgesOfNode(edges, '')).toEqual([]);
  });
});

describe('节点 id 集合', () => {
  it('从节点数组压出 id 集合，跳过畸形项', () => {
    const ids = nodeIdsOf([{ nodeId: 'a' } as never, { nodeId: '' } as never, null as never]);
    expect([...ids]).toEqual(['a']);
  });
});
