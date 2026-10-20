// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/rename-retry.test.js
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'vitest'
import { WorkspaceStore } from '@/server/workspace-store'

const retry = (options = {}) => WorkspaceStore.prototype.replaceFileWithRetry.call({ dataFile: 'target.json' }, 'candidate.tmp', options)
const transient = code => Object.assign(new Error(`${code} fixture`), { code })

it('rename瞬时错误最多6次，前5次失败后成功；等待采用线性加有界抖动', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let attempts = 0
    const waits = [], calls = []
    await retry({ replace: async (...args) => { calls.push(args); if (++attempts < 6) throw transient(code) }, wait: async ms => { waits.push(ms) }, random: () => 0.5 })
    assert.equal(attempts, 6)
    assert.deepEqual(waits, [27.5, 42.5, 57.5, 72.5, 87.5])
    assert.ok(calls.every(args => args[0] === 'candidate.tmp' && args[1] === 'target.json'))
  }
})
it('rename永久瞬时故障第6次原样上抛，没有第7次或第6段等待', async () => {
  let attempts = 0
  const error = transient('EPERM'), waits = []
  await assert.rejects(retry({ replace: async () => { attempts += 1; throw error }, wait: async ms => { waits.push(ms) }, random: () => 0 }), candidate => candidate === error)
  assert.equal(attempts, 6); assert.deepEqual(waits, [15, 30, 45, 60, 75])
})
it('rename非瞬时错误立即原样上抛，成功也不等待', async () => {
  for (const code of ['ENOSPC', 'ENOENT', 'EIO']) {
    let attempts = 0, waits = 0
    const error = transient(code)
    await assert.rejects(retry({ replace: async () => { attempts += 1; throw error }, wait: async () => { waits += 1 } }), candidate => candidate === error)
    assert.equal(attempts, 1); assert.equal(waits, 0)
  }
  let calls = 0
  await retry({ replace: async () => { calls += 1 }, wait: async () => assert.fail('成功不可等待') })
  assert.equal(calls, 1)
})
it('rename抖动每次重新取样，固定随机源可证明下界与上界', async () => {
  for (const sample of [0, 0.2, 1 - Number.EPSILON]) {
    let attempts = 0, samples = 0
    const waits = []
    await retry({ replace: async () => { if (++attempts < 6) throw transient('EBUSY') }, wait: async ms => { waits.push(ms) }, random: () => { samples += 1; return sample } })
    assert.equal(samples, 5)
    for (const [index, ms] of waits.entries()) {
      const base = (index + 1) * 15
      assert.ok(ms >= base && ms <= base + 25)
      assert.ok(Math.abs(ms - (base + sample * 25)) < 1e-10)
    }
  }
})
