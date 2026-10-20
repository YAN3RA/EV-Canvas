// @ts-nocheck -- 与 test/canvas-layout.test.ts 一致：断言精确，类型噪声不阻塞行为迁移。
// 迁移自 dsh-synapnova@3fd1d00 test/canvas-materials.test.js

/**
 * Material import — byte ceiling, strict UTF-8, frozen value shape.
 *
 * The frozen contract (shared/schema.js) allows `bytes` and `text` up to
 * 2 MiB each, so every boundary is pinned here: one byte under, exactly at,
 * one byte over. Decoding is pinned too, because a material that silently lost
 * bytes to U+FFFD cannot be trusted as a source, and a BOM must be stripped
 * from the text while staying counted in `bytes`.
 */
import { describe, it, expect } from 'vitest'
import {
  MATERIAL_BYTE_LIMIT,
  MATERIAL_COMMAND_KINDS,
  MATERIAL_FIELDS,
  MATERIAL_REJECT,
  MaterialDecodeError,
  assertMaterial,
  assertStrictIsoDate,
  byteLengthOf,
  createMaterial,
  decodeMaterialText,
  importMaterialFile,
  isStrictIsoDate,
  materialToCommandIntent,
  utf8ByteLength,
  validateMaterialFile,
} from '@/canvas/materials'
import { InputError, createFrozenState, normalizeFrozenState } from '@/shared/schema'

const ISO = '2026-10-18T09:00:00.000Z'
const LIMIT = 2 * 1024 * 1024
const BOM = [0xef, 0xbb, 0xbf]

/** Bytes for a string, through the platform encoder (never Buffer). */
function utf8(text) {
  return new TextEncoder().encode(text)
}

/** A frozen document holding exactly one material, for schema agreement checks. */
function documentWith(material) {
  return {
    ...createFrozenState(ISO),
    workspaces: [{
      id: 'ws-1',
      kind: 'manual',
      cwd: 'C:\\synthetic',
      title: '工作区',
      revision: 1,
      projectionEpoch: 1,
      createdAt: ISO,
      updatedAt: ISO,
      projection: { threads: [] },
      layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      materials: [material],
      regions: [],
      annotations: [],
    }],
  }
}

describe('canvas/materials', () => {
  it('常量与字段白名单和冻结 schema 一致', () => {
    expect(MATERIAL_BYTE_LIMIT).toBe(LIMIT)
    expect([...MATERIAL_FIELDS]).toEqual(['id', 'name', 'importedAt', 'bytes', 'text'])
    expect(MATERIAL_COMMAND_KINDS.addMaterial).toBe('addMaterial')
  })

  it('字节上限：上限前一个字节通过', () => {
    const result = validateMaterialFile({ name: 'a.txt', bytes: LIMIT - 1 })
    expect(result.ok).toBe(true)
    expect(result.reason).toBe(null)
    expect(result.bytes).toBe(LIMIT - 1)
    expect(result.limit).toBe(LIMIT)
  })

  it('字节上限：正好等于上限通过（边界含等号）', () => {
    const result = validateMaterialFile({ name: 'a.txt', bytes: LIMIT })
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(LIMIT)
  })

  it('字节上限：超出一个字节被拒绝并给出可辨识 reason', () => {
    const result = validateMaterialFile({ name: 'a.txt', bytes: LIMIT + 1 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(MATERIAL_REJECT.tooLarge)
    expect(result.bytes).toBe(LIMIT + 1)
    expect(result.message).toMatch(/2MiB/)
    expect(result.message).toMatch(/a\.txt/)
  })

  it('字节上限：空文件与 ArrayBuffer/TypedArray 形态都被接受', () => {
    expect(validateMaterialFile({ name: 'empty.txt', bytes: 0 }).ok).toBe(true)
    const buffer = new ArrayBuffer(LIMIT)
    expect(validateMaterialFile({ name: 'big.bin', bytes: buffer }).ok).toBe(true)
    expect(validateMaterialFile({ name: 'big.bin', bytes: new Uint8Array(buffer) }).ok).toBe(true)
    const over = new ArrayBuffer(LIMIT + 1)
    expect(validateMaterialFile({ name: 'over.bin', bytes: over }).reason).toBe(MATERIAL_REJECT.tooLarge)
    // A view into a larger buffer measures only the view.
    const view = new Uint8Array(new ArrayBuffer(LIMIT + 10), 0, LIMIT)
    expect(validateMaterialFile({ name: 'view.bin', bytes: view }).ok).toBe(true)
  })

  it('字节上限：非法大小被拒绝，不被强转', () => {
    for (const bytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12', null, {}, undefined]) {
      const result = validateMaterialFile({ name: 'a.txt', bytes })
      expect(result.ok, String(bytes)).toBe(false)
      expect(result.reason, String(bytes)).toBe(MATERIAL_REJECT.invalidBytes)
    }
    expect(validateMaterialFile({ name: 42, bytes: 1 }).reason).toBe(MATERIAL_REJECT.invalidName)
  })

  it('byteLengthOf 只接受真实字节量', () => {
    expect(byteLengthOf(0)).toBe(0)
    expect(byteLengthOf(new Uint8Array([1, 2, 3]))).toBe(3)
    expect(byteLengthOf(new ArrayBuffer(7))).toBe(7)
    expect(byteLengthOf(-0)).toBe(0)
    expect(byteLengthOf(2 ** 60)).toBe(null)
    expect(byteLengthOf('3')).toBe(null)
    expect(byteLengthOf(null)).toBe(null)
  })

  it('decodeMaterialText：普通 ASCII 与中文按 UTF-8 解码', () => {
    expect(decodeMaterialText(utf8('hello'))).toEqual({ text: 'hello', hadBom: false, bytes: 5 })
    const chinese = '第一行中文\n第二行 emoji 🚀'
    const decoded = decodeMaterialText(utf8(chinese))
    expect(decoded.text).toBe(chinese)
    expect(decoded.hadBom).toBe(false)
    expect(decoded.bytes).toBe(utf8ByteLength(chinese))
    // 4-byte code point is one character but four bytes.
    expect(utf8ByteLength('🚀')).toBe(4)
  })

  it('decodeMaterialText：BOM 被剥离但记入 hadBom，bytes 仍是原始字节数', () => {
    const payload = new Uint8Array([...BOM, ...utf8('你好')])
    const decoded = decodeMaterialText(payload)
    expect(decoded.text).toBe('你好')
    expect(decoded.hadBom).toBe(true)
    expect(decoded.bytes).toBe(3 + 6)
    // No BOM means no stripping, and a BOM-only file decodes to the empty string.
    expect(decodeMaterialText(utf8('你')).hadBom).toBe(false)
    const bomOnly = decodeMaterialText(new Uint8Array(BOM))
    expect(bomOnly.text).toBe('')
    expect(bomOnly.hadBom).toBe(true)
    expect(bomOnly.bytes).toBe(3)
  })

  it('decodeMaterialText：空载荷得到空字符串', () => {
    expect(decodeMaterialText(new ArrayBuffer(0))).toEqual({ text: '', hadBom: false, bytes: 0 })
  })

  it('decodeMaterialText：坏 UTF-8 抛可辨识错误，绝不静默替换成 U+FFFD', () => {
    const cases = [
      [0xff, 0xfe], // never-valid bytes
      [0xe4, 0xb8], // truncated 3-byte sequence (中)
      [0xc3], // lone lead byte
      [0x80], // stray continuation
      [0xf0, 0x9f, 0x9a], // truncated 4-byte sequence (🚀)
      [0xed, 0xa0, 0x80], // UTF-8 encoded surrogate half
    ]
    for (const bytes of cases) {
      let thrown = null
      try {
        decodeMaterialText(new Uint8Array(bytes))
      } catch (error) {
        thrown = error
      }
      expect(thrown, bytes.join(',')).toBeInstanceOf(MaterialDecodeError)
      expect(thrown.code).toBe(MATERIAL_REJECT.invalidUtf8)
      expect(thrown.bytes).toBe(bytes.length)
      // The failure must not leak a replacement-character string.
      expect(Object.hasOwn(thrown, 'text')).toBe(false)
    }
  })

  it('createMaterial：产出符合冻结 schema 的五字段 material', () => {
    const material = createMaterial({ name: '笔记.md', bytes: 12, text: '# 标题\n正文', importedAt: ISO, id: '018f0000-0000-4000-8000-000000000001' })
    expect(Object.keys(material).sort()).toEqual([...MATERIAL_FIELDS].sort())
    expect(material.name).toBe('笔记.md')
    expect(material.bytes).toBe(12)
    expect(material.importedAt).toBe(ISO)
    expect(Object.isFrozen(material)).toBe(true)
    const { state } = normalizeFrozenState(documentWith(material))
    expect(state.workspaces[0].materials[0]).toEqual({ id: material.id, name: material.name, importedAt: ISO, bytes: 12, text: '# 标题\n正文' })
  })

  it('createMaterial：空文件合法（text 为空串、bytes 0）', () => {
    const material = createMaterial({ name: 'empty.txt', bytes: 0, text: '', importedAt: ISO })
    expect(material.text).toBe('')
    expect(material.bytes).toBe(0)
    expect(material.name).toBe('empty.txt')
    expect(() => normalizeFrozenState(documentWith(material))).not.toThrow()
  })

  it('createMaterial：bytes 缺省时按 text 的 UTF-8 长度补齐', () => {
    const material = createMaterial({ name: 'auto.txt', text: '中文', importedAt: ISO })
    expect(material.bytes).toBe(6)
    expect(createMaterial({ name: 'auto2.txt', text: '', importedAt: ISO }).bytes).toBe(0)
  })

  it('createMaterial：text 或 bytes 超限抛 RangeError', () => {
    expect(() => createMaterial({ name: 'a', text: 'x'.repeat(LIMIT + 1), importedAt: ISO })).toThrow(RangeError)
    expect(() => createMaterial({ name: 'a', text: 'ok', bytes: LIMIT + 1, importedAt: ISO })).toThrow(RangeError)
    // Exactly at the ceiling is legal for both numbers.
    const atLimit = createMaterial({ name: 'a', text: 'x'.repeat(LIMIT), bytes: LIMIT, importedAt: ISO })
    expect(atLimit.bytes).toBe(LIMIT)
    expect(atLimit.text.length).toBe(LIMIT)
    expect(() => normalizeFrozenState(documentWith(atLimit))).not.toThrow()
  })

  it('importedAt 必须是严格 ISO（Z 或显式偏移），与 iso-date 口径一致', () => {
    for (const value of ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.123Z', '2026-01-01T23:59:59+08:00', '2026-01-01T00:00:00.999-12:00', '2024-02-29T00:00:00.000Z']) {
      expect(isStrictIsoDate(value), value).toBe(true)
      expect(assertStrictIsoDate(value)).toBe(value)
      expect(createMaterial({ name: 'a', text: '', importedAt: value }).importedAt).toBe(value)
    }
    const illegal = [
      '2026-01-01',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00.000',
      ' 2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z ',
      '2026-01-01 00:00:00.000Z',
      '2026/01/01T00:00:00.000Z',
      '2026-01-01t00:00:00.000z',
      '2026-02-29T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:00:60Z',
      '2026-01-01T00:00:00.000+24:00',
      '2026-01-01T00:00:00.000+0800',
      '',
    ]
    for (const value of illegal) {
      expect(isStrictIsoDate(value), JSON.stringify(value)).toBe(false)
      expect(() => assertStrictIsoDate(value), JSON.stringify(value)).toThrow(TypeError)
      expect(() => createMaterial({ name: 'a', text: '', importedAt: value }), JSON.stringify(value)).toThrow(TypeError)
    }
    for (const value of [null, undefined, 1_760_000_000_000, new Date(ISO), {}, [ISO]]) {
      expect(isStrictIsoDate(value), String(value)).toBe(false)
    }
    // The schema agrees on every rejected literal.
    expect(() => normalizeFrozenState(documentWith({ id: '018f0000-0000-4000-8000-000000000002', name: 'a', text: '', bytes: 0, importedAt: '2026-01-01T00:00:00.000' }))).toThrow(InputError)
  })

  it('createMaterial：importedAt 缺省取当前时刻，严格 ISO 带 Z', () => {
    const material = createMaterial({ name: 'a', text: '' })
    expect(material.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(isStrictIsoDate(material.importedAt)).toBe(true)
    // A fixed clock keeps the default deterministic in tests.
    expect(createMaterial({ name: 'a', text: '', now: Date.parse(ISO) }).importedAt).toBe(ISO)
    expect(createMaterial({ name: 'a', text: '', now: new Date(ISO) }).importedAt).toBe(ISO)
  })

  it('createMaterial：id 缺省为 UUID，显式 id 必须合法', () => {
    const material = createMaterial({ name: 'a', text: '' })
    expect(material.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (const id of ['', 'not-a-uuid', '018f0000-0000-0000-8000-000000000001', '018f0000-0000-4000-0000-000000000001']) {
      expect(() => createMaterial({ name: 'a', text: '', id }), id).toThrow(TypeError)
    }
  })

  it('materialToCommandIntent：patch 形状与 commands.js 一致，before 为 null', () => {
    const material = createMaterial({ name: 'a.txt', bytes: 3, text: 'abc', importedAt: ISO, id: '018f0000-0000-4000-8000-000000000003' })
    const intent = materialToCommandIntent(material)
    expect(intent.kind).toBe('addMaterial')
    expect(intent.patches.length).toBe(1)
    const [patch] = intent.patches
    expect(Object.keys(patch).sort()).toEqual(['after', 'area', 'before', 'id'])
    expect(patch.area).toBe('materials')
    expect(patch.id).toBe(material.id)
    expect(patch.before).toBe(null)
    expect(patch.after).toEqual({ id: material.id, name: 'a.txt', importedAt: ISO, bytes: 3, text: 'abc' })
    // Intent and its patches are frozen: a caller cannot mutate a pending commit.
    expect(Object.isFrozen(intent) && Object.isFrozen(intent.patches) && Object.isFrozen(patch.after)).toBe(true)
  })

  it('materialToCommandIntent：inverse 只是一次 before/after 交换（一次 commit 可撤销）', () => {
    const material = createMaterial({ name: 'a.txt', text: 'abc', importedAt: ISO })
    const intent = materialToCommandIntent(material)
    const undo = { kind: intent.kind, patches: intent.patches.map(patch => ({ area: patch.area, id: patch.id, before: patch.after, after: patch.before })) }
    expect(undo.patches[0].before.text).toBe('abc')
    expect(undo.patches[0].after).toBe(null)
  })

  it('assertMaterial：只保留五个白名单字段，不携带路径或句柄', () => {
    // `__proto__` as an OWN data property is exactly what JSON.parse produces, so
    // the input is built that way instead of with an object literal.
    const raw = JSON.parse(`{
    "id": "018f0000-0000-4000-8000-000000000004",
    "name": "a.txt",
    "importedAt": "${ISO}",
    "bytes": 3,
    "text": "abc",
    "path": "C:\\\\secret\\\\a.txt",
    "file": { "handle": 1 },
    "__proto__": { "polluted": true }
  }`)
    expect(Object.hasOwn(raw, '__proto__')).toBe(true)
    const material = assertMaterial(raw)
    expect(Object.keys(material).sort()).toEqual([...MATERIAL_FIELDS].sort())
    expect(Object.hasOwn(material, 'path')).toBe(false)
    expect(Object.hasOwn(material, 'file')).toBe(false)
    expect(Object.getPrototypeOf(material)).toBe(Object.prototype)
    expect(material.polluted).toBe(undefined)
    // A patch built from it carries the same clean value.
    const intent = materialToCommandIntent(raw)
    expect(Object.keys(intent.patches[0].after).sort()).toEqual([...MATERIAL_FIELDS].sort())
  })

  it('assertMaterial：越界与坏时间被拒绝', () => {
    const base = { id: '018f0000-0000-4000-8000-000000000005', name: 'a', importedAt: ISO, bytes: 0, text: '' }
    expect(() => assertMaterial({ ...base, bytes: LIMIT + 1 })).toThrow(RangeError)
    expect(() => assertMaterial({ ...base, text: 'x'.repeat(LIMIT + 1) })).toThrow(RangeError)
    expect(() => assertMaterial({ ...base, importedAt: '2026-01-01' })).toThrow(TypeError)
    expect(() => assertMaterial({ ...base, id: 'nope' })).toThrow(TypeError)
    expect(() => assertMaterial({ ...base, name: 1 })).toThrow(TypeError)
    expect(() => assertMaterial(null)).toThrow(TypeError)
  })

  it('importMaterialFile：一次调用完成 校验 → 解码 → 取值', () => {
    const payload = new Uint8Array([...BOM, ...utf8('中文内容')])
    const result = importMaterialFile({ name: '中文.txt', data: payload, importedAt: ISO, id: '018f0000-0000-4000-8000-000000000006' })
    expect(result.ok).toBe(true)
    expect(result.reason).toBe(null)
    expect(result.hadBom).toBe(true)
    expect(result.material.text).toBe('中文内容')
    expect(result.material.bytes).toBe(payload.length)
    expect(result.material.name).toBe('中文.txt')
    expect(() => normalizeFrozenState(documentWith(result.material))).not.toThrow()

    const empty = importMaterialFile({ name: 'empty.txt', data: new ArrayBuffer(0), importedAt: ISO })
    expect(empty.ok).toBe(true)
    expect(empty.material.text).toBe('')
    expect(empty.material.bytes).toBe(0)
  })

  it('importMaterialFile：超限与坏 UTF-8 都以 ok:false 回报，不抛异常', () => {
    const tooLarge = importMaterialFile({ name: 'big.bin', data: new ArrayBuffer(LIMIT + 1), importedAt: ISO })
    expect(tooLarge.ok).toBe(false)
    expect(tooLarge.reason).toBe(MATERIAL_REJECT.tooLarge)
    expect(tooLarge.material).toBe(null)

    const bad = importMaterialFile({ name: 'bad.txt', data: new Uint8Array([0xff, 0xfe]), importedAt: ISO })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe(MATERIAL_REJECT.invalidUtf8)
    expect(bad.material).toBe(null)
  })

  it('utf8ByteLength：按 UTF-8 计数，不是 UTF-16 长度', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中')).toBe(3)
    expect(utf8ByteLength('🚀')).toBe(4)
    expect(utf8ByteLength('a中🚀')).toBe(1 + 3 + 4)
    expect(() => utf8ByteLength(1)).toThrow(TypeError)
  })
})
