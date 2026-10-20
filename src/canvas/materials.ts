// 来源: dsh-synapnova@3fd1d00 canvas/materials.js

/**
 * Material (imported file) — pure import/validation layer.
 *
 * Pure module: no DOM, no Store, no fs, no `node:buffer`. Everything here runs
 * unchanged in the browser (TextEncoder / TextDecoder / crypto.randomUUID are
 * platform globals) and in the Node test runner, so the wiring layer never has
 * to fork the rules per environment.
 *
 * The frozen document contract (shared/schema.js, materials branch) is:
 *
 *   { id, name, importedAt, bytes, text }
 *
 *   - `id`          unique UUID (any version 1–8, RFC variant 8/9/a/b)
 *   - `name`        text (empty allowed)
 *   - `importedAt`  strict ISO-8601 literal, `Z` or explicit `±HH:mm`
 *   - `bytes`       non-negative safe integer ≤ 2 MiB
 *   - `text`        text whose UTF-8 encoding is ≤ 2 MiB
 *
 * Two limits, not one: `bytes` is the ORIGINAL file size, `text` is the decoded
 * content. A file with a UTF-8 BOM differs by exactly three bytes, so the two
 * numbers are related but never required to be equal.
 *
 * Import never keeps a reference to the source: no `File`, no path, no handle.
 * "Do not follow later changes to the original file" is therefore structural —
 * the material is a value snapshot, and `assertMaterial()` re-copies the five
 * whitelisted fields so a caller cannot smuggle a handle or a path into a patch.
 *
 * TS 迁移说明（dsh-evcanvas）：本文件行为与原 JS 逐字一致，只补类型标注；
 * 未关闭类型检查，且不 import 任何 `node:*` 模块。
 */

/** Byte ceiling shared by `bytes` and the UTF-8 encoding of `text`. */
export const MATERIAL_BYTE_LIMIT = 2 * 1024 * 1024

/** One frozen material field name. */
export type MaterialField = 'id' | 'name' | 'importedAt' | 'bytes' | 'text'

/** The frozen material field whitelist (mirrors shared/schema.js). */
export const MATERIAL_FIELDS = Object.freeze(['id', 'name', 'importedAt', 'bytes', 'text'] as const)

/**
 * Command kinds this module can emit.
 *
 * `canvas/commands.js` owns layout/region/annotation kinds only; there is no
 * material kind there and this module deliberately does not edit it. The intent
 * shape is nevertheless identical (`{ kind, patches: [{ area, id, before,
 * after }] }`) so the same commit path and the same undo stack accept it once
 * the wiring layer registers `materials` as a patch area.
 */
export const MATERIAL_COMMAND_KINDS = Object.freeze({ addMaterial: 'addMaterial' } as const)

/** Union of the command kinds emitted here. */
export type MaterialCommandKind = typeof MATERIAL_COMMAND_KINDS[keyof typeof MATERIAL_COMMAND_KINDS]

/** Stable, machine-checkable reason codes for `validateMaterialFile`. */
export const MATERIAL_REJECT = Object.freeze({
  invalidBytes: 'invalid-bytes',
  invalidName: 'invalid-name',
  tooLarge: 'too-large',
  invalidUtf8: 'invalid-utf8',
} as const)

/** Union of the rejection reason codes above. */
export type MaterialRejectReason = typeof MATERIAL_REJECT[keyof typeof MATERIAL_REJECT]

/**
 * The frozen material value: exactly the five document fields.
 *
 * The fields are `readonly` because `createMaterial` / `materialToCommandIntent`
 * deep-freeze the produced object; the type mirrors that promise.
 */
export interface Material {
  readonly id: string
  readonly name: string
  readonly importedAt: string
  readonly bytes: number
  readonly text: string
}

/** Result of `validateMaterialFile` — size check only, never throws on input. */
export interface MaterialValidation {
  readonly ok: boolean
  readonly reason: MaterialRejectReason | null
  readonly message: string | null
  readonly bytes: number | null
  readonly limit: number
}

/** Result of `decodeMaterialText`. */
export interface DecodedMaterial {
  readonly text: string
  readonly hadBom: boolean
  readonly bytes: number
}

/** Result of `importMaterialFile` — size → decode → value, one call. */
export interface MaterialImportResult {
  readonly ok: boolean
  readonly reason: MaterialRejectReason | null
  readonly message: string | null
  readonly material: Material | null
  readonly hadBom: boolean
}

/**
 * One patch inside a material command intent.
 *
 * Same patch shape as `canvas/commands.js` (`{ area, id, before, after }`), with
 * `area: 'materials'`. An add is exactly one forward patch with `before: null`,
 * so its undo is the same patch with before/after swapped.
 */
export interface MaterialPatch {
  readonly area: 'materials'
  readonly id: string
  readonly before: Material | null
  readonly after: Material | null
}

/** One commit intent that adds a material. */
export interface MaterialCommandIntent {
  readonly kind: MaterialCommandKind
  readonly patches: readonly MaterialPatch[]
}

/** A byte count, an `ArrayBuffer`, or any view over one. */
export type BytesLike = number | ArrayBuffer | ArrayBufferView

/** Named input of `validateMaterialFile`. */
export interface MaterialFileCandidate {
  readonly name?: unknown
  readonly bytes?: unknown
}

/** Options of `createMaterial`. */
export interface CreateMaterialInput {
  name?: string
  bytes?: BytesLike
  text?: string
  importedAt?: string
  id?: string
  now?: number | Date
}

/** Options of `importMaterialFile`. */
export interface ImportMaterialFileInput {
  name?: string
  data?: ArrayBuffer | ArrayBufferView
  importedAt?: string
  id?: string
  now?: number | Date
}

/** Options of the `MaterialDecodeError` constructor. */
export interface MaterialDecodeErrorOptions {
  bytes?: number
  cause?: unknown
}

const ISO_DATE_LITERAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const ISO_DATE_MESSAGE = (field: string): string => `${field} 必须是严格 ISO8601 时间：YYYY-MM-DDTHH:mm:ss（可选 1–3 位毫秒）后接 Z 或 ±HH:mm`

/** UUID shape accepted by shared/schema.js for a material id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value) as T
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value) as T
  }
  return value
}

let sharedEncoder: TextEncoder | null = null

/** One shared TextEncoder; the browser global, never `node:buffer`. */
function utf8Encoder(): TextEncoder {
  sharedEncoder ??= new TextEncoder()
  return sharedEncoder
}

/** UTF-8 byte length of a string (BOM-free; the caller's text is post-decode). */
export function utf8ByteLength(text: unknown): number {
  if (typeof text !== 'string') throw new TypeError('utf8ByteLength 需要字符串')
  return utf8Encoder().encode(text).length
}

/**
 * Strict ISO-8601 check, same grammar and calendar rules as shared/schema.js.
 *
 * Duplicated on purpose: importing `shared/schema.js` would pull `node:crypto`
 * into the browser bundle. The tests assert both implementations agree by
 * feeding the produced material through `normalizeFrozenState`.
 */
export function isStrictIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DATE_LITERAL.exec(value)
  if (match === null) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  if (month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  // `month` is already narrowed to 1–12 above, so the index is always present.
  const lastDay = month === 2 && leap ? 29 : DAYS_PER_MONTH[month - 1]!
  if (day < 1 || day > lastDay) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (match[8] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false
  return true
}

/** Same check, throwing; returns the input untouched (never re-spelled). */
export function assertStrictIsoDate(value: unknown, field = 'importedAt'): string {
  if (!isStrictIsoDate(value)) throw new TypeError(ISO_DATE_MESSAGE(field))
  return value
}

/**
 * Byte length of a file payload, or `null` when the value is not a size.
 *
 * Accepts a plain count (`number`), an `ArrayBuffer`, or any `ArrayBufferView`
 * (`Uint8Array`, `DataView`, …). A negative, fractional or unsafe count is not
 * a size and is rejected instead of being coerced.
 */
export function byteLengthOf(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    // `-0` is a legal zero but would persist as `-0` in JSON; normalise it.
    return value === 0 ? 0 : value
  }
  if (value instanceof ArrayBuffer) return value.byteLength
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  return null
}

/**
 * Validate one import candidate against the 2 MiB byte ceiling.
 *
 * Returns `{ ok, reason, message, bytes, limit }`; `reason` is `null` on
 * success and one of `MATERIAL_REJECT` otherwise. Exactly at the limit passes,
 * one byte over is rejected — the boundary is inclusive by contract.
 *
 * `name` is only checked for type (the frozen shape requires text); an omitted
 * name is allowed here because the byte ceiling is this function's job.
 */
export function validateMaterialFile(input: unknown): MaterialValidation {
  if (!isPlainObject(input)) throw new TypeError('validateMaterialFile 需要 { name, bytes }')
  const { name } = input
  if (name !== undefined && typeof name !== 'string') {
    return {
      ok: false,
      reason: MATERIAL_REJECT.invalidName,
      message: 'material.name 必须是文本',
      bytes: null,
      limit: MATERIAL_BYTE_LIMIT,
    }
  }
  const bytes = byteLengthOf(input.bytes)
  if (bytes === null) {
    return {
      ok: false,
      reason: MATERIAL_REJECT.invalidBytes,
      message: 'material.bytes 必须是非负安全整数或字节缓冲',
      bytes: null,
      limit: MATERIAL_BYTE_LIMIT,
    }
  }
  if (bytes > MATERIAL_BYTE_LIMIT) {
    const label = typeof name === 'string' && name !== '' ? `「${name}」` : ''
    return {
      ok: false,
      reason: MATERIAL_REJECT.tooLarge,
      message: `${label}超出 2MiB 字节上限（${bytes} > ${MATERIAL_BYTE_LIMIT}）`,
      bytes,
      limit: MATERIAL_BYTE_LIMIT,
    }
  }
  return { ok: true, reason: null, message: null, bytes, limit: MATERIAL_BYTE_LIMIT }
}

/** A decode failure that can be told apart from a programming error. */
export class MaterialDecodeError extends Error {
  // `declare` (not plain class fields): ES2022 class fields would emit as own
  // properties initialised to `undefined`, which would change the runtime shape
  // this module promises — `bytes` must stay ABSENT when the caller omits it.
  declare readonly code: MaterialRejectReason

  declare readonly bytes?: number

  constructor(message: string, options: MaterialDecodeErrorOptions = {}) {
    super(message)
    this.name = 'MaterialDecodeError'
    this.code = MATERIAL_REJECT.invalidUtf8
    if (options.bytes !== undefined) this.bytes = options.bytes
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function toUint8Array(input: unknown): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('decodeMaterialText 需要 ArrayBuffer 或 TypedArray')
}

const BOM_BYTES = [0xef, 0xbb, 0xbf] as const

/**
 * Decode a file payload as UTF-8.
 *
 * `fatal: true` is the point: malformed input throws instead of being silently
 * rewritten to U+FFFD, because a material that quietly lost bytes cannot be
 * trusted as a source. The BOM is stripped from `text` but remembered in
 * `hadBom` (the original byte count stays in `bytes`).
 *
 * Returns `{ text, hadBom, bytes }`.
 */
export function decodeMaterialText(input: unknown): DecodedMaterial {
  const view = toUint8Array(input)
  const hadBom = view.length >= 3 && view[0] === BOM_BYTES[0] && view[1] === BOM_BYTES[1] && view[2] === BOM_BYTES[2]
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view)
  } catch (error) {
    throw new MaterialDecodeError(`文件不是合法 UTF-8（${view.length} 字节）`, { bytes: view.length, cause: error })
  }
  // TextDecoder already drops the BOM with the default `ignoreBOM: false`; the
  // explicit strip keeps the promise true if an implementation differs.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, hadBom, bytes: view.length }
}

function generateMaterialId(): string {
  const host = globalThis.crypto as Crypto | undefined
  if (host !== undefined && typeof host.randomUUID === 'function') return host.randomUUID()
  throw new TypeError('createMaterial 需要显式 id：当前环境没有 crypto.randomUUID')
}

/**
 * Build one frozen material value.
 *
 * `bytes` is the original file size when known; omit it and the UTF-8 length of
 * `text` is used instead. Both `bytes` and the UTF-8 length of `text` are
 * checked against the 2 MiB ceiling, exactly like the frozen schema does.
 *
 * An empty file is legal: `text === ''`, `bytes === 0`.
 * `importedAt` defaults to now (strict ISO with `Z`); `id` defaults to a v4
 * UUID. Pass `now` to make the default deterministic in tests.
 */
export function createMaterial({ name = '', bytes, text = '', importedAt, id, now }: CreateMaterialInput = {}): Material {
  if (typeof name !== 'string') throw new TypeError('material.name 必须是文本')
  if (typeof text !== 'string') throw new TypeError('material.text 必须是文本')
  const textBytes = utf8ByteLength(text)
  if (textBytes > MATERIAL_BYTE_LIMIT) throw new RangeError(`material.text 超出 2MiB 字节上限（${textBytes} > ${MATERIAL_BYTE_LIMIT}）`)
  const declared = byteLengthOf(bytes)
  if (bytes !== undefined && declared === null) throw new TypeError('material.bytes 必须是非负安全整数或字节缓冲')
  const resolvedBytes = declared === null ? textBytes : declared
  if (resolvedBytes > MATERIAL_BYTE_LIMIT) throw new RangeError(`material.bytes 超出 2MiB 字节上限（${resolvedBytes} > ${MATERIAL_BYTE_LIMIT}）`)
  const at = importedAt === undefined
    ? new Date(now === undefined ? Date.now() : (now instanceof Date ? now.getTime() : now)).toISOString()
    : assertStrictIsoDate(importedAt, 'importedAt')
  const materialId = id === undefined ? generateMaterialId() : assertMaterialId(id)
  return deepFreeze({ id: materialId, name, importedAt: at, bytes: resolvedBytes, text })
}

function assertMaterialId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new TypeError('material.id 必须是 UUID')
  return id
}

/**
 * Re-validate a material and copy ONLY the five frozen fields.
 *
 * This is the boundary that keeps a handle or a path out of the document: an
 * extra `path`, `file`, `handle` or `__proto__` key on the input is dropped, not
 * carried into the patch.
 */
export function assertMaterial(material: unknown): Material {
  if (!isPlainObject(material)) throw new TypeError('material 必须是对象')
  const { id, name, importedAt, bytes, text } = material
  const materialId = assertMaterialId(id)
  if (typeof name !== 'string') throw new TypeError('material.name 必须是文本')
  if (typeof text !== 'string') throw new TypeError('material.text 必须是文本')
  // `typeof` first: `Number.isSafeInteger` is not a type guard, and a non-number
  // already fails it, so this is the same rejection with a narrower static type.
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MATERIAL_BYTE_LIMIT) throw new RangeError('material.bytes 超出 2MiB 字节上限')
  if (utf8ByteLength(text) > MATERIAL_BYTE_LIMIT) throw new RangeError('material.text 超出 2MiB 字节上限')
  const at = assertStrictIsoDate(importedAt, 'importedAt')
  return { id: materialId, name, importedAt: at, bytes, text }
}

/**
 * One commit intent that adds the material.
 *
 * Same patch shape as `canvas/commands.js` (`{ area, id, before, after }`), with
 * `area: 'materials'` and `before: null` — an add is exactly one forward patch,
 * so its undo is the same patch with before/after swapped. The wiring layer
 * commits this once; this module never writes.
 */
export function materialToCommandIntent(material: unknown): MaterialCommandIntent {
  const after = assertMaterial(material)
  return deepFreeze({
    kind: MATERIAL_COMMAND_KINDS.addMaterial,
    patches: [{ area: 'materials' as const, id: after.id, before: null, after }],
  })
}

/**
 * The whole import pipeline as one call: size → decode → value.
 *
 * Returns `{ ok, reason, message, material, hadBom }`. A rejection never throws
 * for expected input problems (too large, bad UTF-8); a programming error
 * (wrong argument type) still throws.
 */
export function importMaterialFile({ name = '', data, importedAt, id, now }: ImportMaterialFileInput = {}): MaterialImportResult {
  const check = validateMaterialFile({ name, bytes: data })
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message, material: null, hadBom: false }
  let decoded: DecodedMaterial
  try {
    decoded = decodeMaterialText(data)
  } catch (error) {
    if (error instanceof MaterialDecodeError) {
      return { ok: false, reason: MATERIAL_REJECT.invalidUtf8, message: error.message, material: null, hadBom: false }
    }
    throw error
  }
  const material = createMaterial({ name, bytes: decoded.bytes, text: decoded.text, importedAt, id, now })
  return { ok: true, reason: null, message: null, material, hadBom: decoded.hadBom }
}

export default {
  MATERIAL_BYTE_LIMIT,
  MATERIAL_FIELDS,
  MATERIAL_COMMAND_KINDS,
  MATERIAL_REJECT,
  MaterialDecodeError,
  utf8ByteLength,
  isStrictIsoDate,
  assertStrictIsoDate,
  byteLengthOf,
  validateMaterialFile,
  decodeMaterialText,
  createMaterial,
  assertMaterial,
  materialToCommandIntent,
  importMaterialFile,
}
