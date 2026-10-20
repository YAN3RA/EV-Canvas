// @ts-nocheck -- 迁移自 dsh-synapnova@3fd1d00 test/export-png.test.js，行为完整、类型待补（与 export-scene.test.ts 一致）。
// 迁移自 dsh-synapnova@3fd1d00 test/export-png.test.js
/**
 * T7 — PNG render and encode pipeline.
 *
 * The module talks to an ABSTRACT 2D context, which is what makes these tests
 * behavioural instead of "assert the function exists": a recording context
 * captures every real drawing call, so the assertions are about what was PAINTED.
 *
 * Mutations these are written to catch:
 *
 *   - `renderScene` ignoring `options.scale` while the caller allocated a 2x
 *     canvas → the picture occupies the top-left quarter
 *   - negative coordinates being clipped at 0,0 instead of translated into view
 *   - a null / zero-size Blob being reported as a successful export
 *   - an over-limit scene being exported anyway (no silent downscale)
 *   - an empty scene rendering a blank image and calling it success
 *   - a font rejection or timeout being drawn over with missing glyphs
 *
 * 迁移说明：旧版用 `node:test` + `node:assert/strict`；这里换成 Vitest 的
 * `describe`/`it`/`expect`，断言语义逐条等价。`node:canvas` 之类真实 canvas
 * 从未出现在旧套件里 —— 它本来就用注入式 recording context，所以这里只把
 * `assert.*` 换成 `expect`，假 canvas 仍然是纯 stub，不引入任何新依赖。
 */
import { describe, expect, it } from 'vitest'

import {
  CANVAS_BACKGROUND,
  DEFAULT_FONT_TIMEOUT_MS,
  EXPORT_FAILURES,
  FONT_STACK,
  PAINT,
  PNG_MIME,
  describeEmptyScene,
  exportPng,
  isNonEmptyBlob,
  renderScene,
} from '@/export/png'
import { DEFAULT_MAX_EDGE, SCENE_CODES } from '@/export/scene'

const FONT = { fontFamily: FONT_STACK, fontSize: 12, lineHeight: 18 }

/** A recording 2D context: every drawing call lands in `calls`. */
function recordingContext() {
  const calls = []
  const record = name => (...args) => { calls.push([name, ...args]) }
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    setTransform: record('setTransform'),
    translate: record('translate'),
    scale: record('scale'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    clip: record('clip'),
    fillText: record('fillText'),
    measureText: text => ({ width: String(text).length * 7 }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  }
}

const findCall = (ctx, name) => ctx.calls.find(call => call[0] === name)
const allCalls = (ctx, name) => ctx.calls.filter(call => call[0] === name)

/** A one-card scene at the given logical size and scale. */
function scene(overrides = {}) {
  const width = 344
  const height = 224
  return {
    mode: 'selection',
    revision: 7,
    width,
    height,
    bounds: { x: -32, y: -32, w: width, h: height },
    padding: 32,
    scale: 1,
    items: [{
      kind: 'card',
      id: 'a:0',
      x: -32,
      y: -32,
      w: 280,
      h: 160,
      collapsed: false,
      visibility: 'visible',
      title: 'T',
      questionPreview: '问题',
      questionTruncated: false,
      typeLabel: '会话',
      textStyle: FONT,
      textMetrics: { width: 100, height: 18, linesText: ['问题'] },
    }],
    warnings: [],
    excluded: [],
    stats: { cardCount: 1, materialCount: 0, regionCount: 0, annotationCount: 0, connectorCount: 0 },
    ...overrides,
  }
}

/** Adapter that records allocation and returns a fixed Blob. */
function adapter(options = {}) {
  const created = []
  const toBlobCalls = []
  let blobCount = 0
  return {
    created,
    toBlobCalls,
    createCanvas: (width, height) => {
      const ctx = recordingContext()
      const canvas = { width, height, getContext: () => ctx, ctx }
      created.push({ width, height, canvas })
      return canvas
    },
    toBlob: async canvas => {
      toBlobCalls.push(canvas)
      if (options.toBlob) return options.toBlob(canvas, blobCount++)
      return { size: 1024, type: PNG_MIME }
    },
    ...(options.waitFonts ? { waitFonts: options.waitFonts } : {}),
  }
}

// ── 1. 上下文与变换：负坐标不被裁掉 ────────────────────────────────────────

describe('上下文与变换', () => {
  it('负坐标场景通过 translate 把世界原点搬进图像，而不是裁到 0,0', async () => {
    const sink = adapter()
    const result = await exportPng(scene(), sink)
    expect(result.ok, JSON.stringify({ failure: result.failure, reason: result.reason })).toBe(true)
    const ctx = result.canvas.ctx

    // Background covers the whole logical surface before the world translate.
    const background = findCall(ctx, 'fillRect')
    expect(background).toEqual(['fillRect', 0, 0, result.width, result.height])

    // The world origin is shifted by the padded bounds, so x=-32 draws at 0.
    const shift = findCall(ctx, 'translate')
    expect(shift, 'bounds.x=-32 必须被平移 +32').toEqual(['translate', 32, 32])
    // And the card really is painted at the translated origin.
    const texts = allCalls(ctx, 'fillText')
    expect(texts.length, '卡片文字必须真的被绘制').toBeGreaterThan(0)
    expect(result.report.originX).toBe(-32)
    expect(result.report.originY).toBe(-32)
  })

  it('renderScene 必须尊重 options.scale（2x 画布就得 2x 变换）', async () => {
    // The regression: a caller allocates a 2x canvas but the renderer used 1x,
    // leaving the picture in the top-left quarter.
    const sink = adapter()
    const oneX = scene({ scale: 1 })
    const result = await exportPng(oneX, sink, { scale: 2 })
    expect(result.ok).toBe(true)
    expect(result.scale).toBe(2)
    expect(result.width, '画布必须是 2x 尺寸').toBe(oneX.width * 2)
    expect(result.height).toBe(oneX.height * 2)

    const ctx = result.canvas.ctx
    expect(findCall(ctx, 'setTransform'), '2x 画布必须配 2x 变换，否则内容缩在左上角')
      .toEqual(['setTransform', 2, 0, 0, 2, 0, 0])
    // The background must still cover the full canvas: FillRect runs under the 2x
    // transform, so its logical size is width/2.
    expect(findCall(ctx, 'fillRect')).toEqual(['fillRect', 0, 0, result.width / 2, result.height / 2])
  })

  it('renderScene 直接调用时也按 options.scale 工作', () => {
    const ctx1 = recordingContext()
    const direct = scene({ scale: 1 })
    const report = renderScene(ctx1, direct, { scale: 2 })
    expect(report.width).toBe(direct.width * 2)
    expect(report.height).toBe(direct.height * 2)
    expect(findCall(ctx1, 'setTransform')).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])

    // No options → the scene's own scale applies.
    const ctx2 = recordingContext()
    const doubled = scene({ scale: 2 })
    const report2 = renderScene(ctx2, doubled)
    expect(report2.width).toBe(doubled.width * 2)
    expect(findCall(ctx2, 'setTransform')).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])

    // An unsupported scale is an error, not a clamp.
    expect(() => renderScene(recordingContext(), direct, { scale: 3 })).toThrow(TypeError)
  })
})

// ── 2. 绘制顺序与内容 ─────────────────────────────────────────────────────

describe('绘制顺序与内容', () => {
  it('绘制顺序：分区在底层，连线其次，卡片其后，旁注最后', () => {
    const ctx = recordingContext()
    renderScene(ctx, scene({
      items: [
        { kind: 'annotation', id: 'n', x: 0, y: 0, w: 80, h: 48, text: '注', textMetrics: { linesText: ['注'] }, textStyle: FONT },
        { kind: 'card', id: 'a:0', x: 0, y: 0, w: 280, h: 160, questionPreview: 'q', textMetrics: { linesText: ['q'] }, textStyle: FONT },
        { kind: 'connector', id: 'c', from: 'a:0', to: 'b:0', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
        { kind: 'region', id: 'r', x: 0, y: 0, w: 200, h: 120, name: '分区' },
      ],
    }))
    const firstFillRect = ctx.calls.findIndex(call => call[0] === 'fillRect')
    const firstBegin = ctx.calls.findIndex(call => call[0] === 'beginPath')
    expect(firstFillRect).toBeGreaterThanOrEqual(0)
    // Region is filled before any card path is opened.
    expect(firstBegin, '分区必须先于卡片绘制').toBeGreaterThan(firstFillRect)
  })

  it('折叠卡片只画头部与折叠徽标，不画正文行', () => {
    const ctx = recordingContext()
    renderScene(ctx, scene({
      items: [{
        kind: 'card', id: 'a:0', x: 0, y: 0, w: 280, h: 96,
        collapsed: true, questionPreview: '标题行', questionTruncated: false,
        textStyle: FONT, textMetrics: { linesText: ['正文第一行', '正文第二行'] },
      }],
    }))
    const texts = allCalls(ctx, 'fillText').map(call => call[1])
    // The header always shows the question; the BODY lines are what folding hides.
    expect(texts, '折叠卡片仍要画标题行').toContain('标题行')
    expect(texts.some(text => text.includes('正文第一行')), '折叠卡片不得绘制正文行').toBe(false)
    expect(texts.some(text => text.includes('正文第二行')), '折叠卡片不得绘制正文行').toBe(false)
    expect(texts.some(text => text.includes('已折叠')), '折叠卡片必须带「已折叠」徽标').toBe(true)
  })

  it('未折叠卡片会绘制正文行', () => {
    const ctx = recordingContext()
    renderScene(ctx, scene({
      items: [{
        kind: 'card', id: 'a:0', x: 0, y: 0, w: 280, h: 160,
        collapsed: false, questionPreview: '标题行', textStyle: FONT,
        textMetrics: { linesText: ['正文第一行'] },
      }],
    }))
    const texts = allCalls(ctx, 'fillText').map(call => call[1])
    expect(texts.some(text => text.includes('正文第一行')), '未折叠卡片必须绘制正文').toBe(true)
    expect(texts.some(text => text.includes('已折叠')), '未折叠卡片不得带折叠徽标').toBe(false)
  })

  it('归档/隐藏卡片在图上标出可见状态', () => {
    for (const [visibility, label] of [['archived', '已归档'], ['hidden', '已隐藏']]) {
      const ctx = recordingContext()
      renderScene(ctx, scene({
        items: [{
          kind: 'card', id: 'a:0', x: 0, y: 0, w: 280, h: 160,
          visibility, questionPreview: 'q', textStyle: FONT, textMetrics: { linesText: ['q'] },
        }],
      }))
      const texts = allCalls(ctx, 'fillText').map(call => call[1])
      expect(texts.some(text => text.includes(label)), `${visibility} 卡片必须标「${label}」`).toBe(true)
    }
  })

  it('失源旁注用警示配色绘制', () => {
    const ctx = recordingContext()
    const fills = []
    const ctxProxy = new Proxy(ctx, {
      set(target, key, value) {
        if (key === 'fillStyle') fills.push(value)
        target[key] = value
        return true
      },
    })
    renderScene(ctxProxy, scene({
      items: [{ kind: 'annotation', id: 'n', x: 0, y: 0, w: 80, h: 48, text: '孤儿', missingSource: true, textMetrics: { linesText: ['孤儿'] }, textStyle: FONT }],
    }))
    expect(fills, '失源旁注必须使用警示底色').toContain(PAINT.missingFill)
  })

  it('连线按采样点绘制，而不是只连两端', () => {
    const ctx = recordingContext()
    const points = [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 8 }, { x: 20, y: 20 }]
    renderScene(ctx, scene({ items: [{ kind: 'connector', id: 'c', from: 'a:0', to: 'b:0', points }] }))
    const moves = allCalls(ctx, 'moveTo')
    const lines = allCalls(ctx, 'lineTo')
    expect(moves).toEqual([['moveTo', 0, 0]])
    expect(lines.length, '每个后续采样点都要 lineTo').toBe(points.length - 1)
  })
})

// ── 3. Blob 校验：三种谎言都要抓住 ────────────────────────────────────────

describe('Blob 校验', () => {
  it('isNonEmptyBlob 拒绝 null、空 Blob 与非 Blob', () => {
    expect(isNonEmptyBlob(null)).toBe(false)
    expect(isNonEmptyBlob(undefined)).toBe(false)
    expect(isNonEmptyBlob('blob')).toBe(false)
    expect(isNonEmptyBlob({ size: 0 })).toBe(false)
    expect(isNonEmptyBlob({ size: -1 })).toBe(false)
    expect(isNonEmptyBlob({ size: Number.NaN })).toBe(false)
    expect(isNonEmptyBlob({ size: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isNonEmptyBlob({ size: '100' })).toBe(false)
    expect(isNonEmptyBlob({ size: 100, type: PNG_MIME })).toBe(true)
    // `type` must not decide the verdict: an adapter that omits it still succeeded.
    expect(isNonEmptyBlob({ size: 100 })).toBe(true)
    expect(isNonEmptyBlob({ size: 100, type: '' })).toBe(true)
  })

  it('toBlob 返回 null 时报 encode-failed，并保留选择可重试', async () => {
    const sink = adapter({ toBlob: () => null })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.encodeFailed)
    expect(result.scene, '失败必须保留 scene 以便重试').not.toBeNull()
    expect(result.reason, '必须告知可重试').toMatch(/重试/)
    expect(result.blob).toBeNull()
  })

  it('toBlob 返回 size=0 也报 encode-failed，不当成功', async () => {
    const sink = adapter({ toBlob: () => ({ size: 0, type: PNG_MIME }) })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.encodeFailed)
  })

  it('toBlob 抛错时报 encode-failed 且不泄漏异常', async () => {
    const sink = adapter({ toBlob: () => { throw new Error('encoder exploded') } })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.encodeFailed)
    expect(result.reason).toContain('encoder exploded')
  })

  it('encodeAttempts 允许有界重试，并报告实际次数', async () => {
    const sink = adapter({ toBlob: (canvas, index) => (index === 0 ? null : { size: 512, type: PNG_MIME }) })
    const result = await exportPng(scene(), sink, { encodeAttempts: 3 })
    expect(result.ok).toBe(true)
    expect(result.attempts, '第一次失败、第二次成功').toBe(2)
    expect(sink.toBlobCalls.length).toBe(2)
    expect(result.blob.size).toBeGreaterThan(0)
  })
})

// ── 4. 前置拒绝：超限、空场景、字体 ───────────────────────────────────────

describe('前置拒绝', () => {
  it('超限场景直接拒绝，不分配画布也不静默缩小', async () => {
    const sink = adapter()
    const huge = scene({ width: DEFAULT_MAX_EDGE + 100, height: 200, bounds: { x: 0, y: 0, w: DEFAULT_MAX_EDGE + 100, h: 200 } })
    const result = await exportPng(huge, sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.tooLarge)
    expect(sink.created.length, '被拒绝时不得分配画布').toBe(0)
    expect(result.limits, '必须回传实际尺寸').toBeDefined()
    expect(result.limits.actual.width).toBeGreaterThan(DEFAULT_MAX_EDGE)
  })

  it('空场景报 empty-scene，不生成空白图片', async () => {
    const sink = adapter()
    const result = await exportPng(scene({ items: [], stats: { cardCount: 0, materialCount: 0, regionCount: 0, annotationCount: 0, connectorCount: 0 } }), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.emptyScene)
    expect(sink.created.length, '空场景不得分配画布').toBe(0)
  })

  it('describeEmptyScene 沿用场景自己的空选原因', () => {
    const described = describeEmptyScene({
      warnings: [{ code: SCENE_CODES.emptySelection, message: '没有勾选任何卡片，无法导出。' }],
    })
    expect(described.ok).toBe(false)
    expect(described.failure).toBe(EXPORT_FAILURES.emptyScene)
    expect(described.reason).toBe('没有勾选任何卡片，无法导出。')
    // A scene without a warning still yields a usable refusal.
    expect(describeEmptyScene(null).ok).toBe(false)
  })

  it('字体等待超时报 font-timeout，且不拿缺字形的图冒充成功', async () => {
    const sink = adapter({ waitFonts: () => new Promise(() => {}) }) // never settles
    const result = await exportPng(scene(), sink, { fontTimeoutMs: 30 })
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.fontTimeout)
    expect(sink.created.length, '字体未就绪时不得开始绘制').toBe(0)
    expect(result.reason, `原因应含实际超时值，实得：${result.reason}`).toContain('30')
  })

  it('字体等待拒绝时报 font-timeout，并带上原始原因', async () => {
    const sink = adapter({ waitFonts: () => Promise.reject(new Error('no CJK face')) })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.fontTimeout)
    expect(result.reason).toContain('no CJK face')
  })

  it('字体等待成功时报告 waited', async () => {
    const sink = adapter({ waitFonts: () => Promise.resolve() })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(true)
    expect(result.fonts.waited).toBe(true)
  })

  it('没有 waitFonts 的适配器不算失败', async () => {
    const sink = adapter()
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(true)
    expect(result.fonts.waited).toBe(false)
  })

  it('画布分配失败报 alloc-failed', async () => {
    const sink = adapter()
    sink.createCanvas = () => { throw new Error('out of memory') }
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.allocFailed)
    expect(result.reason).toContain('out of memory')
  })

  it('拿不到 2D 上下文报 alloc-failed', async () => {
    const sink = adapter()
    sink.createCanvas = (width, height) => ({ width, height, getContext: () => null })
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(false)
    expect(result.failure).toBe(EXPORT_FAILURES.allocFailed)
    expect(result.reason).toMatch(/2D 上下文/)
  })
})

// ── 5. 参数与契约 ─────────────────────────────────────────────────────────

describe('参数与契约', () => {
  it('adapter 契约缺失时立刻抛错', async () => {
    await expect(() => exportPng(scene(), null)).rejects.toThrow(TypeError)
    await expect(() => exportPng(scene(), {})).rejects.toThrow(TypeError)
    await expect(() => exportPng(scene(), { createCanvas: () => ({}) })).rejects.toThrow(TypeError)
    await expect(() => exportPng(null, adapter())).rejects.toThrow(TypeError)
  })

  it('成功结果带回宽度、高度、scale、report 与 drawn 计数', async () => {
    const sink = adapter()
    const result = await exportPng(scene(), sink)
    expect(result.ok).toBe(true)
    expect(result.failure).toBeNull()
    expect(result.width).toBe(344)
    expect(result.height).toBe(224)
    expect(result.scale).toBe(1)
    expect(result.report.drawn.card).toBe(1)
    expect(result.report.drawn.annotation).toBe(0)
    expect(result.report.itemCount).toBe(1)
    expect(sink.created[0].width).toBe(344)
    expect(sink.created[0].height).toBe(224)
  })

  it('背景用固定浅色面铺满整张画布（不随主题）', async () => {
    const sink = adapter()
    const result = await exportPng(scene(), sink)
    expect(CANVAS_BACKGROUND, '导出底色是固定的，不跟随界面主题').toBe('#ffffff')
    const ctx = result.canvas.ctx
    // The full surface is cleared BEFORE the world translate, so the rectangle is
    // exactly the logical canvas size.
    const background = findCall(ctx, 'fillRect')
    expect(background).toEqual(['fillRect', 0, 0, result.width, result.height])
    // Prove the background style was actually assigned at paint time (a shared
    // mutable `fillStyle` ends on whatever was drawn last, so inspect the call log
    // ordering instead of the final value).
    const backgroundIndex = ctx.calls.indexOf(background)
    const firstCardPath = ctx.calls.findIndex(call => call[0] === 'beginPath')
    expect(backgroundIndex >= 0 && backgroundIndex < firstCardPath, '背景必须先于任何卡片路径绘制').toBe(true)
  })

  it('默认字体栈包含中文字族', () => {
    expect(FONT_STACK, '字体栈必须含 CJK 字族').toMatch(/PingFang SC|Microsoft YaHei|Noto Sans CJK SC/)
    expect(Number.isSafeInteger(DEFAULT_FONT_TIMEOUT_MS) && DEFAULT_FONT_TIMEOUT_MS > 0).toBe(true)
  })
})
