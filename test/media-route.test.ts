import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_MEDIA_BYTES,
  createAssetStore,
  handleMediaUpload,
  type MediaRouteDeps,
} from '@/server/media-route';
import { ALLOWED_ASSET_MIME } from '@/shared/constants';

/**
 * 媒体上传路由的失败分支矩阵。
 *
 * 这组用例存在的理由：上传接口真正的风险全在**拒绝路径**上——空文件、
 * 超限、MIME 欺骗、路径穿越、存储故障。这些分支一旦写错，症状是
 * 「上传失败」或「上传成功但文件不对」，靠点页面几乎定位不出来。
 * 所以每条拒绝路径都单独断言状态码 + 错误语义，不合并成「随便抛个错」。
 *
 * `storeAsset` 用 `vi.fn()` 替身：本层测的是**分类与状态码**，
 * 落盘行为属于 `assets.test.ts` 的范围。唯一例外是去重用例，
 * 那里用真实 `saveAsset` 适配器，才能证明「同内容两次上传 assetId 相同」
 * 不是 mock 编出来的结论。
 */

/** 最小合法 PNG：8 字节魔数 + IHDR 头 */
function tinyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

/** 最小合法 GIF 头（用于「声明 png、实际 gif」） */
function tinyGif(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
}

/** Windows PE 可执行文件头（MZ）——典型的「改名成 .png 的 exe」 */
function exeBytes(): Buffer {
  return Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
}

let root: string;
let deps: MediaRouteDeps;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evc-media-route-'));
  deps = {
    storeAsset: vi.fn<MediaRouteDeps['storeAsset']>(async ({ data, mime }) => ({
      assetId: 'a'.repeat(64),
      bytes: data.length,
      sha256: 'b'.repeat(64),
      mime,
    })),
    assetsRoot: root,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('handleMediaUpload — 正常路径', () => {
  it('合法 PNG 返回 200 与完整元数据', async () => {
    const result = await handleMediaUpload(deps, {
      filename: 'shot.png',
      contentType: 'image/png',
      data: tinyPng(),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      assetId: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      mime: 'image/png',
    });
  });

  it('返回的 bytes 等于实际数据长度', async () => {
    const data = tinyPng();
    const result = await handleMediaUpload(deps, { contentType: 'image/png', data });

    expect(result.body['bytes']).toBe(data.length);
    // 也要确认确实把这个长度透传给了存储层，而不是本地算了个数
    expect(deps.storeAsset).toHaveBeenCalledWith(
      expect.objectContaining({ data, mime: 'image/png' }),
    );
  });

  it('Content-Type 带参数与大小写时仍能识别', async () => {
    const result = await handleMediaUpload(deps, {
      contentType: 'Image/PNG; charset=binary',
      data: tinyPng(),
    });

    expect(result.status).toBe(200);
    expect(result.body['mime']).toBe('image/png');
  });

  it('不传文件名也能上传（filename 可选）', async () => {
    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: tinyPng() });
    expect(result.status).toBe(200);
  });
});

describe('handleMediaUpload — 拒绝路径', () => {
  it('空文件返回 400，且说明是「文件为空」', async () => {
    const result = await handleMediaUpload(deps, {
      filename: 'empty.png',
      contentType: 'image/png',
      data: Buffer.alloc(0),
    });

    expect(result.status).toBe(400);
    expect(String(result.body['error'])).toMatch(/文件为空/);
    // 空文件不该走到存储层
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it('超过 MAX_MEDIA_BYTES 返回 413，并给出上限数值', async () => {
    const big = Buffer.alloc(MAX_MEDIA_BYTES + 1);
    tinyPng().copy(big);

    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: big });

    expect(result.status).toBe(413);
    expect(result.body['maxBytes']).toBe(MAX_MEDIA_BYTES);
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it('恰好等于上限时放行（边界不应误杀）', async () => {
    const edge = Buffer.alloc(MAX_MEDIA_BYTES);
    tinyPng().copy(edge);

    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: edge });

    expect(result.status).toBe(200);
  });

  it('不支持的 MIME 返回 415，且列出全部允许类型', async () => {
    const result = await handleMediaUpload(deps, {
      filename: 'x.svg',
      contentType: 'image/svg+xml',
      data: Buffer.from('<svg onload="x"/>'),
    });

    expect(result.status).toBe(415);
    const error = String(result.body['error']);
    // 「不支持」三个字不够用：必须让用户看到能传什么
    for (const mime of ALLOWED_ASSET_MIME) {
      expect(error).toContain(mime);
    }
    expect(result.body['allowed']).toEqual([...ALLOWED_ASSET_MIME]);
    // SVG 可含脚本，绝不能出现在允许列表里
    expect(result.body['allowed']).not.toContain('image/svg+xml');
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it('缺 Content-Type 返回 415（不按魔数猜类型）', async () => {
    const result = await handleMediaUpload(deps, { data: tinyPng() });

    expect(result.status).toBe(415);
    expect(String(result.body['error'])).toMatch(/Content-Type/);
  });

  it('声明 png 实际是 exe → 400（MIME 欺骗必须被拦）', async () => {
    const result = await handleMediaUpload(deps, {
      filename: 'trojan.png',
      contentType: 'image/png',
      data: exeBytes(),
    });

    expect(result.status).toBe(400);
    expect(String(result.body['error'])).toMatch(/无法识别|不符/);
    // 关键断言：欺骗的字节一次都不许进存储层
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it('声明 png 实际是 gif → 400，并指出真实类型', async () => {
    const result = await handleMediaUpload(deps, {
      filename: 'fake.png',
      contentType: 'image/png',
      data: tinyGif(),
    });

    expect(result.status).toBe(400);
    expect(String(result.body['error'])).toContain('image/gif');
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    'sub/dir/a.png',
    'C:\\Windows\\evil.png',
    'a\u0000b.png',
  ])('文件名含路径穿越/非法语义被拒：%s', async (filename) => {
    const result = await handleMediaUpload(deps, {
      filename,
      contentType: 'image/png',
      data: tinyPng(),
    });

    expect(result.status).toBe(400);
    expect(deps.storeAsset).not.toHaveBeenCalled();
  });

  it('data 不是 Buffer 时返回 400', async () => {
    const result = await handleMediaUpload(deps, {
      contentType: 'image/png',
      data: 'not-a-buffer' as unknown as Buffer,
    });

    expect(result.status).toBe(400);
  });
});

describe('handleMediaUpload — 存储层故障', () => {
  it('storeAsset 抛错 → 500，且响应体不泄露堆栈与内部路径', async () => {
    const leaky = Object.assign(new Error(`ENOSPC: no space left on device, write '${root}\\ab\\cd.png'`), {
      code: 'ENOSPC',
      stack: `Error: ENOSPC\n    at saveAsset (${root}/assets.ts:1:1)`,
    });
    deps.storeAsset = vi.fn<MediaRouteDeps['storeAsset']>(async () => {
      throw leaky;
    });

    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: tinyPng() });

    expect(result.status).toBe(500);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('ENOSPC');
    expect(serialized).not.toContain('saveAsset');
    expect(serialized).not.toContain('    at ');
    expect(serialized).not.toContain(root);
    // 只留一条给人看的错误，不附带任何机器细节
    expect(Object.keys(result.body)).toEqual(['error']);
  });

  it('storeAsset 回报的 bytes 与入参不符 → 500（不写入假数字）', async () => {
    deps.storeAsset = vi.fn<MediaRouteDeps['storeAsset']>(async () => ({
      assetId: 'a'.repeat(64),
      bytes: 999,
      sha256: 'b'.repeat(64),
      mime: 'image/png',
    }));

    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: tinyPng() });

    expect(result.status).toBe(500);
  });

  it('storeAsset 返回值残缺 → 500', async () => {
    deps.storeAsset = vi.fn<MediaRouteDeps['storeAsset']>(
      async () => ({ assetId: 'a'.repeat(64) }) as unknown as Awaited<
        ReturnType<MediaRouteDeps['storeAsset']>
      >,
    );

    const result = await handleMediaUpload(deps, { contentType: 'image/png', data: tinyPng() });

    expect(result.status).toBe(500);
  });

  it('assetsRoot 为空 → 500（装配问题，不冒充用户输入错误）', async () => {
    const result = await handleMediaUpload(
      { ...deps, assetsRoot: '  ' },
      { contentType: 'image/png', data: tinyPng() },
    );

    expect(result.status).toBe(500);
  });
});

describe('handleMediaUpload — 与真实存储层联动的去重', () => {
  it('同一文件上传两次，assetId 相同（内容寻址去重）', async () => {
    // 换成真实的 saveAsset 适配器：去重是内容寻址带来的真实行为，
    // 用 mock 编一个「两次返回同 id」证明不了任何事。
    const realDeps: MediaRouteDeps = { storeAsset: createAssetStore(root), assetsRoot: root };

    const first = await handleMediaUpload(realDeps, { contentType: 'image/png', data: tinyPng() });
    const second = await handleMediaUpload(realDeps, { contentType: 'image/png', data: tinyPng() });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body['assetId']).toBe(first.body['assetId']);
    expect(second.body['sha256']).toBe(first.body['sha256']);
    expect(second.body['bytes']).toBe(tinyPng().length);
  });

  it('不同内容得到不同 assetId', async () => {
    const realDeps: MediaRouteDeps = { storeAsset: createAssetStore(root), assetsRoot: root };

    const png = await handleMediaUpload(realDeps, { contentType: 'image/png', data: tinyPng() });
    const gif = await handleMediaUpload(realDeps, { contentType: 'image/gif', data: tinyGif() });

    expect(png.status).toBe(200);
    expect(gif.status).toBe(200);
    expect(gif.body['assetId']).not.toBe(png.body['assetId']);
  });
});
