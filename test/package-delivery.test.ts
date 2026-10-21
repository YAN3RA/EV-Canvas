import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/** 读取真实归档，而不是在测试里检查打包脚本是否写了某个字符串。 */
function unpackEntries(tar: Buffer): Map<string, { mode: number; body: Buffer }> {
  const entries = new Map<string, { mode: number; body: Buffer }>();
  for (let cursor = 0; cursor + 512 <= tar.length;) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const mode = Number.parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || cursor + 512 + size > tar.length) throw new Error('坏 tar 头');
    entries.set(name, { mode, body: tar.subarray(cursor + 512, cursor + 512 + size) });
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('只读工具的实际tgz交付', () => {
  it('打包器保留CLI入口、静态声明和模型依赖，bin可执行且不带开发依赖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evcanvas-delivery-'));
    try {
      const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
      const fixtureFiles: Record<string, string> = {
        'dist/server/index.js': 'export const name = "dsh-evcanvas";',
        'dist/server/provenance.js': 'export const fixture = "provenance";',
        'dist/shared/session-id.js': 'export const fixture = "session-id";',
        'dist/canvas/model.js': 'export const fixture = "model";',
        'dist/ui/app.js': 'console.log("fixture");',
        'src/client/index.js': '// fixture client',
        'cordis.patch.yml': '- insert: []',
        'README.md': '# fixture',
        'compatibility.json': '{"fixture":true}',
        'scripts/why.mjs': '#!/usr/bin/env node\nconsole.log("fixture why");',
        'scripts/check-compatibility.mjs': 'console.log("fixture compatibility");',
        'package.json': JSON.stringify(manifest),
      };
      for (const [relative, body] of Object.entries(fixtureFiles)) {
        const path = join(root, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body);
      }
      const result = spawnSync(process.execPath, [resolve('scripts/pack-plugin.mjs')], { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const gzip = await readFile(join(root, 'release', `dsh-evcanvas-${manifest.version}.tgz`));
      const entries = unpackEntries(gunzipSync(gzip));
      for (const required of ['dist/server/provenance.js', 'dist/canvas/model.js', 'compatibility.json', 'scripts/why.mjs', 'scripts/check-compatibility.mjs', 'src/client/index.js']) {
        expect(entries.get(`package/${required}`)?.body.toString('utf8'), required).toBe(fixtureFiles[required]);
      }
      const shipped = JSON.parse(entries.get('package/package.json')!.body.toString('utf8'));
      expect(shipped.bin).toEqual({ 'evcanvas-why': './scripts/why.mjs' });
      expect(shipped.devDependencies).toBeUndefined();
      expect(entries.get('package/scripts/why.mjs')?.mode).toBe(0o755);
      expect(entries.get('package/compatibility.json')?.mode).toBe(0o644);
    } finally {
      // root 是本测试 mkdtemp 返回的独占临时目录，不指向源码或用户profile。
      await rm(root, { recursive: true, force: true });
    }
  });
});
