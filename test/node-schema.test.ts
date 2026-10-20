import { describe, it, expect } from 'vitest';
import {
  validateNode,
  validateEdge,
  validateWorkspace,
  isAllowedAssetMime,
  assertAssetSize,
} from '@/shared/node-schema';
import { InputError } from '@/shared/errors';
import { MAX_TEXT_BYTES, MAX_ASSET_BYTES } from '@/shared/constants';

/** 一个最小合法节点 */
function baseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: 'n1',
    kind: 'thought',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    zIndex: 0,
    collapsed: false,
    visibility: 'visible',
    text: 'hi',
    sourceRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateNode', () => {
  it('接受合法节点', () => {
    expect(() => validateNode(baseNode(), 0)).not.toThrow();
  });

  it('拒绝非法 nodeId 格式', () => {
    expect(() => validateNode(baseNode({ nodeId: 'BAD ID!' }), 0)).toThrow(InputError);
  });

  it('拒绝未知 kind', () => {
    expect(() => validateNode(baseNode({ kind: 'unknown' }), 0)).toThrow(InputError);
  });

  it('坐标允许 null（D26 ⑤）', () => {
    expect(() => validateNode(baseNode({ x: null, y: null }), 0)).not.toThrow();
  });

  it('拒绝 NaN 坐标', () => {
    expect(() => validateNode(baseNode({ x: NaN }), 0)).toThrow(InputError);
  });

  it('拒绝含 base64 内联数据的字段（不变量 10）', () => {
    expect(() =>
      validateNode(baseNode({ text: 'data:image/png;base64,iVBORw0KGgo=' }), 0),
    ).toThrow(/base64/);
  });

  it('拒绝嵌套字段里的 base64', () => {
    const node = baseNode({
      kind: 'thought',
      sourceRef: { sessionId: 'data:image/png;base64,AAA', messageId: 'm1' },
    });
    expect(() => validateNode(node, 0)).toThrow(/base64/);
  });

  it('text 节点超 2 MiB 被拒（D26 ①）', () => {
    const big = 'a'.repeat(MAX_TEXT_BYTES + 1);
    expect(() => validateNode(baseNode({ kind: 'text', text: big, mime: 'text/plain' }), 0)).toThrow(
      /超限/,
    );
  });

  it('媒体节点必须有 assetId', () => {
    const node = baseNode({ kind: 'image', transform: { rotate: 0, crop: null }, alt: '' });
    expect(() => validateNode(node, 0)).toThrow(/assetId/);
  });
});

describe('validateEdge', () => {
  const ok = { edgeId: 'e1', kind: 'context', from: 'n1', to: 'n2', createdAt: 'x' };

  it('接受合法边', () => {
    expect(() => validateEdge(ok, 0)).not.toThrow();
  });

  it('拒绝未知 edge kind', () => {
    expect(() => validateEdge({ ...ok, kind: 'unknown' }, 0)).toThrow(InputError);
  });

  it('拒绝自环', () => {
    expect(() => validateEdge({ ...ok, to: 'n1' }, 0)).toThrow(/自环/);
  });
});

describe('validateWorkspace 不变量', () => {
  const twoNodes = [
    baseNode({ nodeId: 'n1' }),
    baseNode({ nodeId: 'n2' }),
  ];

  it('接受合法 workspace', () => {
    expect(() =>
      validateWorkspace({ nodes: twoNodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
    ).not.toThrow();
  });

  it('拒绝重复 nodeId（不变量 1）', () => {
    expect(() =>
      validateWorkspace({ nodes: [baseNode({ nodeId: 'n1' }), baseNode({ nodeId: 'n1' })], edges: [] }),
    ).toThrow(/重复/);
  });

  it('拒绝悬空边（不变量 2）', () => {
    expect(() =>
      validateWorkspace({
        nodes: [baseNode({ nodeId: 'n1' })],
        edges: [{ edgeId: 'e1', kind: 'context', from: 'n1', to: 'ghost', createdAt: 'x' }],
      }),
    ).toThrow(/不存在的节点/);
  });

  it('拒绝同 kind 重复边（不变量 3）', () => {
    const e = { edgeId: 'e1', kind: 'context', from: 'n1', to: 'n2', createdAt: 'x' };
    expect(() =>
      validateWorkspace({ nodes: twoNodes, edges: [e, { ...e, edgeId: 'e2' }] }),
    ).toThrow(/重复的边/);
  });

  it('不同 kind 的同向边允许', () => {
    expect(() =>
      validateWorkspace({
        nodes: twoNodes,
        edges: [
          { edgeId: 'e1', kind: 'context', from: 'n1', to: 'n2', createdAt: 'x' },
          { edgeId: 'e2', kind: 'input', from: 'n1', to: 'n2', createdAt: 'x' },
        ],
      }),
    ).not.toThrow();
  });

  it('拒绝 group 自引用（不变量 5）', () => {
    expect(() =>
      validateWorkspace({
        nodes: [baseNode({ kind: 'group', nodeId: 'g1', childNodeIds: ['g1'], primaryNodeId: 'g1', expanded: false })],
        edges: [],
      }),
    ).toThrow(/自引用/);
  });

  it('拒绝 generation.inputs 指向 session（不变量 6）', () => {
    const session = baseNode({
      kind: 'session',
      nodeId: 's1',
      sessionId: 'abc',
      projection: { cursor: { lastSeq: 0 }, title: 't', turns: [] },
      archivedInHost: false,
    });
    const gen = baseNode({
      kind: 'generation',
      nodeId: 'g1',
      channelId: 'c1',
      inputs: ['s1'],
      params: {},
      status: 'idle',
      lastRun: null,
    });
    expect(() => validateWorkspace({ nodes: [session, gen], edges: [] })).toThrow(/只允许指向/);
  });

  it('拒绝缺失资产的媒体节点（不变量 7）', () => {
    const img = baseNode({ kind: 'image', nodeId: 'i1', assetId: 'missing', transform: { rotate: 0, crop: null }, alt: '' });
    expect(() =>
      validateWorkspace({ nodes: [img], edges: [] }, new Set<string>()),
    ).toThrow(/不存在的资产/);
  });

  it('拒绝 zoom <= 0（不变量 9）', () => {
    expect(() =>
      validateWorkspace({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0 } }),
    ).toThrow(/zoom/);
  });
});

describe('资产边界', () => {
  it('MIME 白名单接受 png', () => {
    expect(isAllowedAssetMime('image/png')).toBe(true);
  });

  it('MIME 白名单拒绝 svg（可含脚本）', () => {
    expect(isAllowedAssetMime('image/svg+xml')).toBe(false);
  });

  it('MIME 白名单拒绝可执行类型', () => {
    expect(isAllowedAssetMime('application/x-msdownload')).toBe(false);
  });

  it('50 MiB 上限生效', () => {
    expect(() => assertAssetSize(MAX_ASSET_BYTES + 1)).toThrow(/超限/);
  });

  it('正常大小通过', () => {
    expect(() => assertAssetSize(1024)).not.toThrow();
  });
});
