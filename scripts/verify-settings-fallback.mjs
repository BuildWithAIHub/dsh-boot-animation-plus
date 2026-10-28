/**
 * verify-settings-fallback.mjs — a host that never answers must not mean "no intro".
 *
 * Why this file exists: `settingsLoaded` is a HARD gate on `decidePlay` — no
 * settings payload, no decision. That is right while the payload is on its way
 * (it arrives in milliseconds) and catastrophic when it never arrives: the gate
 * stops protecting the user's choice and simply means "no animation, silently,
 * for the rest of this launch". The field report is 「有时候就是不出现，重启才有」.
 *
 * 0.4.3 fixes it on two levels, and both are asserted here against the SHIPPED
 * bundle rather than a copy:
 *
 *   1. `/videos.json` is retried (two backoffs) before the read is called failed,
 *      because first paint genuinely races the plugin's own routes;
 *   2. if the host still has not answered, `markSettingsFallback()` lets the
 *      launch decide with the host's defaults instead of waiting forever.
 *
 * It drives the real `ClientStore` with a stubbed `fetch`, so the retry behaviour
 * is observed, not assumed (a test that only inspected the source would pass even
 * if the loop wrote the same state three times).
 *
 * Usage: node scripts/verify-settings-fallback.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

/** Enough of React for module evaluation; nothing here renders. */
const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/** Evaluate the shipped bundle against a scripted `fetch`. */
function load(fetchImpl) {
  const local = makeStorage()
  const session = makeStorage()
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        loaded = factory((id) => {
          if (id === 'react' || id === 'react/jsx-runtime') return reactStub
          throw new Error(`unexpected require(${id})`)
        })
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  for (const [name, value] of [
    ['localStorage', local],
    ['sessionStorage', session],
  ]) {
    Object.defineProperty(globalThis.window, name, { configurable: true, get: () => value })
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.fetch = fetchImpl
  try {
    // eslint-disable-next-line no-eval
    eval(readFileSync(BUNDLE, 'utf8'))
  } catch (error) {
    console.error(`verify-settings-fallback: evaluating the bundle threw — ${String(error?.message ?? error)}`)
    process.exit(2)
  }
  return loaded
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

console.log(`bundle: ${BUNDLE}\n`)

/** A host payload shaped like the real /videos.json. */
const payload = {
  videos: [{ id: 'brand', name: 'brand', file: null, ext: '.mp4', source: 'embedded', bytes: 1024 }],
  userDir: 'C:\\videos',
  accepts: ['.mp4'],
  selectedClipId: 'brand',
  randomPlayback: false,
  fitMode: 'cover',
  playOnAppStart: false,
  conversationClipId: null,
}

console.log('the host never answers:')
{
  let calls = 0
  const api = load(async () => {
    calls += 1
    throw new Error('ECONNREFUSED')
  })
  const store = new api.ClientStore()
  check(store.getSnapshot().settingsLoaded === false, 'a fresh store starts undecided')

  await store.loadCatalog()
  check(calls === 3, `the read is retried before giving up (${String(calls)} attempts, expected 3)`)
  check(store.getSnapshot().settingsLoaded === false, 'a failed read leaves the decision waiting')
  check(store.usedSettingsFallback === false, 'and does not silently claim to have settings')
  check(store.getSnapshot().loading === false, 'and the spinner stops')

  store.markSettingsFallback('verify')
  check(store.getSnapshot().settingsLoaded === true, 'the fallback lets the launch decide')
  check(store.usedSettingsFallback === true, 'and records that it happened')

  const afterFallback = store.getSnapshot()
  store.markSettingsFallback('again')
  check(store.getSnapshot() === afterFallback, 'calling it twice changes nothing')

  const decision = api.decidePlay({
    sessionId: null,
    entered: true,
    settingsLoaded: afterFallback.settingsLoaded,
    settings: afterFallback.settings,
    pinned: null,
    isNewConversation: false,
    bootPlayed: false,
    sessionPlayed: false,
  })
  check(decision.action === 'play', 'after the fallback the launch rule really does play')
}

console.log('\na read that succeeds on retry:')
{
  let calls = 0
  const api = load(async () => {
    calls += 1
    if (calls < 3) throw new Error('route is not registered yet')
    return { ok: true, json: async () => payload }
  })
  const store = new api.ClientStore()
  await store.loadCatalog()
  const snapshot = store.getSnapshot()

  check(calls === 3, `it took exactly 3 attempts (${String(calls)})`)
  check(snapshot.settingsLoaded === true, 'the payload still lands')
  check(store.usedSettingsFallback === false, 'and the fallback never runs')
  check(snapshot.settings.playOnAppStart === false, "the host's value wins over the default")
  check(snapshot.catalog?.clips?.length === 1, 'the catalog arrives with it')
  check(snapshot.status.kind === '', 'no error is reported for a recovered read')
}

console.log('\na host that answers 404 (not a network error):')
{
  let calls = 0
  const api = load(async () => {
    calls += 1
    return { ok: false, status: 404, json: async () => ({}) }
  })
  const store = new api.ClientStore()
  await store.loadCatalog()
  check(calls === 3, `a non-ok status is retried too (${String(calls)} attempts)`)
  check(store.getSnapshot().settingsLoaded === false, 'and it still ends undecided, not guessed')
  check(store.getSnapshot().status.kind === 'dba-err', 'the library panel shows why')
}

console.log('')
if (failures.length === 0) {
  console.log('all settings-fallback checks passed')
  process.exit(0)
}
console.log(`${String(failures.length)} settings-fallback check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
