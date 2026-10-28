/**
 * verify-delete.mjs — batch delete for user clips, files included.
 *
 * The claims:
 *   A: a clip the user dropped into the managed folder can be deleted, and the
 *      FILE is removed from disk (not just hidden from the listing).
 *   B: embedded clips are never deletable, and no id can reach a file outside
 *      the managed folder.
 *   C: references to a deleted clip are cleared (global selection and the
 *      per-conversation pin), so nothing keeps pointing at a missing file.
 *   D: a batch is best-effort — what exists is deleted, what does not is
 *      reported, and one bad id does not abort the rest.
 *
 * Usage: node scripts/verify-delete.mjs
 */
import { existsSync } from 'node:fs'
import { createReport, startHarness } from './lib/harness.mjs'

const ROOT = '/dsh-boot-animation'
const report = createReport('delete')

const harness = await startHarness()
try {
  const pathA = harness.put('mine-a.mp4', Buffer.alloc(2048, 1))
  const pathB = harness.put('mine-b.mp4', Buffer.alloc(3072, 2))

  const first = (await harness.request('GET', `${ROOT}/videos.json`)).json()
  const clipA = first.videos.find((clip) => clip.file === 'mine-a.mp4')
  const clipB = first.videos.find((clip) => clip.file === 'mine-b.mp4')
  report.check(clipA !== undefined, 'a file dropped into videos/ is listed')
  report.check(clipA !== undefined && clipA.writable === true, 'and is marked writable (deletable)')
  report.check(clipB !== undefined, 'the second user clip is listed')

  const builtin = await harness.request('POST', `${ROOT}/delete`, { body: { clipIds: ['builtin:brand'] } })
  report.check(builtin.status === 400, 'deleting an embedded clip is refused (400)')
  const stillThere = (await harness.request('GET', `${ROOT}/videos.json`)).json()
  report.check(
    stillThere.videos.some((clip) => clip.id === 'builtin:brand'),
    'and the embedded clip is still listed',
  )

  const unknown = await harness.request('POST', `${ROOT}/delete`, { body: { clipIds: ['builtin:nope'] } })
  report.check(unknown.status === 400, 'an unknown clip id is refused (400)')
  const traversal = await harness.request('POST', `${ROOT}/delete`, {
    body: { clipIds: ['..%2F..%2Fselection.json'] },
  })
  report.check(traversal.status === 400, 'a path-shaped id is refused')
  const getRoute = await harness.request('GET', `${ROOT}/delete`)
  report.check(getRoute.status === 405, 'GET on /delete is 405')
  const empty = await harness.request('POST', `${ROOT}/delete`, { body: { clipIds: [] } })
  report.check(empty.status === 400, 'an empty batch is refused')

  const select = await harness.request('POST', `${ROOT}/select`, { body: { selectedClipId: clipA.id } })
  report.check(select.status === 200, 'the user clip can be selected first')
  const pin = await harness.request('POST', `${ROOT}/select`, {
    body: { scope: 'conversation', sessionId: 'session-delete', selectedClipId: clipA.id },
  })
  report.check(pin.status === 200, 'and pinned to a conversation')

  const deletedA = await harness.request('POST', `${ROOT}/delete`, { body: { clipIds: [clipA.id] } })
  const bodyA = deletedA.json()
  report.check(deletedA.status === 200 && bodyA.ok === true, 'deleting the user clip succeeds')
  report.check(Array.isArray(bodyA.deleted) && bodyA.deleted.includes(clipA.id), 'the response names it')
  report.check(existsSync(pathA) === false, 'the FILE is gone from disk')
  const afterA = (await harness.request('GET', `${ROOT}/videos.json`)).json()
  report.check(!afterA.videos.some((clip) => clip.id === clipA.id), 'the clip is gone from the listing')
  report.check(afterA.selectedClipId === null, 'a global selection pointing at it is cleared')
  const afterPin = (
    await harness.request('GET', `${ROOT}/videos.json?session=session-delete`)
  ).json()
  report.check(afterPin.conversationClipId === null, 'a conversation pin pointing at it is cleared')

  const batch = await harness.request('POST', `${ROOT}/delete`, {
    body: { clipIds: [clipB.id, 'missing-id'] },
  })
  const bodyBatch = batch.json()
  report.check(batch.status === 200 && bodyBatch.ok === true, 'a batch with one missing id still succeeds')
  report.check(Array.isArray(bodyBatch.deleted) && bodyBatch.deleted.length === 1, 'it deletes what exists')
  report.check(existsSync(pathB) === false, 'the second file is gone too')
  report.check(
    Array.isArray(bodyBatch.failed) && bodyBatch.failed.length === 1 && bodyBatch.failed[0].id === 'missing-id',
    'and reports the missing id as failed',
  )
  const finalList = (await harness.request('GET', `${ROOT}/videos.json`)).json()
  report.check(
    !finalList.videos.some((clip) => clip.source === 'yours'),
    'no user clips remain in the listing',
  )
} finally {
  await harness.close()
}

report.finish()
