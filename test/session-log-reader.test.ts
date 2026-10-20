/**
 * S0-6 磁盘日志读取器的契约测试。
 *
 * 全部用 `os.tmpdir()` 造数据，不读真实用户目录 —— 真实会话随用户操作变化，
 * 拿它当断言基线等于让测试结果依赖「这台机器上刚好有什么」。
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  decodeSessionDirName,
  decompressSessionLog,
  encodeSessionDirName,
  listSessionLogs,
  readSessionEvents,
} from '@/server/session-log-reader'

/** 造一个用完即删的临时目录。 */
async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'evc-log-reader-'))
}

/** 把若干段文本各自独立压缩后首尾相接 —— 复刻真实日志的多帧形态。 */
function multiFrame(parts: string[]): Buffer {
  return Buffer.concat(parts.map((part) => zstdCompressSync(Buffer.from(part, 'utf8'))))
}

/** 一个最小的会话日志：头 + 两个事件。 */
const SAMPLE_LOG = [
  JSON.stringify({ type: 'session', id: 'session-abc', cwd: 'C:\\w' }),
  JSON.stringify({ type: 'user/message', seq: 1, time: 1000, data: { text: 'hi' } }),
  JSON.stringify({ type: 'assistant/message', seq: 2, time: 2000, data: { text: 'yo' } }),
].join('\n')

describe('encodeSessionDirName', () => {
  it('编码出磁盘上真实存在的目录名', () => {
    // 这是本机 `~/.dsh/sessions` 下的真实目录名。编错一个字符就永远找不到会话，
    // 所以它必须由 encode 精确复刻，而不是靠 decode 兜。
    expect(encodeSessionDirName('C:\\Users\\imyan\\Documents\\deepseek-harness\\EV Canvas')).toBe(
      '--C-Users-imyan-Documents-deepseek-harness-EV~0020Canvas--',
    )
  })

  it('盘符冒号与紧随的反斜杠只产出一个 -（不是两个）', () => {
    // `C:\Users` → `C-Users`。若冒号与反斜杠各产一个，会得到 `--C--Users--`，
    // 与真实目录名差一个破折号，扫描结果直接为空。
    expect(encodeSessionDirName('C:\\Users')).toBe('--C-Users--')
  })

  it('空格转成 ~0020，中文按 UTF-16 转 4 位大写十六进制', () => {
    expect(encodeSessionDirName('C:\\a b')).toBe('--C-a~0020b--')
    expect(encodeSessionDirName('C:\\融合')).toBe('--C-~878D~5408--')
  })

  it('正斜杠与反斜杠等价（POSIX 路径也能编码）', () => {
    expect(encodeSessionDirName('C:/Users/imyan')).toBe(encodeSessionDirName('C:\\Users\\imyan'))
  })

  it('字面 ~ 被转义，否则解码时分不清数据与转义前缀', () => {
    expect(encodeSessionDirName('C:\\a~b')).toBe('--C-a~007Eb--')
  })

  it('代理对（emoji）按 code unit 转义，保持 4 位宽度', () => {
    // 按码点会产出 5 位十六进制，而解码侧只认 4 位，往返就断了。
    expect(encodeSessionDirName('C:\\😀')).toBe('--C-~D83D~DE00--')
  })
})

describe('decodeSessionDirName', () => {
  /**
   * 关键认识：**这个编码不是双射**。
   *
   * 分隔符 `\` 和路径里本来就有的 `-` 都映射成 `-`，所以 `deepseek-harness`
   * 和 `deepseek\harness` 编码后完全相同，解码无法区分。这是 DSH 编码本身的
   * 性质，不是实现缺陷 —— 去「修」它就得发明一套反向规则，反而与磁盘上的
   * 真实目录名对不上。所以往返断言只用**不含 `-` 的路径**。
   */
  it('往返一致：带空格', () => {
    const cwd = 'C:\\Users\\imyan\\EV Canvas'
    expect(decodeSessionDirName(encodeSessionDirName(cwd))).toBe(cwd)
  })

  it('往返一致：带中文', () => {
    const cwd = 'C:\\Users\\imyan\\融合\\Y'
    expect(decodeSessionDirName(encodeSessionDirName(cwd))).toBe(cwd)
  })

  it('往返一致：普通路径', () => {
    const cwd = 'C:\\Users\\imyan\\Documents\\work'
    expect(decodeSessionDirName(encodeSessionDirName(cwd))).toBe(cwd)
  })

  it('往返一致：字面 ~ 与 emoji', () => {
    expect(decodeSessionDirName(encodeSessionDirName('C:\\a~b'))).toBe('C:\\a~b')
    expect(decodeSessionDirName(encodeSessionDirName('C:\\😀'))).toBe('C:\\😀')
  })

  it('盘符冒号被正确还原', () => {
    expect(decodeSessionDirName('--C-Users-imyan--')).toBe('C:\\Users\\imyan')
  })

  it('含 - 的目录名会被多切一段（已知有损，不假装可逆）', () => {
    // 固定这个行为，避免有人日后「修」成别的样子却以为修好了。
    const back = decodeSessionDirName(encodeSessionDirName('C:\\a-b'))
    expect(back).toBe('C:\\a\\b')
  })

  it('畸形 ~ 序列原样保留，不抛错（一个怪字符不该毁掉整次扫描）', () => {
    expect(() => decodeSessionDirName('--C-bad~ZZZZ-dir--')).not.toThrow()
    expect(decodeSessionDirName('--C-bad~ZZZZ-dir--')).toContain('~ZZZZ')
  })

  it('空串与纯边界串不抛错', () => {
    expect(() => decodeSessionDirName('')).not.toThrow()
    expect(() => decodeSessionDirName('----')).not.toThrow()
  })
})

describe('decompressSessionLog', () => {
  it('三段独立压缩拼接后能全部解出', () => {
    // 真实日志就是这个形态。只解第一帧会「成功」但丢掉 99% 的内容，
    // 所以必须逐段断言，不能只看解压没报错。
    const parts = ['第一段内容\n', '第二段内容\n', '第三段内容\n']
    const text = decompressSessionLog(multiFrame(parts))
    for (const part of parts) expect(text).toContain(part.trim())
  })

  it('多帧内容按顺序拼接', () => {
    expect(decompressSessionLog(multiFrame(['A', 'B', 'C']))).toBe('ABC')
  })

  it('末帧被截断时，前面的帧仍能解出（日志常因进程被杀而截断）', () => {
    const good = zstdCompressSync(Buffer.from('可读内容\n', 'utf8'))
    // 只留魔数附近几个字节：压缩流不完整，解压必然抛错。
    const broken = zstdCompressSync(Buffer.from('这段会被截断\n', 'utf8')).subarray(0, 8)
    const text = decompressSessionLog(Buffer.concat([good, broken]))
    expect(text).toContain('可读内容')
  })

  it('中间某帧损坏时，它之后的帧仍能解出（不是只丢尾巴）', () => {
    const first = zstdCompressSync(Buffer.from('第一段\n', 'utf8'))
    const broken = zstdCompressSync(Buffer.from('坏段\n', 'utf8')).subarray(0, 8)
    const third = zstdCompressSync(Buffer.from('第三段\n', 'utf8'))
    const text = decompressSessionLog(Buffer.concat([first, broken, third]))
    expect(text).toContain('第一段')
    expect(text).toContain('第三段')
  })

  it('空文件返回空串，不抛错', () => {
    expect(decompressSessionLog(Buffer.alloc(0))).toBe('')
  })

  it('完全没有魔数的垃圾数据返回空串，不抛错', () => {
    expect(decompressSessionLog(Buffer.from([1, 2, 3, 4, 5]))).toBe('')
  })

  it('多字节字符跨帧边界时不被截断成替换字符', () => {
    // 逐帧 toString 会在边界上产出 U+FFFD。这里把「融」的 UTF-8 三字节切在帧缝上。
    const bytes = Buffer.from('融合', 'utf8')
    const text = decompressSessionLog(
      Buffer.concat([zstdCompressSync(bytes.subarray(0, 1)), zstdCompressSync(bytes.subarray(1))]),
    )
    expect(text).toBe('融合')
    expect(text).not.toContain('\uFFFD')
  })
})

describe('readSessionEvents', () => {
  it('读出全部行，顺序与文件一致', async () => {
    const dir = await makeTempDir()
    try {
      const file = join(dir, 'session.v4.jsonl.zstd')
      await writeFile(file, multiFrame([SAMPLE_LOG]))
      const events = await readSessionEvents(file)
      expect(events).toHaveLength(3)
      expect(events[0]).toMatchObject({ type: 'session' })
      expect(events[1]).toMatchObject({ seq: 1 })
      expect(events[2]).toMatchObject({ seq: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('坏 JSONL 行跳过，不影响其余行', async () => {
    const dir = await makeTempDir()
    try {
      const file = join(dir, 'session.v4.jsonl.zstd')
      const text = [
        JSON.stringify({ type: 'user/message', seq: 1 }),
        '{ 这不是合法 JSON',
        JSON.stringify({ type: 'user/message', seq: 2 }),
      ].join('\n')
      await writeFile(file, multiFrame([text]))
      const events = await readSessionEvents(file)
      expect(events).toHaveLength(2)
      expect(events.map((event) => (event as { seq: number }).seq)).toEqual([1, 2])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('尾部半行被跳过（截断日志的典型表现）', async () => {
    const dir = await makeTempDir()
    try {
      const file = join(dir, 'session.v4.jsonl.zstd')
      await writeFile(file, multiFrame([`${JSON.stringify({ seq: 1 })}\n{"seq": 2, "ty`]))
      const events = await readSessionEvents(file)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ seq: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('空文件返回空数组', async () => {
    const dir = await makeTempDir()
    try {
      const file = join(dir, 'session.v4.jsonl.zstd')
      await writeFile(file, Buffer.alloc(0))
      expect(await readSessionEvents(file)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('只有空行的文件返回空数组', async () => {
    const dir = await makeTempDir()
    try {
      const file = join(dir, 'session.v4.jsonl.zstd')
      await writeFile(file, multiFrame(['\n\n']))
      expect(await readSessionEvents(file)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('listSessionLogs', () => {
  it('目录不存在时返回空数组，不抛错（全新机器上还没有会话）', async () => {
    const missing = join(tmpdir(), 'evc-这个目录一定不存在-9f3a')
    expect(await listSessionLogs(missing)).toEqual([])
  })

  it('sessionId 取父目录名，而不是文件名', async () => {
    const root = await makeTempDir()
    try {
      const sessionDir = join(root, '--C-w--', 'session-abc-123')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), multiFrame([SAMPLE_LOG]))

      const list = await listSessionLogs(root)
      expect(list).toHaveLength(1)
      expect(list[0]?.sessionId).toBe('session-abc-123')
      expect(list[0]?.filePath).toContain('session-abc-123')
      expect(list[0]?.bytes).toBeGreaterThan(0)
      expect(typeof list[0]?.mtime).toBe('number')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('递归找多层嵌套下的日志', async () => {
    const root = await makeTempDir()
    try {
      const deep = join(root, '--C-w--', 'a', 'b', 'session-deep')
      await mkdir(deep, { recursive: true })
      await writeFile(join(deep, 'session.v4.jsonl.zstd'), multiFrame([SAMPLE_LOG]))

      const list = await listSessionLogs(root)
      expect(list).toHaveLength(1)
      expect(list[0]?.sessionId).toBe('session-deep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('会话目录里没有日志文件时跳过', async () => {
    const root = await makeTempDir()
    try {
      await mkdir(join(root, '--C-w--', 'empty-session'), { recursive: true })
      expect(await listSessionLogs(root)).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('空目录返回空数组', async () => {
    const root = await makeTempDir()
    try {
      expect(await listSessionLogs(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('多个会话全部列出，按 mtime 降序', async () => {
    const root = await makeTempDir()
    try {
      const older = join(root, '--C-w--', 'session-old')
      const newer = join(root, '--C-w--', 'session-new')
      await mkdir(older, { recursive: true })
      await mkdir(newer, { recursive: true })
      await writeFile(join(older, 'session.v4.jsonl.zstd'), multiFrame([SAMPLE_LOG]))
      await writeFile(join(newer, 'session.v4.jsonl.zstd'), multiFrame([SAMPLE_LOG]))

      const list = await listSessionLogs(root)
      expect(list).toHaveLength(2)
      expect(list.map((entry) => entry.sessionId).sort()).toEqual(['session-new', 'session-old'])
      expect(list[0]!.mtime).toBeGreaterThanOrEqual(list[1]!.mtime)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('端到端：扫描 → 读取', () => {
  it('按 encode 的目录名定位会话并解出事件', async () => {
    const root = await makeTempDir()
    const cwd = 'C:\\Users\\imyan\\EV Canvas'
    try {
      const sessionDir = join(root, encodeSessionDirName(cwd), 'session-e2e')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), multiFrame([SAMPLE_LOG]))

      const list = await listSessionLogs(root)
      expect(list).toHaveLength(1)

      const events = await readSessionEvents(list[0]!.filePath)
      expect(events).toHaveLength(3)
      // 事件来自 SAMPLE_LOG，头里的 cwd 就是它写的 `C:\w`。
      expect(events[0]).toMatchObject({ type: 'session', cwd: 'C:\\w' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
