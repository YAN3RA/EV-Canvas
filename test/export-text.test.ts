// @ts-nocheck -- 测试用宽松类型，断言本身是精确的。
import { describe, it, expect } from 'vitest';
import {
  CSV_HEADER,
  CSV_BOM,
  DEFAULT_MAX_BODY_CHARS,
  toMarkdown,
  needsFormulaGuard,
  escapeCsvField,
  csvCell,
  toCsv,
} from '@/export/text';

/**
 * 覆盖两条真实风险：
 *   1. CSV 公式注入（Excel 会把 =SUM(...) 当公式执行）
 *   2. UTF-8 BOM（缺了 Excel 打开中文全是乱码）
 * 旧版 export/text.js 已有实现，这里锁住行为，防止迁移走样。
 *
 * 注意快照形状：threads 在 snapshot.projection.threads，
 * 消息用 kind / sourceSeq（不是 role / seq）。
 */

/** 造一个符合 toMarkdown / toCsv 期望形状的快照 */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws1',
    revision: 1,
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    projection: {
      threads: [
        {
          id: 't1',
          title: '会话标题',
          dshSessionId: 'abc',
          dshSessionTitle: '会话标题',
          coverage: { ranges: [[1, 2]], historyComplete: true, textTruncated: false },
          messages: [
            { kind: 'user', sourceSeq: 1, text: '问题', at: '2026-01-01T00:00:00.000Z' },
            { kind: 'assistant', sourceSeq: 2, text: '回答', at: '2026-01-01T00:00:01.000Z' },
          ],
        },
      ],
    },
    materials: [],
    regions: [],
    annotations: [],
    ...overrides,
  };
}

describe('常量', () => {
  it('CSV 表头固定六列', () => {
    expect(CSV_HEADER).toEqual(['session', 'seq', 'type', 'time', 'source', 'text']);
  });

  it('BOM 是 U+FEFF', () => {
    expect(CSV_BOM).toBe('\uFEFF');
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });

  it('默认正文长度为正数', () => {
    expect(DEFAULT_MAX_BODY_CHARS).toBeGreaterThan(0);
  });
});

describe('needsFormulaGuard — 公式注入防护', () => {
  // 实现比"首字符黑名单"更精确：+/- 只在后面不是纯数字时才危险。
  // +1234 被 Excel 当数字，不会执行；+SUM(A1) 才会。测试按真实语义写。
  it.each([
    ['=SUM(A1:A9)', true],
    ['=A1', true],
    ['@import', true],
    ['+SUM(A1)', true],
    ['+1234', false],
    ['-1234', false],
    ['-3.5e10', false],
    ['普通文本', false],
    ['a=b', false],
    ['', false],
    ['\t开头', true],
  ])('%s → %s', (input, expected) => {
    expect(needsFormulaGuard(input)).toBe(expected);
  });

  it('前导空格后仍是公式，仍要防护', () => {
    expect(needsFormulaGuard('  =SUM(A1)')).toBe(true);
  });
});

describe('escapeCsvField — 转义', () => {
  it('含逗号加引号', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('双引号转成两个', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('含换行加引号', () => {
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
  });

  it('普通文本原样', () => {
    expect(escapeCsvField('plain')).toBe('plain');
  });
});

describe('csvCell — 转义 + 防护组合', () => {
  it('公式开头被改写，不等于原值', () => {
    const out = csvCell('=SUM(A1)');
    expect(out).not.toBe('=SUM(A1)');
    expect(out.length).toBeGreaterThan('=SUM(A1)'.length);
  });

  it('普通文本走普通转义', () => {
    expect(csvCell('plain')).toBe('plain');
  });

  it('含逗号的公式同时被防护和加引号', () => {
    const out = csvCell('=A1,B1');
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });
});

describe('toCsv — 整体输出', () => {
  it('以 BOM 开头', () => {
    expect(toCsv(snapshot()).startsWith(CSV_BOM)).toBe(true);
  });

  it('第一行是表头', () => {
    const first = toCsv(snapshot()).slice(CSV_BOM.length).split(/\r?\n/)[0];
    expect(first).toBe(CSV_HEADER.join(','));
  });

  it('公式内容不会原样出现在单元格开头', () => {
    const out = toCsv(
      snapshot({
        projection: {
          threads: [
            {
              id: 't1',
              title: 'T',
              coverage: { ranges: [[1, 1]], historyComplete: true },
              messages: [{ kind: 'user', sourceSeq: 1, text: '=危险公式' }],
            },
          ],
        },
      }),
    );
    expect(out).not.toMatch(/,=危险公式/);
  });
});

describe('toMarkdown — 整体输出', () => {
  it('包含会话标题', () => {
    expect(toMarkdown(snapshot())).toContain('会话标题');
  });

  it('包含消息正文', () => {
    const out = toMarkdown(snapshot());
    expect(out).toContain('问题');
    expect(out).toContain('回答');
  });

  it('写明不含坐标（FR-10.4 边界）', () => {
    const out = toMarkdown(snapshot());
    expect(out).toMatch(/不包含画布坐标/);
  });

  it('没有会话时给出明确说明，不静默空文件', () => {
    const out = toMarkdown(snapshot({ projection: { threads: [] } }));
    expect(out).toMatch(/没有已投影的会话/);
  });
});
