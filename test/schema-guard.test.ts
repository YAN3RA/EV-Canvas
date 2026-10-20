import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GUARD_MODES,
  FALLBACK_GUARD_MODE,
  guardWorkspace,
  type GuardMode,
} from '@/server/schema-guard';

/** 一个最小合法节点（与 node-schema.test.ts 同构，便于对照权威实现的行为） */
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

/** 合法快照：两个节点 + 一条边，够覆盖 validateWorkspace 的跨项不变量 */
function validSnapshot(): { nodes: unknown[]; edges: unknown[]; viewport: unknown } {
  return {
    nodes: [baseNode({ nodeId: 'n1' }), baseNode({ nodeId: 'n2' })],
    edges: [{ edgeId: 'e1', kind: 'context', from: 'n1', to: 'n2', createdAt: 'x' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** 明显非法：kind 不在八类里，nodeId 也不合 pattern */
function invalidSnapshot(): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: [{ nodeId: 'BAD ID!', kind: 'not-a-kind', x: 0, y: 0 }],
    edges: [],
  };
}

describe('off 模式', () => {
  it('非法数据也返回 ok（不校验）', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'projection', { projection: 'off' });
    expect(decision.ok).toBe(true);
  });

  it('off 时 problems 为空——因为根本没校验，而不是校验通过', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'projection', { projection: 'off' });
    expect(decision.problems).toEqual([]);
  });

  it('off 也回报 mode=off，日志才能区分「没校验」和「校验过了」', () => {
    const decision = guardWorkspace(validSnapshot(), 'user', { user: 'off' });
    expect(decision.mode).toBe('off');
  });

  it('连 null 这种明显非法输入也放行', () => {
    const decision = guardWorkspace(null, 'history', { history: 'off' });
    expect(decision.ok).toBe(true);
    expect(decision.problems).toEqual([]);
  });
});

describe('warn 模式', () => {
  it('非法数据 ok 为 true 但 problems 非空（放行并记账）', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'history');
    expect(decision.mode).toBe('warn');
    expect(decision.ok).toBe(true);
    expect(decision.problems.length).toBeGreaterThan(0);
  });

  it('收集全部问题而不是首个失败就停（多个坏节点报多条）', () => {
    const decision = guardWorkspace(
      {
        nodes: [
          { nodeId: 'BAD ID!', kind: 'thought', x: 0, y: 0 },
          { nodeId: 'also bad', kind: 'thought', x: 0, y: 0 },
        ],
        edges: [],
      },
      'history',
    );
    // 两个节点各自的 nodeId 都不合 pattern，应各报一条（不因首个异常而中断）
    expect(decision.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('跨项不变量（重复 nodeId）在 warn 下也被记录', () => {
    const decision = guardWorkspace(
      { nodes: [baseNode({ nodeId: 'dup' }), baseNode({ nodeId: 'dup' })], edges: [] },
      'history',
    );
    expect(decision.ok).toBe(true);
    expect(decision.problems.join('\n')).toMatch(/重复/);
  });
});

describe('enforce 模式', () => {
  it('非法数据 ok 为 false', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'user');
    expect(decision.mode).toBe('enforce');
    expect(decision.ok).toBe(false);
    expect(decision.problems.length).toBeGreaterThan(0);
  });

  it('非对象快照直接判否，且原因可读（不是 [object Object]）', () => {
    const decision = guardWorkspace('not-an-object', 'user');
    expect(decision.ok).toBe(false);
    expect(decision.problems[0]).toMatch(/必须是对象/);
  });

  it('enforce 下 problems 为空即放行', () => {
    const decision = guardWorkspace(validSnapshot(), 'user');
    expect(decision.ok).toBe(true);
    expect(decision.problems).toEqual([]);
  });
});

describe('默认模式表', () => {
  it('projection 默认 warn——投影形状由宿主决定，enforce 会挡住正常投影', () => {
    expect(DEFAULT_GUARD_MODES['projection']).toBe('warn');
  });

  it('user 默认 enforce——用户产出必须合规，否则脏数据进持久层', () => {
    expect(DEFAULT_GUARD_MODES['user']).toBe('enforce');
  });

  it('history 默认 warn——存量数据不能因规则收紧而打不开', () => {
    expect(DEFAULT_GUARD_MODES['history']).toBe('warn');
  });

  it('import 默认 enforce——外部文件不享受存量的宽容', () => {
    expect(DEFAULT_GUARD_MODES['import']).toBe('enforce');
  });

  it('默认表是冻结的，调用方不能就地改掉全局强度', () => {
    expect(Object.isFrozen(DEFAULT_GUARD_MODES)).toBe(true);
  });
});

describe('modeOverrides', () => {
  it('能把 projection 提成 enforce（逐来源提档）', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'projection', { projection: 'enforce' });
    expect(decision.mode).toBe('enforce');
    expect(decision.ok).toBe(false);
  });

  it('能把 user 降成 off（临时关掉某个来源）', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'user', { user: 'off' });
    expect(decision.mode).toBe('off');
    expect(decision.ok).toBe(true);
  });

  it('覆盖表按 source 逐项生效，不影响其他来源', () => {
    const overrides: Record<string, GuardMode> = { projection: 'enforce' };
    expect(guardWorkspace(invalidSnapshot(), 'projection', overrides).mode).toBe('enforce');
    expect(guardWorkspace(invalidSnapshot(), 'user', overrides).mode).toBe('enforce');
    expect(guardWorkspace(invalidSnapshot(), 'history', overrides).mode).toBe('warn');
  });

  it('空覆盖表等价于不传', () => {
    const withEmpty = guardWorkspace(invalidSnapshot(), 'user', {});
    const without = guardWorkspace(invalidSnapshot(), 'user');
    expect(withEmpty).toEqual(without);
  });
});

describe('未知 source', () => {
  it('落到 warn（既不阻断也不沉默）', () => {
    expect(FALLBACK_GUARD_MODE).toBe('warn');
  });

  it('未知来源实际按 warn 执行：非法数据 ok=true 但 problems 非空', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'some-new-caller');
    expect(decision.mode).toBe('warn');
    expect(decision.ok).toBe(true);
    expect(decision.problems.length).toBeGreaterThan(0);
  });

  it('未知来源也能被覆盖表提档', () => {
    const decision = guardWorkspace(invalidSnapshot(), 'some-new-caller', {
      'some-new-caller': 'enforce',
    });
    expect(decision.mode).toBe('enforce');
    expect(decision.ok).toBe(false);
  });
});

describe('合法数据在三种模式下都放行', () => {
  const modes: GuardMode[] = ['off', 'warn', 'enforce'];

  for (const mode of modes) {
    it(`${mode} 模式：合法快照 ok 且 problems 为空`, () => {
      const decision = guardWorkspace(validSnapshot(), 'user', { user: mode });
      expect(decision.mode).toBe(mode);
      expect(decision.ok).toBe(true);
      expect(decision.problems).toEqual([]);
    });
  }
});
