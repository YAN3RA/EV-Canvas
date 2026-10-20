// @ts-nocheck -- 测试用真实 fs 与手工构造的字节，类型宽松。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sniffMime,
  validateAsset,
  digestOf,
  assetPathFor,
  saveAsset,
  readAsset,
  assetExists,
} from '@/server/assets';
import { InputError, MissingAssetError } from '@/shared/errors';
import { MAX_ASSET_BYTES } from '@/shared/constants';

/**
 * 媒体资产存储的安全属性。这组测试的必要性来自三条真实风险：
 *   1. 目录穿越（路径由用户输入拼接 → 读任意文件）
 *   2. MIME 欺骗（声明 png、实际是 exe）
 *   3. 媒体塞进 JSON（破坏格式 + 体积爆炸）
 *
 * 全部用例都在临时目录里跑真实 fs，不用 mock。
 */

/** 最小的合法 PNG（8 字节魔数 + IHDR 片段） */
function tinyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

/** 最小的合法 GIF 头 */
function tinyGif(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evc-assets-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sniffMime — 魔数识别', () => {
  it('识别 PNG', () => {
    expect(sniffMime(tinyPng())).toBe('image/png');
  });

  it('识别 GIF', () => {
    expect(sniffMime(tinyGif())).toBe('image/gif');
  });

  it('识别 JPEG', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('无法识别的字节返回 null', () => {
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it('空 Buffer 返回 null，不抛错', () => {
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('validateAsset — 白名单与欺骗防护', () => {
  it('合法 PNG 通过', () => {
    expect(() => validateAsset({ buffer: tinyPng(), declaredMime: 'image/png' })).not.toThrow();
  });

  it('拒绝 SVG（可含脚本）', () => {
    expect(() =>
      validateAsset({ buffer: Buffer.from('<svg onload="x"/>'), declaredMime: 'image/svg+xml' }),
    ).toThrow(/不支持的 MIME/);
  });

  it('拒绝可执行类型', () => {
    expect(() =>
      validateAsset({ buffer: Buffer.from('MZ'), declaredMime: 'application/x-msdownload' }),
    ).toThrow(/不支持的 MIME/);
  });

  it('声明 png 实际是 gif → 拒绝（MIME 欺骗）', () => {
    expect(() => validateAsset({ buffer: tinyGif(), declaredMime: 'image/png' })).toThrow(/不符/);
  });

  it('声明合法类型但内容无法识别 → 拒绝', () => {
    expect(() =>
      validateAsset({ buffer: Buffer.from([0x00, 0x01, 0x02]), declaredMime: 'image/png' }),
    ).toThrow(/无法识别/);
  });

  it('空文件被拒', () => {
    expect(() => validateAsset({ buffer: Buffer.alloc(0), declaredMime: 'image/png' })).toThrow(
      /不能为空/,
    );
  });

  it('超 50 MiB 被拒', () => {
    const big = Buffer.alloc(MAX_ASSET_BYTES + 1);
    // 前缀仍是 PNG 魔数，确保失败原因只能是大小
    tinyPng().copy(big);
    expect(() => validateAsset({ buffer: big, declaredMime: 'image/png' })).toThrow(/超限/);
  });
});

describe('assetPathFor — 路径不可穿越', () => {
  const sha = 'a'.repeat(64);

  it('路径按 sha256 前两位分片', () => {
    const p = assetPathFor(root, sha, 'image/png');
    expect(p.startsWith(join(root, 'aa'))).toBe(true);
  });

  it('文件名是 sha256 加正确扩展名', () => {
    const p = assetPathFor(root, sha, 'image/png');
    expect(p.endsWith(`${sha}.png`)).toBe(true);
  });

  it('拒绝非法 sha256（含路径分隔符）', () => {
    expect(() => assetPathFor(root, '../../etc/passwd', 'image/png')).toThrow(InputError);
  });

  it('拒绝未知 MIME', () => {
    expect(() => assetPathFor(root, sha, 'application/zip')).toThrow(InputError);
  });

  it('同 sha 同 MIME 恒定产出同一路径', () => {
    expect(assetPathFor(root, sha, 'image/png')).toBe(assetPathFor(root, sha, 'image/png'));
  });
});

describe('saveAsset — 落盘与去重', () => {
  it('保存后文件真的存在', async () => {
    const meta = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    const bytes = await readFile(assetPathFor(root, meta.sha256, meta.mime));
    expect(bytes.length).toBe(tinyPng().length);
  });

  it('返回的 sha256 与实际内容一致', async () => {
    const meta = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    expect(meta.sha256).toBe(digestOf(tinyPng()));
  });

  it('同内容第二次保存被去重，不再写盘', async () => {
    const first = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    const second = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    expect(second.sha256).toBe(first.sha256);
    expect(second.deduped).toBe(true);
  });

  it('不同内容得到不同 sha 与不同文件', async () => {
    const a = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    const b = await saveAsset({ root, buffer: tinyGif(), declaredMime: 'image/gif' });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('不留下临时文件', async () => {
    await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    const shard = join(root, digestOf(tinyPng()).slice(0, 2));
    const files = await readdir(shard);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('readAsset — 缺失必须报错', () => {
  it('读回字节与写入一致', async () => {
    const meta = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    const bytes = await readAsset({ root, meta });
    expect(bytes.equals(tinyPng())).toBe(true);
  });

  it('文件不存在时抛 MissingAssetError，不返回空', async () => {
    const meta = { assetId: 'ghost', sha256: 'b'.repeat(64), mime: 'image/png' };
    await expect(readAsset({ root, meta })).rejects.toBeInstanceOf(MissingAssetError);
  });

  it('元数据缺 sha256 时报输入错误', async () => {
    await expect(readAsset({ root, meta: { mime: 'image/png' } })).rejects.toBeInstanceOf(InputError);
  });
});

describe('assetExists — 降级判断，不抛错', () => {
  it('已保存的返回 true', async () => {
    const meta = await saveAsset({ root, buffer: tinyPng(), declaredMime: 'image/png' });
    expect(await assetExists({ root, meta })).toBe(true);
  });

  it('缺失的返回 false 而不是抛错', async () => {
    expect(await assetExists({ root, meta: { sha256: 'c'.repeat(64), mime: 'image/png' } })).toBe(false);
  });
});
