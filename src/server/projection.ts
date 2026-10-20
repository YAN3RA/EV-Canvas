// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 server/projection.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 server/projection.js

/**
 * Synapnova event projection rules.
 *
 * Turns one committed DSH session event into the canvas representation, and
 * derives the working-directory/workspace labels. Pure functions only: no
 * filesystem and no host access.
 *
 * Extracted verbatim from index.js by refactor-slice2.mjs.
 */

import { MAX_PROJECTION_LENGTH, PROJECTION_TRUNCATED_SUFFIX, eventMessages, isRuntimeContextText, messageSourceVerdict } from '@/shared/schema'

/**
 * Decide one event-carried message: the text to project, or null when the
 * message is not a real user turn.
 *
 * Attribution is decided by `source.kind`, not by text: the runtime-context
 * prefix matched only 1 of the 7 injected kinds in the sampled session, and 1 of
 * the 18 kinds observed across the local session corpus — `agent-instructions`,
 * `skill-catalog`, `plugin:*` and `time-context` carry no prefix at all. The
 * text heuristic survives only as the fallback for legacy rows that carry no
 * attribution at all, so old projections stay readable.
 */
export function admittedUserText(message) {
  const verdict = messageSourceVerdict(message)
  if (verdict === 'injected') return null
  const text = contentText(message?.content)
  if (verdict === 'unknown' && isRuntimeContextText(text)) return null
  return text
}

/** Admitted user text carried by one message, across both durable carriers. */
export function projectableEvent(event) {
  switch (event.type) {
    case 'user/message': {
      // `eventMessages` is the carrier-agnostic reader: a `user/message` keeps
      // one message in `data`, an `agent/inbox/spliced` stages queued ones in
      // `data.inserted[]`. Admission is judged by `source.kind` on whichever
      // shape the host used, through the one shared predicate.
      const [message] = eventMessages(event)
      const text = admittedUserText(message)
      return text === null ? null : noteProjection('user', text)
    }
    case 'agent/inbox/spliced':
      // Queued messages are staged here and re-registered as `user/message`
      // with the same message id once admitted (~99% of staged rows in real
      // logs), so projecting the splice as well would render every queued
      // question twice. Staged rows the host retracts (`removedCount`) were
      // never admitted and must not leave a card behind. Their attribution is
      // still judged by the same rule, above, for anyone reading the splice.
      return null
    case 'assistant/message':
      return noteProjection('assistant', contentText(event.data?.message?.content))
    case 'todo/write':
      return noteProjection('todo', Array.isArray(event.data?.todos) ? event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n') : '')
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return noteProjection('error', errorText(reason.error) ?? '本轮执行失败')
      if (reason?.kind === 'cancelled' || reason?.kind === 'canceled' || reason?.kind === 'aborted') return noteProjection('error', '本轮已取消')
      return null
    }
    default:
      return /(?:error|failed|failure|cancel(?:led)?|abort)/i.test(event.type)
        ? noteProjection('error', errorText(event.data?.error ?? event.data?.reason ?? event.data) ?? 'Harness 运行失败')
        : null
  }
}

export function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : ''
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [name, code].filter(Boolean).concat(message).join(': ')
  return [name, code].filter(Boolean).join(': ') || null
}

export function noteProjection(kind, text) {
  const normalized = text.trim()
  if (normalized === '') return null
  if (normalized.length <= MAX_PROJECTION_LENGTH) return { kind, text: normalized }
  return { kind, text: `${normalized.slice(0, MAX_PROJECTION_LENGTH)}${PROJECTION_TRUNCATED_SUFFIX}` }
}

export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'tool-call') return [block.name, block.arguments]
    if (block?.type === 'tool-result') return contentText(block.content)
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

export function titleFromText(text) {
  const line = text.replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话'
}

export function sessionCwd(session) {
  // The Session header defines `cwd` as its only working-directory carrier; the
  // old `header.meta.cwd` fallback never matched a real header field.
  const cwd = session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录'
}

export function workspaceTitle(cwd, fallbackTitle) {
  if (cwd === '未指定工作目录') return fallbackTitle
  const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}
