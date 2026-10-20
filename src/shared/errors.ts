/**
 * EV Canvas · 错误类型（**唯一**定义处）
 *
 * 为什么集中在这里：`shared/schema.ts` 迁移自旧版时自带了一套同名错误类，
 * 与 `errors.ts` 的定义互不相干。两套类各自 `instanceof` 只认自己，
 * 于是「store 抛 NotFoundError → 路由映射成 404」这条链会在跨模块处
 * 静默失效、退化成 500。**任何模块都必须从这里 import，不得再自行定义同名类。**
 *
 * 兼容性说明：`RevisionConflictError` 的签名同时接受两种调用形态：
 *   - `new RevisionConflictError(currentRevision)`            —— 旧版迁移来的调用点
 *   - `new RevisionConflictError(message, expected, actual)`   —— 显式三参数形态
 * 两种都暴露 `currentRevision` 与 `expected`，路由层不必区分来源。
 */

/** 输入非法（400） */
export class InputError extends Error {
  override readonly name = 'InputError';
  /** 机器可辨识的错误码（可选，如 IDEMPOTENCY_EXPIRED） */
  code?: string;
}

/** 资源不存在（404） */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

/**
 * 乐观锁冲突（409）。**不自动重发**——重发会掩盖真正的并发写。
 *
 * 两种构造形态都保留，见文件头。
 */
export class RevisionConflictError extends Error {
  override readonly name: string = 'RevisionConflictError';
  /** 当前（最新）revision；旧版迁移调用点用这个名字 */
  readonly currentRevision: number;
  /** 期望 revision；三参数形态下才有意义，否则等于 currentRevision */
  readonly expected: number;
  /** 实际 revision */
  readonly actual: number;
  /**
   * 机器可读错误码。**故意可变**：同一类冲突在不同业务路径上有更具体的码
   * （如 store 的 `PROJECTION_EPOCH_CONFLICT`），由抛出点覆盖而不是为每种情况
   * 新建子类。声明成 `readonly` 会逼调用方写 `(error as {code: string}).code = ...`
   * 那种绕行断言，反而更危险。
   */
  code: string = 'REVISION_CONFLICT';

  constructor(currentRevisionOrMessage: number | string, expectedOrMessage?: number | string, actual?: number) {
    if (typeof currentRevisionOrMessage === 'string') {
      const expectedRevision = typeof expectedOrMessage === 'number' ? expectedOrMessage : 0;
      super(currentRevisionOrMessage);
      this.currentRevision = actual ?? expectedRevision;
      this.expected = expectedRevision;
      this.actual = actual ?? expectedRevision;
      return;
    }
    const currentRevision = currentRevisionOrMessage;
    const message = typeof expectedOrMessage === 'string' ? expectedOrMessage : '工作区已更新，请重新预览后重试';
    super(message);
    this.currentRevision = currentRevision;
    this.expected = currentRevision;
    this.actual = currentRevision;
  }
}

/** 幂等窗口过期（继承冲突）。`operationId` 已超出窗口，需重新预览。 */
export class IdempotencyExpiredError extends RevisionConflictError {
  override readonly name = 'IdempotencyExpiredError';
  override readonly code: string = 'IDEMPOTENCY_EXPIRED';

  constructor(currentRevision: number) {
    super(currentRevision, 'operationId 已超出幂等窗口，请重新预览并生成新 ID');
  }
}

/** schema 版本不支持（旧版读到新格式时抛这个，而非静默误读） */
export class UnsupportedFormatError extends Error {
  override readonly name = 'UnsupportedFormatError';
}

/** 资产缺失（明确提示，不静默） */
export class MissingAssetError extends Error {
  override readonly name = 'MissingAssetError';
}
