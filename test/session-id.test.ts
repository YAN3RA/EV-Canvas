import { describe, it, expect } from 'vitest';
import { normalizeSessionId, sameDshSessionId } from '@/shared/session-id';

/**
 * 防回归测试：旧版 0.2.2 曾因前缀不一致把同一会话投影成两条。
 * 见 known-failures 根因与项目记忆 ins_51c832c4。
 */
describe('normalizeSessionId', () => {
  it('剥离 session- 前缀', () => {
    expect(normalizeSessionId('session-abc123')).toBe('abc123');
  });

  it('剥离 sess- 前缀', () => {
    expect(normalizeSessionId('sess-abc123')).toBe('abc123');
  });

  it('裸 uuid 保持不变', () => {
    expect(normalizeSessionId('abc123')).toBe('abc123');
  });

  it('统一转小写', () => {
    expect(normalizeSessionId('ABC123')).toBe('abc123');
  });

  it('去首尾空白', () => {
    expect(normalizeSessionId('  abc123  ')).toBe('abc123');
  });

  it('只剥离一层前缀，不过度剥离', () => {
    expect(normalizeSessionId('session-session-abc')).toBe('session-abc');
  });

  it('前缀恰好等于整个字符串时不剥离（避免产出空串）', () => {
    expect(normalizeSessionId('session-')).toBe('session-');
  });

  it('不误伤恰以 sess 开头的普通 id', () => {
    // 'sessionx' 不以 'session-' 开头（缺连字符），不应被剥离
    expect(normalizeSessionId('sessionx')).toBe('sessionx');
  });
});

describe('sameDshSessionId', () => {
  it('带前缀与裸 uuid 判为同一会话', () => {
    expect(sameDshSessionId('session-abc', 'abc')).toBe(true);
  });

  it('大小写不同判为同一会话', () => {
    expect(sameDshSessionId('session-ABC', 'abc')).toBe(true);
  });

  it('不同 uuid 永不相等', () => {
    expect(sameDshSessionId('abc', 'abd')).toBe(false);
  });

  it('null / undefined 一律不等', () => {
    expect(sameDshSessionId(null, 'abc')).toBe(false);
    expect(sameDshSessionId('abc', undefined)).toBe(false);
    expect(sameDshSessionId(null, null)).toBe(false);
  });

  it('空串不判等（无效输入不得冒充有效 id）', () => {
    expect(sameDshSessionId('', '')).toBe(false);
    expect(sameDshSessionId('   ', 'abc')).toBe(false);
  });

  it('两侧都带前缀也能判等', () => {
    expect(sameDshSessionId('session-abc', 'sess-abc')).toBe(true);
  });
});
