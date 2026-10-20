/**
 * EV Canvas · 会话 ID 归一化
 *
 * 为什么需要这个文件：
 * 旧版 0.2.2 有一个真实缺陷 —— 持久化的 dshSessionId 有时带 `session-` 前缀，
 * 有时是裸 uuid（commit d0778bd 修过一次）。任何直接 `===` 或 `includes()`
 * 比对都会把同一个会话判成两个，导致投影出重复卡片。
 *
 * 规则（来自项目记忆 ins_51c832c4）：
 * - 只归一化已知格式差异（前缀、大小写）
 * - **不同 uuid 永不相等**
 * - 写入侧与读取侧共用同一函数
 */

/** 已知的请求前缀，按长度降序尝试剥离 */
const KNOWN_PREFIXES = ['session-', 'sess-'] as const;

/**
 * 归一化为可比较的裸标识。
 * - 去首尾空白
 * - 去已知前缀（仅一次，避免 `session-session-x` 被过度剥离）
 * - 转小写
 *
 * 不做的事：不猜测格式、不模糊匹配、不返回空串冒充有效 id。
 */
export function normalizeSessionId(id: string): string {
  let out = id.trim();
  for (const prefix of KNOWN_PREFIXES) {
    if (out.length > prefix.length && out.toLowerCase().startsWith(prefix)) {
      out = out.slice(prefix.length);
      break;
    }
  }
  return out.toLowerCase();
}

/**
 * 判断两个会话 ID 是否指向同一个会话。
 * 这是**唯一**允许用于跨版本持久化 id 比对的函数。
 */
export function sameDshSessionId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const na = normalizeSessionId(a);
  const nb = normalizeSessionId(b);
  // 归一化后为空串说明输入本身无效，不得判等
  if (na === '' || nb === '') return false;
  return na === nb;
}
