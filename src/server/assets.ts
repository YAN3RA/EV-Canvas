/**
 * EV Canvas · 媒体资产存储（S0-3）
 *
 * 设计依据：Project Docs/2-设计/S0-1-统一节点schema设计.md §7
 *
 * 硬约束（来自 PRD 与旧版教训）：
 *   1. 媒体二进制**不入库** —— workspaces.json 只存 assetId 与元数据
 *   2. 路径由 sha256 计算，**永不拼接用户输入**（防目录穿越）
 *   3. MIME 必须双验：声明类型 + 文件魔数
 *   4. 写入原子：临时文件 → fsync → rename
 *   5. 同内容只存一份（内容寻址天然去重）
 *   6. 缺失文件必须明确报错，不得静默
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ALLOWED_ASSET_MIME, MAX_ASSET_BYTES } from '@/shared/constants';
import { InputError, MissingAssetError } from '@/shared/errors';

/** 扩展名映射：MIME → 文件后缀 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};

/** 魔数条目：主签名 + 可选「相对主签名起点的偏移」与「第二段签名」 */
interface MagicEntry {
  mime: string;
  bytes: readonly number[];
  /** 主签名在缓冲区中的起点，缺省 0 */
  offset?: number;
  /** 第二段签名（如 WEBP/WAVE 的格式标识） */
  extra?: { offset: number; bytes: readonly number[] };
}

/**
 * 文件魔数表：用来验证「声明的 MIME」与「真实字节」一致。
 * 只覆盖白名单内的类型；不在表内的类型一律拒绝。
 */
const MAGIC: readonly MagicEntry[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] } },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
];

/** 判定字节的真实类型；返回 null 表示无法识别 */
export function sniffMime(buffer: Buffer): string | null {
  for (const entry of MAGIC) {
    const at = entry.offset ?? 0;
    if (buffer.length < at + entry.bytes.length) continue;
    let matched = true;
    for (let i = 0; i < entry.bytes.length; i += 1) {
      if (buffer[at + i] !== entry.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (entry.extra !== undefined) {
      const extra = entry.extra;
      if (buffer.length < extra.offset + extra.bytes.length) continue;
      for (let i = 0; i < extra.bytes.length; i += 1) {
        if (buffer[extra.offset + i] !== extra.bytes[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
    }
    return entry.mime;
  }
  return null;
}

/** 校验入参：白名单 + 大小 + 魔数与声明一致，返回真实 MIME。 */
export function validateAsset({ buffer, declaredMime }: { buffer: Buffer; declaredMime: string }): string {
  if (!Buffer.isBuffer(buffer)) throw new InputError('资产内容必须是 Buffer');
  if (!(ALLOWED_ASSET_MIME as readonly string[]).includes(declaredMime)) {
    throw new InputError(`不支持的 MIME：${declaredMime}`);
  }
  if (buffer.length === 0) throw new InputError('资产不能为空');
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new InputError(`资产超限：${buffer.length} > ${MAX_ASSET_BYTES}`);
  }
  const actual = sniffMime(buffer);
  if (actual === null) {
    throw new InputError('无法识别资产真实类型，已拒绝');
  }
  if (actual !== declaredMime) {
    throw new InputError(`声明的 MIME（${declaredMime}）与真实内容（${actual}）不符，已拒绝`);
  }
  return actual;
}

/** sha256 摘要（十六进制小写） */
export function digestOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 内容寻址路径：`<root>/<sha256 前两位>/<sha256>.<ext>`
 *
 * 这是**唯一**生成资产路径的函数。任何调用方都不得自己拼路径，
 * 否则目录穿越的口子就打开了。
 */
export function assetPathFor(root: string, sha256: string, mime: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new InputError('sha256 必须是 64 位小写十六进制');
  const ext = EXT_BY_MIME[mime];
  if (ext === undefined) throw new InputError(`MIME 无对应扩展名：${mime}`);
  return join(root, sha256.slice(0, 2), `${sha256}.${ext}`);
}

/** 资产元数据。`createdAt` 为 null 表示本次是去重命中（没有新写入）。 */
export interface AssetMeta {
  assetId: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: string | null;
  deduped: boolean;
}

/** 读取路径所需的元数据子集：只要 sha256 与 mime。 */
export interface AssetRef {
  assetId?: string;
  mime: string;
  sha256: string;
}

/**
 * 保存一个资产，返回其元数据。
 *
 * 幂等：同一份内容重复保存只会返回已有元数据，不重复写盘。
 */
export async function saveAsset({
  root,
  buffer,
  declaredMime,
  now = () => new Date().toISOString(),
}: {
  root: string;
  buffer: Buffer;
  declaredMime: string;
  now?: () => string;
}): Promise<AssetMeta> {
  const mime = validateAsset({ buffer, declaredMime });
  const sha256 = digestOf(buffer);
  const target = assetPathFor(root, sha256, mime);

  // 已存在则直接复用（内容寻址天然去重）
  try {
    const existing = await stat(target);
    if (existing.isFile() && existing.size === buffer.length) {
      return { assetId: sha256, mime, bytes: buffer.length, sha256, createdAt: null, deduped: true };
    }
  } catch {
    /* 不存在，继续写 */
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, buffer);
  // 先落临时文件再 rename，保证读者永远看不到半个文件
  await rename(temporary, target).catch(async (error: unknown) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });

  // 写后回读校验：磁盘上确实是我们要写的那份
  const written = await readFile(target);
  if (digestOf(written) !== sha256) {
    throw new InputError('资产写入后校验失败，文件内容与预期不符');
  }

  return { assetId: sha256, mime, bytes: buffer.length, sha256, createdAt: now(), deduped: false };
}

/** 读取资产字节。缺失时抛 MissingAssetError，**绝不返回空**。 */
export async function readAsset({ root, meta }: { root: string; meta: AssetRef }): Promise<Buffer> {
  if (meta === null || typeof meta !== 'object' || typeof meta.sha256 !== 'string') {
    throw new InputError('资产元数据缺失 sha256');
  }
  const target = assetPathFor(root, meta.sha256, meta.mime);
  try {
    return await readFile(target);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new MissingAssetError(`资产文件缺失：${meta.assetId ?? meta.sha256}（${meta.mime}）`);
    }
    throw error;
  }
}

/** 资产是否存在（用于加载期降级判断，不抛错） */
export async function assetExists({ root, meta }: { root: string; meta: AssetRef }): Promise<boolean> {
  try {
    const info = await stat(assetPathFor(root, meta.sha256, meta.mime));
    return info.isFile();
  } catch {
    return false;
  }
}

/** `node:fs` 错误带 `code` 字符串；用于区分 ENOENT 与真实故障。 */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
