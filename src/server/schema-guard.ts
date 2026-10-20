/**
 * EV Canvas · schema 校验网关（S0-1 接线第一步）
 *
 * 为什么需要这一层，而不是直接把 `validateWorkspace` 塞进写入路径：
 * 权威实现（`shared/node-schema.ts`）是**抛错式**的——首个失败即 `throw InputError`，
 * 且它假设所有输入都是创作节点。但运行时真正写入的来源不止一种：
 * 投影数据由 DSH 事件反投影而来、历史数据是存量、导入数据来自外部文件。
 * 一刀切 enforce 会把形状由宿主决定的投影挡在门外，功能当场坏掉。
 *
 * 所以这里做的是「按场景决定校验强度」的网关：调用方只管问 `guardWorkspace(value, source)`，
 * 强度由来源决定，可逐个来源提档，不必一次性改造所有调用点。
 *
 * 与权威实现的分工：本文件**不重复实现任何字段规则**，只负责
 * 「选择强度 / 捕获异常 / 汇总问题 / 给出是否阻断」。规则改动只发生在 `node-schema.ts`。
 */

import { validateEdge, validateNode, validateWorkspace } from '@/shared/node-schema';

/** 校验强度。 */
export type GuardMode = 'off' | 'warn' | 'enforce';

export interface GuardDecision {
  /**
   * 是否**阻断**本次写入。
   *
   * 注意语义：`ok` 回答的是「能不能继续」，不是「数据是否合规」。
   * `warn` 模式下数据可能明显非法，`ok` 仍为 true——合规性看 `problems`。
   */
  ok: boolean;
  /** 实际执行的模式（off 时也回报 off，便于日志核对）。 */
  mode: GuardMode;
  /**
   * 发现的问题；无问题为空数组。
   *
   * 不变量：`ok === true` **不**意味着空数组（warn 模式就是「放行但记账」）；
   * 反过来 `problems` 为空则一定 `ok`。
   */
  problems: string[];
}

/**
 * 各写入来源的默认强度。
 *
 * `projection` 用 `warn` 而非 `enforce`：投影数据的形状由 DSH 事件决定，
 * 插件无权要求宿主事件满足「创作节点」schema。会话投影里出现的字段、
 * 缺失的可选字段、宿主扩展字段都不在插件控制范围内。用 enforce 等于
 * 拿创作节点的规则去否决宿主的事实——正常投影会被挡在门外，S0-5 那条
 * 已经通过真实宿主验收的链路会直接回退成写不进去。先记账，等投影侧
 * 确认收敛后再提档。
 *
 * `user` 用 `enforce`：用户主动创建/编辑的节点是**新的**持久数据。
 * 放进来之后，后面每个消费者（渲染、导出、迁移、搜索）都要各自防御一遍；
 * 而且脏数据一旦落盘就要写迁移才能修。在入口拦一次，成本最低。
 *
 * `history` 用 `warn`：存量数据是既成事实，可能产生于规则收紧之前。
 * 加载历史就 enforce 会让老工作区打不开——那是数据丢失，比脏数据更糟。
 *
 * `import` 用 `enforce`：导入是显式、可预览、可拒绝的动作，外部文件没理由
 * 享受存量数据的宽容。这里放行等于把别人的脏数据变成自己的存量数据。
 */
export const DEFAULT_GUARD_MODES: Readonly<Record<string, GuardMode>> = Object.freeze({
  projection: 'warn',
  user: 'enforce',
  history: 'warn',
  import: 'enforce',
});

/**
 * 未知来源落到 `warn`。
 *
 * 为什么不是 `enforce`：未知来源的形状未知，用创作节点规则去否决它，
 * 等于假设「所有新接入方都产出合规创作节点」——这个假设一旦不成立就是线上写入失败。
 * 为什么不是 `off`：静默放行未知来源，等于给未来的调用点开了个后门。
 * `warn` 是唯一既不阻断也不沉默的位置：先记录，看清真实形状再决定提档。
 */
export const FALLBACK_GUARD_MODE: GuardMode = 'warn';

/**
 * 按场景决定校验强度。
 *
 * 优先级：`modeOverrides` > `DEFAULT_GUARD_MODES` > `FALLBACK_GUARD_MODE`。
 * 覆盖表按 source 逐项生效，不整体替换——提档一个来源不必重写整张表。
 */
function resolveMode(source: string, overrides?: Record<string, GuardMode>): GuardMode {
  const override = overrides?.[source];
  if (override !== undefined) return override;
  const known = DEFAULT_GUARD_MODES[source];
  if (known !== undefined) return known;
  return FALLBACK_GUARD_MODE;
}

/** 把任意抛出物压成一行可读文本，避免 `[object Object]` 这类无法排查的日志。 */
function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 顶层类型不对时给出可辨识的描述，而不是笼统的「必须是对象」。 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 收集一个快照的全部问题。
 *
 * 为什么要收集全部而不是首个失败就返回：修数据的人拿到的是一次性清单，
 * 一次改完；只报首个失败会退化成「改一条、跑一次、再报下一条」的试错循环。
 *
 * 分层做法（受权威实现限制的折中）：
 *   1. 逐节点 `validateNode` / 逐边 `validateEdge` —— 这两层能收全，
 *      一个快照里 10 个坏节点就报 10 条。
 *   2. 再跑一次 `validateWorkspace` 收跨项不变量（nodeId 唯一、边端点存在、
 *      group 引用、generation.inputs 类型、viewport.zoom）。
 *      这一层是首错即抛，**只能拿到第一个**——不重复实现规则是本文件的硬约束，
 *      所以接受这个折中，并在注释里写明，不假装能全收。
 *
 * 资产存在性（不变量 7）不在此处检查：网关不持有 assetId 集合，
 * 该判断留在能拿到资产清单的调用点。
 */
function collectProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`workspace 快照必须是对象，收到 ${describeValue(value)}`];
  }

  const snapshot = value as { nodes?: unknown; edges?: unknown; viewport?: unknown };
  const problems: string[] = [];
  // 用 Set 去重：逐项校验与 validateWorkspace 会撞上同一条规则（如节点自身字段非法），
  // 不去重会让同一句话在 problems 里出现两次，看起来像两个缺陷。
  const seen = new Set<string>();
  const push = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    problems.push(message);
  };

  if (Array.isArray(snapshot.nodes)) {
    snapshot.nodes.forEach((raw, index) => {
      try {
        validateNode(raw, index);
      } catch (error) {
        push(toMessage(error));
      }
    });
  }

  if (Array.isArray(snapshot.edges)) {
    snapshot.edges.forEach((raw, index) => {
      try {
        validateEdge(raw, index);
      } catch (error) {
        push(toMessage(error));
      }
    });
  }

  try {
    validateWorkspace({ nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport });
  } catch (error) {
    push(toMessage(error));
  }

  return problems;
}

/**
 * 校验一个 workspace 快照。
 *
 * - `'off'`：不校验，直接 ok（但仍然回报 mode，见下）
 * - `'warn'`：校验，问题记进 problems，但 ok 仍为 true（不阻断）
 * - `'enforce'`：校验，有问题则 ok 为 false
 *
 * 为什么 `off` 也要回报 mode：静默跳过是排查成本最高的一种行为。
 * 日志里看到 `mode:'off'`，才能区分「这里根本没校验」和「校验过了、没问题」——
 * 两者在「ok: true」上完全同形。把模式显式回传，让「没校验」这件事在日志里可搜索。
 */
export function guardWorkspace(
  value: unknown,
  source: string,
  modeOverrides?: Record<string, GuardMode>,
): GuardDecision {
  const mode = resolveMode(source, modeOverrides);

  if (mode === 'off') {
    return { ok: true, mode, problems: [] };
  }

  const problems = collectProblems(value);

  return {
    // warn 只记账不阻断；enforce 才是硬门禁
    ok: mode === 'warn' ? true : problems.length === 0,
    mode,
    problems,
  };
}
