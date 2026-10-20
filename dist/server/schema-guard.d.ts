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
export declare const DEFAULT_GUARD_MODES: Readonly<Record<string, GuardMode>>;
/**
 * 未知来源落到 `warn`。
 *
 * 为什么不是 `enforce`：未知来源的形状未知，用创作节点规则去否决它，
 * 等于假设「所有新接入方都产出合规创作节点」——这个假设一旦不成立就是线上写入失败。
 * 为什么不是 `off`：静默放行未知来源，等于给未来的调用点开了个后门。
 * `warn` 是唯一既不阻断也不沉默的位置：先记录，看清真实形状再决定提档。
 */
export declare const FALLBACK_GUARD_MODE: GuardMode;
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
export declare function guardWorkspace(value: unknown, source: string, modeOverrides?: Record<string, GuardMode>): GuardDecision;
