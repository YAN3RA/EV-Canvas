/**
 * S0-6 历史回填：把磁盘上的旧会话日志读成 `ProjectableSession`。
 *
 * ## 为什么必须自己读磁盘
 *
 * 宿主只暴露 `ctx.sessions.list()`，它返回**当前活跃**会话。宿主重启之后，
 * 之前的会话就不在列表里了——画布于是只显示 1 个会话，而磁盘上躺着十几个。
 * 这不是投影 bug，是没有数据来源。
 *
 * 所以唯一途径是直接读 DSH 的会话日志文件。这是**只读**操作：插件仍然只拥有
 * 投影副本，原始日志的写入权始终在 DSH 手里（HANDOFF §5.2）。
 *
 * ## 日志格式（实测，node v24）
 *
 * `~/.dsh/sessions/<cwd 编码目录>/<会话目录>/session.v4.jsonl.zstd`
 *
 * - 单个文件里是**多个独立 zstd 帧**串联。只解第一帧只能拿到约 236 字节的
 *   会话头——必须按魔数 `28 B5 2F FD` 切分后逐帧解压。这是真实的坑：
 *   `zstdDecompressSync(整个文件)` 只返回第一帧，看起来「解压成功」，
 *   实际丢了 99% 内容。
 * - 解压后是 JSONL：首行 `type: 'session'` 是头，其余每行一个事件。
 * - 事件形状恰好等于 `ProjectableEvent`（`type`/`seq`/`time`/`data`），无需映射。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** DSH 会话日志文件名。 */
const SESSION_LOG_FILE = 'session.v4.jsonl.zstd';

/** 可被投影的事件（形状与 `workspace-store` 的 `ProjectableEvent` 一致）。 */
export interface LoggedEvent {
  seq: number;
  type: string;
  time: number;
  data?: unknown;
}

/** 一个可被投影的会话，直接喂给 `WorkspaceStore.projectSession`。 */
export interface ProjectableSessionFromLog {
  id: string;
  title?: unknown;
  header: { cwd?: unknown };
  inheritedEventCount: number;
  snapshotEvents: () => Iterable<LoggedEvent>;
}

/** 扫描结果。 */
export interface SessionLogEntry {
  /** 会话 id，取**父目录名**并去掉 `session-` 前缀归一化。 */
  sessionId: string;
  /** 父目录名原文（可能带 `session-` 前缀）。 */
  directoryName: string;
  filePath: string;
  bytes: number;
  mtime: number;
}

/**
 * cwd → DSH 会话目录名。
 *
 * 规则从磁盘上两个真实目录名反推并双向验证过：
 *
 *   `C:\Users\imyan\.dsh\aik_auto_memory_use`
 *     → `--C-Users-imyan-.dsh-aik_auto_memory_use--`
 *   `C:\Users\imyan\Documents\deepseek-harness\EV Canvas`
 *     → `--C-Users-imyan-Documents-deepseek-harness-EV~0020Canvas--`
 *
 * 三条要点（第一版全猜错了，测试当场抓出来）：
 *   1. **冒号不产生字符**。`C:\` 的 `\` 变 `-`，配合外层前缀得到 `--C`。
 *      若把冒号也换成 `-` 会得到 `--C--Users`（多一个），永远匹配不上。
 *   2. 分隔符 `\` / `/` → `-`；**首尾各包两个 `-`**。
 *   3. **空格是转义字符**：`~0020`，不能当普通 ASCII 保留。中文同理
 *      → `~` + 4 位大写十六进制（`融合` → `~878D~5408`）。
 */
export function encodeSessionDirName(cwd: string): string {
  let out = '';
  // 按 **code unit** 遍历而不是 code point：代理对（emoji）必须拆成两个 4 位
  // 转义（`😀` → `~D83D~DE00`），与 DSH 的编码一致。用 for..of 按码点遍历会
  // 得到 `~1F600`（5 位），宽度不同，解码时前 4 位被截断成乱码。
  for (let i = 0; i < cwd.length; i++) {
    const char = cwd[i]!;
    const code = char.charCodeAt(0);
    if (char === ':') continue; // 见上方第 1 条：不产生字符
    if (char === '\\' || char === '/') {
      out += '-';
    } else if (char === '~') {
      // 数据里的 `~` 必须转义，否则和 `~XXXX` 编码冲突。
      out += '~007E';
    } else if (code > 0x20 && code < 0x7f) {
      // `> 0x20` 而非 `>=`：空格必须走转义分支。
      out += char;
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return `--${out}--`;
}

/**
 * DSH 会话目录名 → cwd。
 *
 * **注意这个编码不是双射**：分隔符与路径里本来就有的 `-` 都映射成 `-`，
 * 解码无法区分。这是 DSH 编码本身的性质。解码只用于「展示/核对」，
 * 不用于反向定位路径。畸形 `~` 序列原样保留，一个怪字符不该让整次扫描失败。
 */
export function decodeSessionDirName(dirName: string): string {
  let name = dirName;
  if (name.startsWith('--')) name = name.slice(2);
  if (name.endsWith('--')) name = name.slice(0, -2);

  let out = '';
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (char !== '~') {
      out += char === '-' ? '\\' : char;
      continue;
    }
    const hex = name.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
      out += char; // 畸形序列：原样保留
      continue;
    }
    // 用 fromCharCode 而不是 fromCodePoint：编码是按 code unit 拆的，
    // 代理对是两个独立转义（`~D83D~DE00`），逐段还原后自然拼回原字符。
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 4;
  }
  // 盘符：`-C\Users` → `C:\Users`。
  if (/^-?[A-Za-z]\\/.test(out)) {
    out = out.startsWith('-') ? out.slice(1) : out;
    out = `${out[0]}:${out.slice(1)}`;
  }
  return out;
}

/**
 * 把整个 `.zstd` 文件解成文本（多帧）。
 *
 * 坏帧**跳过**而不是整体失败：日志尾部常因进程被杀而截断，
 * 为最后半帧丢掉前面几 MB 历史不值得。
 */
export function decompressSessionLog(buffer: Buffer): string {
  const starts: number[] = [];
  for (let i = 0; i <= buffer.length - ZSTD_MAGIC.length; i++) {
    if (
      buffer[i] === ZSTD_MAGIC[0] &&
      buffer[i + 1] === ZSTD_MAGIC[1] &&
      buffer[i + 2] === ZSTD_MAGIC[2] &&
      buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  if (starts.length === 0) return ''; // 空文件或被完全破坏

  const chunks: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1]! : buffer.length;
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[k]!, end)));
    } catch {
      // 坏帧跳过，见上方注释。
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 解析 JSONL：分离会话头与事件，坏行跳过。
 *
 * 只保留形状像事件的行（`type` 为字符串且 `seq` 是安全整数）。会话头那行
 * `type: 'session'` 没有 `seq`，单独返回，不混进事件流——混进去会让投影
 * 把它当成一条事件处理。
 */
export function parseSessionLog(text: string): { header: Record<string, unknown> | null; events: LoggedEvent[] } {
  let header: Record<string, unknown> | null = null;
  const events: LoggedEvent[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（截断日志的典型表现）
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record['type'] === 'session' && header === null) {
      header = record;
      continue;
    }
    const seq = record['seq'];
    const type = record['type'];
    if (typeof type !== 'string' || !Number.isSafeInteger(seq)) continue;
    const time = record['time'];
    events.push({
      seq: seq as number,
      type,
      time: typeof time === 'number' && Number.isFinite(time) ? time : 0,
      ...(record['data'] === undefined ? {} : { data: record['data'] }),
    });
  }
  // 按 seq 排序：多帧拼接顺序基本已正确，但截断/重放可能造成局部乱序，
  // 投影按 seq 推进，乱序会静默丢事件。
  events.sort((a, b) => a.seq - b.seq);
  return { header, events };
}

/** 读取单个会话文件，返回头与事件。 */
export async function readSessionLog(
  filePath: string,
): Promise<{ header: Record<string, unknown> | null; events: LoggedEvent[] }> {
  const buffer = await readFile(filePath);
  return parseSessionLog(decompressSessionLog(buffer));
}

/**
 * 读取单个会话文件，返回**原始事件行**（含会话头）。
 *
 * 与 `readSessionLog` 的区别是分工不同：
 *   - `readSessionEvents` 给「只想按原样拿到文件里每一行」的调用方，会话头
 *     也算一行（测试按这个语义写的，别在不通知的情况下改掉）。
 *   - `readSessionLog` 给投影用：把头与事件分开，并补齐缺省 `time`、
 *     丢掉没有 `seq` 的行，产出可直接喂 `ProjectableEvent` 的形状。
 *
 * 坏行跳过而不是抛错：日志尾部常被截断，最后一行 JSON 往往只有半截。
 * 顺序与文件一致——投影按事件先后推进，这里不排序、不猜缺失的 seq。
 */
export async function readSessionEvents(filePath: string): Promise<unknown[]> {
  const buffer = await readFile(filePath);
  const events: unknown[] = [];
  for (const line of decompressSessionLog(buffer).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      // 半截行 / 脏行：跳过。
    }
  }
  return events;
}

/**
 * 扫描会话根目录，列出所有会话日志（**递归**）。
 *
 * 为什么递归：真实目录是 `sessions/<cwd 编码>/<会话目录>/session.v4.jsonl.zstd`，
 * 但 DSH 也可能把日志放在更深一层（子代理会话等）。写死两层会静默漏掉它们，
 * 而「少了几个会话」这种症状极难归因到「少扫了一层」。
 *
 * 目录不存在时返回 `[]`：全新机器上还没有任何会话，这不是错误。
 */
export async function listSessionLogs(sessionsRoot: string): Promise<SessionLogEntry[]> {
  const entries: SessionLogEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    let dirents: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      // 显式标注结构类型：`withFileTypes: true` 的重载在 Node 22 类型里会把
      // 返回泛型推断成 `Dirent<NonSharedBuffer>`，导致 `name` 被当成 Buffer。
      dirents = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return; // 目录不存在 / 无权限：不抛错
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!dirent.isFile() || dirent.name !== SESSION_LOG_FILE) continue;
      // 会话目录是其父目录，`sessionId` 保留目录名原文（**不去** `session-`
      // 前缀）：磁盘上两种形态并存，去掉前缀会让「按目录名回查」失配。
      // 需要裸 uuid 的场合请显式调用 `normalizeSessionId`。
      const directoryName = full.slice(0, full.length - SESSION_LOG_FILE.length - 1).split(/[\\/]/).pop() ?? '';
      try {
        const info = await stat(full);
        entries.push({
          sessionId: directoryName,
          directoryName,
          filePath: full,
          bytes: info.size,
          mtime: info.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  };

  await walk(sessionsRoot);
  // 按 mtime 降序：调用方通常想先看到最近的会话。
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/**
 * 会话 id 归一化：去掉 `session-` 前缀。
 *
 * 磁盘目录名有两种形态（`session-<uuid>` 与裸 `<uuid>`），store 侧统一用裸形式。
 * 归一化必须与 store 的 `sameDshSessionId` 口径一致，否则同一会话会被投影成
 * 两条 thread——这是已经踩过的坑。
 */
export function normalizeSessionId(value: string): string {
  return value.startsWith('session-') ? value.slice('session-'.length) : value;
}

/**
 * 把一个磁盘日志包装成 `ProjectableSession`。
 *
 * `inheritedEventCount` 取 0：回填的是完整历史，没有 fork 切点。
 * fork 造成的重复由 store 侧谱系逻辑处理，这里不猜。
 */
export async function loadProjectableSession(entry: SessionLogEntry): Promise<ProjectableSessionFromLog> {
  const { header, events } = await readSessionLog(entry.filePath);
  const cwd = typeof header?.['cwd'] === 'string' ? header['cwd'] : undefined;
  return {
    id: entry.sessionId,
    title: undefined,
    header: cwd === undefined ? {} : { cwd },
    inheritedEventCount: 0,
    snapshotEvents: () => events,
  };
}
