// @ts-nocheck -- 测试里用鸭子类型节点，断言精确。
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PASTE_OFFSET,
  copyAndPaste,
  copyNodes,
  defaultEdgeIdFactory,
  defaultNodeIdFactory,
  isEmptyPayload,
  pasteNodes,
} from '@/canvas/clipboard';

/**
 * 复制粘贴（FR-09.8 / S1-5）的本地验证。
 * 锁四件事：
 *   1. 只复制内部边，跨出选中集的边不跟着走
 *   2. 粘贴时全部节点 id / 边 id / 内部引用都被重映射
 *   3. 引用对端不在粘贴集里时进 droppedRefs，不留悬空引用
 *   4. 跨工作区直接拒绝
 */

const ISO = '2026-10-18T09:00:00.000Z';

const node = (nodeId, extra = {}) => ({
  nodeId,
  kind: 'thought',
  x: 100,
  y: 100,
  width: 310,
  height: 276,
  zIndex: 0,
  collapsed: false,
  visibility: 'visible',
  createdAt: ISO,
  updatedAt: ISO,
  text: `内容 ${nodeId}`,
  sourceRef: null,
  ...extra,
});

const edge = (edgeId, kind, from, to) => ({ edgeId, kind, from, to, createdAt: ISO });

const group = (nodeId, childNodeIds, primaryNodeId, extra = {}) =>
  node(nodeId, { kind: 'group', childNodeIds, primaryNodeId, expanded: true, ...extra });

const generation = (nodeId, inputs, extra = {}) =>
  node(nodeId, {
    kind: 'generation',
    channelId: 'ch-1',
    task: 'text-to-image',
    params: { prompt: 'p', negativePrompt: null, model: 'm', aspectRatio: '1:1', count: 1, seed: null },
    inputs,
    status: 'idle',
    lastRun: null,
    ...extra,
  });

describe('复制', () => {
  it('只复制选中节点，且是深拷贝（改结果不影响原数据）', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const payload = copyNodes(nodes, [], ['a', 'c']);
    expect(payload.nodes.map(item => item.nodeId)).toEqual(['a', 'c']);
    payload.nodes[0].text = '改过';
    expect(nodes[0].text).toBe('内容 a');
  });

  it('只保留两端都在选中集里的边', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('e1', 'context', 'a', 'b'), edge('e2', 'context', 'b', 'c')];
    const payload = copyNodes(nodes, edges, ['a', 'b']);
    expect(payload.edges.map(item => item.edgeId)).toEqual(['e1']);
  });

  it('lineage 边若两端都在，也会被复制（粘贴时按引用重映射）', () => {
    const nodes = [node('a'), node('b')];
    const payload = copyNodes(nodes, [edge('lineage:a->b', 'lineage', 'a', 'b')], ['a', 'b']);
    expect(payload.edges.length).toBe(1);
    expect(payload.edges[0].kind).toBe('lineage');
  });

  it('幽灵选中项被忽略，复制顺序跟节点数组顺序', () => {
    const nodes = [node('a'), node('b')];
    const payload = copyNodes(nodes, [], ['ghost', 'b', 'a']);
    expect(payload.nodes.map(item => item.nodeId)).toEqual(['a', 'b']);
  });

  it('空选区与空节点得到空 payload', () => {
    expect(isEmptyPayload(copyNodes([], [], []))).toBe(true);
    expect(isEmptyPayload(null)).toBe(true);
    expect(isEmptyPayload(undefined)).toBe(true);
  });

  it('记录来源工作区与复制时刻', () => {
    const payload = copyNodes([node('a')], [], ['a'], { sourceWorkspaceId: 'ws-1', copiedAt: ISO });
    expect(payload.sourceWorkspaceId).toBe('ws-1');
    expect(payload.copiedAt).toBe(ISO);
    // 缺省时刻是可复现的固定值，不是 new Date()
    expect(copyNodes([node('a')], [], ['a']).copiedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('粘贴：id 重映射', () => {
  it('节点 id、边 id 与内部引用全部换成新 id', () => {
    const payload = copyNodes([node('a'), node('b')], [edge('e1', 'context', 'a', 'b')], ['a', 'b'], { sourceWorkspaceId: 'ws-1' });
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: 'ws-1' });
    expect(result.nodes.map(item => item.nodeId)).toEqual(['a-copy-1', 'b-copy-1']);
    expect(result.edges[0].edgeId).toBe('e1-copy-1');
    expect(result.edges[0].from).toBe('a-copy-1');
    expect(result.edges[0].to).toBe('b-copy-1');
    expect(result.idMap).toEqual({ a: 'a-copy-1', b: 'b-copy-1' });
  });

  it('坐标整体位移，默认偏移避免与原节点完全重叠', () => {
    const payload = copyNodes([node('a', { x: 100, y: 200 })], [], ['a']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    expect(result.nodes[0].x).toBe(100 + DEFAULT_PASTE_OFFSET.x);
    expect(result.nodes[0].y).toBe(200 + DEFAULT_PASTE_OFFSET.y);
  });

  it('坐标 null（待自动布局）保持 null，不被加成 0 甩到原点', () => {
    const payload = copyNodes([node('a', { x: null, y: null })], [], ['a']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    expect(result.nodes[0].x).toBeNull();
    expect(result.nodes[0].y).toBeNull();
  });

  it('重复粘贴递增代次，同一批内各节点代次一致', () => {
    const payload = copyNodes([node('a'), node('b')], [], ['a', 'b']);
    const once = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    expect(once.nodes.map(item => item.nodeId)).toEqual(['a-copy-1', 'b-copy-1']);
    const twice = pasteNodes(payload, new Set(once.nodes.map(item => item.nodeId)), { targetWorkspaceId: null });
    // 第二代整批推进：a/b 都到 -copy-2，不会出现 a-copy-1 配 b-copy-2 的错位
    expect(twice.nodes.map(item => item.nodeId)).toEqual(['a-copy-2', 'b-copy-2']);
  });
});

describe('粘贴：引用重映射', () => {
  it('group 的子节点在粘贴集内时被映射', () => {
    const nodes = [group('g', ['a', 'b'], 'a'), node('a'), node('b')];
    const payload = copyNodes(nodes, [], ['g', 'a', 'b']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    const pastedGroup = result.nodes.find(item => item.kind === 'group');
    expect(pastedGroup.childNodeIds).toEqual(['a-copy-1', 'b-copy-1']);
    expect(pastedGroup.primaryNodeId).toBe('a-copy-1');
  });

  it('group 的子节点不在粘贴集里时进 droppedRefs，不留悬空引用', () => {
    const nodes = [group('g', ['a', 'b'], 'a')];
    const payload = copyNodes(nodes, [], ['g']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    const pastedGroup = result.nodes[0];
    expect(pastedGroup.childNodeIds).toEqual([]);
    expect(result.droppedRefs.map(ref => ref.field)).toEqual(['childNodeIds', 'childNodeIds', 'primaryNodeId']);
  });

  it('primaryNodeId 不在集内时回落到第一个子节点', () => {
    const nodes = [group('g', ['a'], 'ghost'), node('a')];
    const payload = copyNodes(nodes, [], ['g', 'a']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    expect(result.nodes.find(item => item.kind === 'group').primaryNodeId).toBe('a-copy-1');
  });

  it('generation.inputs 保序映射，对端缺失时丢弃并记录', () => {
    const nodes = [generation('gen', ['a', 'b', 'ghost']), node('a'), node('b')];
    const payload = copyNodes(nodes, [], ['gen', 'a', 'b']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    const pasted = result.nodes.find(item => item.kind === 'generation');
    // 顺序即生成顺序：a 在 b 前，顺序不能被打乱
    expect(pasted.inputs).toEqual(['a-copy-1', 'b-copy-1']);
    expect(result.droppedRefs).toEqual([{ nodeId: 'gen', field: 'inputs', value: 'ghost' }]);
  });

  it('外部引用（sourceRef / sessionId）不重映射，它们指向宿主', () => {
    const source = node('a', { kind: 'thought', sourceRef: { sessionId: 'sess-1', messageId: 'm-1' } });
    const payload = copyNodes([source], [], ['a']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null });
    expect(result.nodes[0].sourceRef).toEqual({ sessionId: 'sess-1', messageId: 'm-1' });
  });
});

describe('粘贴：拒绝条件', () => {
  it('跨工作区被拒绝', () => {
    const payload = copyNodes([node('a')], [], ['a'], { sourceWorkspaceId: 'ws-1' });
    expect(() => pasteNodes(payload, new Set(), { targetWorkspaceId: 'ws-2' })).toThrow(/跨工作区/);
  });

  it('来源为 null 时只能粘到 null 工作区', () => {
    const payload = copyNodes([node('a')], [], ['a']);
    expect(() => pasteNodes(payload, new Set(), { targetWorkspaceId: 'ws-2' })).toThrow(/跨工作区/);
    expect(() => pasteNodes(payload, new Set(), { targetWorkspaceId: null })).not.toThrow();
  });

  it('空剪贴板被拒绝', () => {
    expect(() => pasteNodes(null, new Set(), { targetWorkspaceId: null })).toThrow(/剪贴板为空/);
    expect(() => pasteNodes({ nodes: [], edges: [], sourceWorkspaceId: null, copiedAt: ISO }, new Set(), { targetWorkspaceId: null })).toThrow(/剪贴板为空/);
  });

  it('默认代次自动避让已有 id：撞车时生成 -copy-2 而不是报错', () => {
    const payload = copyNodes([node('a')], [], ['a']);
    const result = pasteNodes(payload, new Set(['a-copy-1']), { targetWorkspaceId: null });
    expect(result.nodes[0].nodeId).toBe('a-copy-2');
  });

  it('自定义 idFactory 产出撞车 id 时拒绝，不静默覆盖', () => {
    const payload = copyNodes([node('a')], [], ['a']);
    expect(() =>
      pasteNodes(payload, new Set(['taken']), { targetWorkspaceId: null, idFactory: () => 'taken' }),
    ).toThrow(/冲突/);
  });

  it('非法位移被拒绝', () => {
    const payload = copyNodes([node('a')], [], ['a']);
    expect(() => pasteNodes(payload, new Set(), { targetWorkspaceId: null, offset: { x: Number.NaN, y: 0 } })).toThrow(/有限数字/);
  });
});

describe('粘贴：时间戳', () => {
  it('createdAt/updatedAt 被改写为粘贴时刻', () => {
    const payload = copyNodes([node('a')], [], ['a']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null, pastedAt: '2026-10-20T10:00:00.000Z' });
    expect(result.nodes[0].createdAt).toBe('2026-10-20T10:00:00.000Z');
    expect(result.nodes[0].updatedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('边的时间戳同样被改写', () => {
    const payload = copyNodes([node('a'), node('b')], [edge('e1', 'context', 'a', 'b')], ['a', 'b']);
    const result = pasteNodes(payload, new Set(), { targetWorkspaceId: null, pastedAt: ISO });
    expect(result.edges[0].createdAt).toBe(ISO);
  });
});

describe('默认 id 生成器', () => {
  it('节点 id 加 -copy-N 后缀，超长原 id 被截断到 64 字符', () => {
    expect(defaultNodeIdFactory('abc', 0)).toBe('abc-copy-1');
    expect(defaultNodeIdFactory('abc', 1)).toBe('abc-copy-2');
    const long = 'x'.repeat(80);
    const generated = defaultNodeIdFactory(long, 0);
    expect(generated.length).toBe(64);
    expect(generated.endsWith('-copy-1')).toBe(true);
  });

  it('边 id 加 -copy-N 后缀', () => {
    expect(defaultEdgeIdFactory('e1', 0)).toBe('e1-copy-1');
  });
});

describe('copyAndPaste 便利组合', () => {
  it('一次完成复制与粘贴，内部节点互相引用被重映射', () => {
    const nodes = [group('g', ['a'], 'a'), node('a')];
    const edges = [edge('e1', 'context', 'g', 'a')];
    const result = copyAndPaste({ nodes, edges, workspaceId: 'ws-1' }, ['g', 'a'], { targetWorkspaceId: 'ws-1' });
    expect(result.nodes.length).toBe(2);
    const pastedGroup = result.nodes.find(item => item.kind === 'group');
    expect(pastedGroup.childNodeIds).toEqual(['a-copy-1']);
    expect(result.edges[0].from).toBe('g-copy-1');
  });
});
