/**
 * verify-handoff.mjs — the exit is a transition, not a cut.
 *
 * Why this file exists: the overlay used to unmount in the same frame that
 * `store.stop()` ran, so the last thing a user saw was a hard edge between the
 * clip and their workspace. 0.4.4 replaces it with a hand-off: the clip
 * defocuses and fades while a backdrop blur on the layer decays from 18px to
 * none, so the app resolves out of softness instead of popping in.
 *
 * The two halves of that live in different files and are easy to drift apart:
 *
 *   - `HANDOFF_MS` in ui.ts decides when the overlay leaves the tree
 *   - the `.46s` in styles.ts decides how long the CSS actually takes
 *
 * If the timer is the shorter of the two the transition is cut halfway and the
 * result looks worse than having no transition at all — the exact failure this
 * suite exists to catch. Everything else here is a guard on the effect being
 * present at all (a `display:none` in the future would pass a screenshot, not
 * this).
 *
 * Usage: node scripts/verify-handoff.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Evaluate the bundle just far enough to read its exports. */
function loadExports() {
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
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    // eslint-disable-next-line no-eval
    eval(SOURCE)
  } catch (error) {
    console.error(`verify-handoff: evaluating the bundle threw — ${String(error?.message ?? error)}`)
    process.exit(2)
  }
  return loaded
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

/** One CSS rule body, from the bundle's stylesheet string. */
function rule(selector) {
  const pattern = new RegExp(String.raw`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\{[\s\S]*?\}`)
  const match = SOURCE.match(pattern)
  return match === null ? null : match[0]
}

/** The CSS duration of the exit animation, in milliseconds. */
function cssExitMs() {
  const match = SOURCE.match(/dba-defocus\s+([\d.]+)s/)
  return match === null ? null : Math.round(Number(match[1]) * 1000)
}

console.log(`bundle: ${BUNDLE}\n`)

const api = loadExports()
const handoff = api === null ? undefined : api.HANDOFF_MS

console.log('the timer outlasts the transition:')
{
  const cssMs = cssExitMs()
  check(typeof handoff === 'number' && handoff > 0, `HANDOFF_MS is exported (${String(handoff)})`)
  check(cssMs !== null, 'the exit animation declares a duration', SOURCE.match(/dba-defocus[^)]{0,40}/)?.[0] ?? '')
  check(
    typeof handoff === 'number' && cssMs !== null && handoff > cssMs,
    `the overlay stays mounted past the CSS (${String(handoff)}ms > ${String(cssMs)}ms)`,
    'a shorter timer cuts the transition halfway',
  )
}

console.log('\nthe clip defocuses instead of disappearing:')
{
  const leavingVideo = rule('.dba-root.dba-leaving .dba-video')
  check(leavingVideo !== null, 'there is a leaving state for the clip')
  check(leavingVideo !== null && /opacity:0/.test(leavingVideo), 'the clip fades out')
  check(leavingVideo !== null && /filter:blur\(/.test(leavingVideo), 'and blurs while it goes')
  const base = rule('.dba-video')
  check(
    base !== null && /transition:opacity/.test(base) && /filter/.test(base),
    'the fade is a transition, so it is smooth rather than a jump',
  )
}

console.log('\nthe app resolves out of softness:')
{
  const leaving = rule('.dba-root.dba-leaving')
  check(leaving !== null, 'the layer has a leaving state')
  check(leaving !== null && /background-color:transparent/.test(leaving), 'the black plate clears')
  check(
    leaving !== null && /dba-defocus/.test(leaving),
    'and the backdrop blur is driven by an animation (so it can decay)',
  )
  const keyframes = SOURCE.match(/@keyframes dba-defocus\{[\s\S]*?\}\s*\}/)
  check(keyframes !== null, 'the defocus keyframes exist')
  check(
    keyframes !== null && /blur\(1[0-9]px\)/.test(keyframes),
    'it starts blurred enough to hide the app',
    keyframes?.[0]?.slice(0, 120) ?? '',
  )
  check(keyframes !== null && /blur\(0px\)/.test(keyframes), 'and ends sharp, leaving nothing to see')
  check(
    leaving !== null && /pointer-events:none/.test(leaving),
    'the app becomes clickable immediately, not after the overlay unmounts',
  )
}

console.log('\nand the entry is not a pop either:')
{
  check(/@keyframes dba-focus-in\{/.test(SOURCE), 'the clip fades in on mount')
  const base = rule('.dba-video')
  check(base !== null && /animation:dba-focus-in/.test(base), 'the entry animation is wired to the clip')
}

console.log('\naccessibility and layering:')
{
  check(
    SOURCE.includes('prefers-reduced-motion'),
    'reduced-motion turns the transitions off instead of forcing them',
  )
  check(
    /\.dba-root\.dba-leaving \.dba-skip[^{]*\{[^}]*animation:none/.test(SOURCE),
    'the chrome fades because its own animations are stopped first',
  )
}

console.log('')
if (failures.length === 0) {
  console.log('all hand-off checks passed')
  process.exit(0)
}
console.log(`${String(failures.length)} hand-off check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
