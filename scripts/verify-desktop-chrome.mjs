/**
 * verify-desktop-chrome.mjs — the three surface defects the desktop client reported.
 *
 * These are CSS/UX invariants, not logic, so they are asserted against the SHIPPED
 * bundle (where the stylesheet is a string literal) rather than by rendering:
 *
 *   #5  the overlay's 「跳过」 sits under the OS caption buttons, and a native
 *       window control always wins the hit test — no z-index reaches it. Two
 *       independent answers: drop the button below the window-controls strip
 *       using the WCO geometry (`env(titlebar-area-height)`), and give the
 *       keyboard an exit that the window chrome cannot swallow (Esc).
 *   #1  the sidebar footer is ONE flex row shared with other plugins; a neighbour
 *       that renders a full-width panel used to squeeze our cell until the 🎛
 *       button could not be hit. Never shrink (`flex:0 0 auto`), paint above
 *       (`z-index`), and keep the buttons out of the host's global button style.
 *   #6  the official client ships a global button style that our controls
 *       inherited, so the same markup looked different in the browser and in the
 *       app. One scoped reset at ELEMENT specificity (`:where()`), plus real host
 *       token names instead of ones that never existed (`--dsw-alias-text-*`).
 *
 * Usage: node scripts/verify-desktop-chrome.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

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

console.log(`bundle: ${BUNDLE}\n`)

console.log('#5 — the window chrome cannot swallow the exit:')
{
  const skip = rule('.dba-skip')
  check(skip !== null, 'the skip button still has a rule of its own')
  check(
    skip !== null && /env\(\s*titlebar-area-height/.test(skip),
    'it is offset below the window-controls strip (WCO geometry)',
    skip ?? 'no rule',
  )
  check(
    skip !== null && /top:20px/.test(skip) && skip.indexOf('top:20px') < skip.indexOf('env('),
    'a plain declaration comes first, so engines without WCO keep the old position',
  )
  check(
    skip !== null && /border:1px solid/.test(skip),
    'the scoped reset did not erase the button border (specificity is still element-level)',
  )
  check(
    /["']Escape["']/.test(SOURCE) && SOURCE.includes('keydown'),
    'Esc closes the overlay — the one exit a native control cannot intercept',
  )
  check(
    SOURCE.includes('跳过片头'),
    'the button says so in its label, so the keyboard exit is discoverable',
  )
}

console.log('\n#1 — the sidebar cell cannot be squeezed or covered:')
{
  const wrap = rule('.dba-pin-wrap')
  check(wrap !== null, 'the footer cluster has a class of its own (no inline flex style)')
  check(wrap !== null && /flex:0 0 auto/.test(wrap), 'it never shrinks inside the shared footer row', wrap ?? '')
  check(wrap !== null && /z-index:2/.test(wrap), 'and it paints above a sibling panel that overlaps it')
  check(wrap !== null && /position:relative/.test(wrap), 'z-index is effective (positioned element)')
}

console.log('\n#6 — the host button style no longer leaks in:')
{
  check(SOURCE.includes(':where('), 'the reset is scoped with :where(), i.e. element specificity')
  check(
    !/\.dba-(root|lib|pin-wrap) button\s*\{/.test(SOURCE),
    'no bare class+button selector competes with .dba-skip / .dba-pin',
  )
  check(
    /appearance:none/.test(SOURCE) && /-webkit-appearance:none/.test(SOURCE),
    'native button appearance is reset for every engine',
  )
  check(
    !SOURCE.includes('--dsw-alias-text-primary') && !SOURCE.includes('--dsw-alias-text-secondary'),
    'no references to host tokens that never existed (they silently fell back to light-theme greys)',
  )
  check(SOURCE.includes('--dsw-alias-label-secondary'), 'the real label tokens are used instead')
  check(
    !SOURCE.includes('--dsw-alias-bg-elevated'),
    'the library panel no longer asks for a background token the host does not publish',
  )
}

console.log('')
if (failures.length === 0) {
  console.log('all desktop-chrome checks passed')
  process.exit(0)
}
console.log(`${String(failures.length)} desktop-chrome check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
