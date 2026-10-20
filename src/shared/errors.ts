/**
 * EV Canvas · 错误类型
 * 来源：dsh-synapnova@3fd1d00 shared/schema.js:34-43（沿用 + 扩充）
 */

/** 输入非法 */
export class InputError extends Error {
  override readonly name = 'InputError';
}

/** 资源不存在 */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

/** 乐观锁冲突（409）。**不自动重发** */
export class RevisionConflictError extends Error {
  override readonly name: string = 'RevisionConflictError';
  constructor(
    message: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(message);
  }
}

/** 幂等窗口过期（继承冲突） */
export class IdempotencyExpiredError extends RevisionConflictError {
  override readonly name = 'IdempotencyExpiredError';
}

/** schema 版本不支持（旧版读到新格式时抛这个，而非静默误读） */
export class UnsupportedFormatError extends Error {
  override readonly name = 'UnsupportedFormatError';
}

/** 资产缺失（明确提示，不静默） */
export class MissingAssetError extends Error {
  override readonly name = 'MissingAssetError';
}
