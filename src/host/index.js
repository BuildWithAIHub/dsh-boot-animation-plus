/**
 * dsh-boot-animation — host half.
 *
 * This file owns exactly one thing: HTTP. It builds the eight collaborators
 * (registry, resolver, selection store, media server, diagnostics, random,
 * errors) and registers the routes that expose them. It decides nothing about
 * clips itself — every "which clip" question goes through ClipResolver, every
 * byte through MediaServer.
 *
 * Plain JavaScript with no DSH SDK imports, so it needs no compiler: the build
 * copies `src/host/` over `lib/host/` and `src/host/index.js` to `lib/index.js`.
 * Node resolves the relative imports natively; there is no bundler in this half.
 *
 * Routes (all under /dsh-boot-animation):
 *
 *   GET  /media/<clipId>     the canonical, per-clip media resource
 *   GET  /boot.mp4           backward compatibility: 302 to the canonical URL
 *   GET  /resolve.json       the single "which clip plays now" answer
 *   GET  /videos.json        the library, the selection and the settings
 *   POST /select             select a clip, or change random/fit, or pin a conversation
 *   POST /delete             delete user clips AND their files (batch)
 *   GET  /status.json        diagnostics, active clip, full listing
 *
 * `?session=<id>` on resolve/videos/status/boot.mp4 asks the per-conversation
 * question: "which clip plays in THIS conversation". Without it every answer is
 * exactly what it was before the conversation layer existed, which is what keeps
 * an already-installed client working unchanged.
 *
 * Layout on disk:
 *   $DSH_HOME/boot-animation/selection.json   settings only (see selection-store)
 *   $DSH_HOME/boot-animation/videos/*.mp4     the user's own clips
 *   $DSH_HOME/boot-animation/intro.mp4        legacy drop-in, still honoured
 *   lib/clips.meta.js + lib/clips.data.js     the embedded built-ins
 */
import { readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIPS } from '../clips.meta.js'
import { ACTIVE_ALIAS, normalizeClipId } from './clip-id.js'
import { ClipRegistry } from './clip-registry.js'
import { ClipResolver } from './clip-resolver.js'
import { Diagnostics } from './diagnostics.js'
import { PluginError, asBootAnimationError } from './errors.js'
import { MediaServer } from './media-server.js'
import { RandomController } from './random-controller.js'
import { SelectionStore, normalizeSessionId } from './selection-store.js'

export const name = 'dsh-boot-animation'

/** The webserver routes are the only host service this plugin needs. */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
/** lib/host/index.js -> package root */
const PKG_ROOT = join(HERE, '..', '..')

const BASE_ROUTE = '/dsh-boot-animation'
const ROUTE = BASE_ROUTE + '/boot.mp4'
/**
 * NO trailing slash. The webserver matches a prefix route with
 *   pathname !== prefix && !pathname.startsWith(prefix + '/')
 * so a registered path of `.../media/` would be tested as `.../media//` and
 * never match a real `.../media/<id>` request — every media URL 404s.
 */
const MEDIA_ROUTE = BASE_ROUTE + '/media'
const LIST_ROUTE = BASE_ROUTE + '/videos.json'
const SELECT_ROUTE = BASE_ROUTE + '/select'
const STATUS_ROUTE = BASE_ROUTE + '/status.json'
const RESOLVE_ROUTE = BASE_ROUTE + '/resolve.json'
const DELETE_ROUTE = BASE_ROUTE + '/delete'
const DATA_MODULE = '../clips.data.js'

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0'
  } catch {
    return '0'
  }
}

function homeDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'boot-animation')
}

/** The directories the user adds clips to. The plugin ships none of its own. */
function scanDirs() {
  const dir = homeDir()
  return [
    { source: 'yours', dir: join(dir, 'videos'), writable: true },
    { source: 'yours', dir, writable: true },
  ]
}

/**
 * The file's real path when it lives inside one of `dirs`, else null.
 *
 * Deletion is destructive, so it gets the same containment rule the listing
 * already applies to serving: a symlink or junction inside a managed folder must
 * not let a "delete this clip" request reach a file outside it.
 */
function containedFilePath(file, dirs) {
  let realFile
  try {
    realFile = realpathSync(file).toLowerCase()
  } catch {
    return null
  }
  for (const dir of dirs) {
    let realDir
    try {
      realDir = realpathSync(dir).toLowerCase()
    } catch {
      continue
    }
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep
    if (realFile.startsWith(prefix)) return realFile
  }
  return null
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload, null, 2))
}

/**
 * Plain-text reply, always uncacheable.
 *
 * Every failure path says `no-store`: a 404 with no cache directive is
 * heuristically cacheable, so a route that 404s once while it is broken keeps
 * 404ing in that browser after the fix.
 */
function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Whether a socket address is the loopback interface.
 *
 * The plugin's routes are plain HTTP routes on the DSH web server: the
 * connection's token auth covers the RPC surface, not these. They exist for the
 * local GUI only, so a request from anywhere but this machine is refused instead
 * of exposing the user's video folder to a port-forwarded or LAN-exposed host.
 * A request with no socket (in-process callers, the test harness) is allowed;
 * every real request has one.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return true
  const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1'
}

/** Refuse non-loopback requests and contain a handler's synchronous failure. */
function localOnly(handler) {
  return (req, res) => {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      sendText(res, 403, 'dsh-boot-animation: local access only')
      return
    }
    try {
      const result = handler(req, res)
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch(() => {
          /* route-level failure is already reported by its own handler */
        })
      }
    } catch {
      try {
        sendText(res, 500, 'dsh-boot-animation: request failed')
      } catch {
        /* socket already gone */
      }
    }
  }
}

/** The raw query string of a request, without the leading `?`. */
function queryOf(req) {
  const raw = typeof req.url === 'string' ? req.url : ''
  const at = raw.indexOf('?')
  return at === -1 ? '' : raw.slice(at + 1)
}

/**
 * The `?session=` parameter, or null.
 *
 * Extracted here and validated in one place (the selection store), so the
 * resolver, the listing and the select endpoint all agree on what a session key
 * is. An absent or empty parameter means "the global question", which is what
 * every caller asked before this layer existed.
 */
function sessionOf(req) {
  const value = new URLSearchParams(queryOf(req)).get('session')
  return value === null || value === '' ? null : value
}

/** One clip as the wire format has always spelled it, plus the new fields. */
function publicClip(clip, selection, extra = {}) {
  return {
    id: clip.id,
    name: clip.name,
    file: clip.file,
    ext: clip.ext,
    source: clip.source,
    kind: clip.kind,
    writable: clip.writable,
    embedded: clip.embedded ?? null,
    bytes: clip.bytes,
    mtime: clip.mtime,
    legacy: clip.legacy,
    faststart: clip.faststart === true,
    /**
     * The identity a client pins into the media URL as `?v=`.
     *
     * `clip.version()`, NOT `contentKey`: a file that never needed hashing has no
     * contentKey, and emitting null there would leave the client pinning nothing
     * while the media server compared `s<size>-t<mtime>` — a mismatch that
     * silently costs every replay a revalidation round trip.
     */
    version: clip.version(),
    /** The canonical resource for this clip. Never a shared URL. */
    mediaUrl: `${MEDIA_ROUTE}/${encodeURIComponent(clip.id)}`,
    copies: clip.copies ?? 1,
    alsoAt: clip.alsoAt ?? [],
    selected: selection.selectedClipId === clip.id,
    ...extra,
  }
}

export function apply(ctx) {
  const diagnostics = new Diagnostics({ version: readVersion() })
  const selection = new SelectionStore(join(homeDir(), 'selection.json'), { diagnostics })
  const registry = new ClipRegistry({ embedded: CLIPS, scanDirs, diagnostics })
  const random = new RandomController()
  const resolver = new ClipResolver({
    registry,
    selection,
    random,
    envPath: () => (typeof process.env.DSH_BOOT_ANIMATION === 'string' ? process.env.DSH_BOOT_ANIMATION : null),
    diagnostics,
  })
  const media = new MediaServer({ dataModulePath: DATA_MODULE, diagnostics })

  diagnostics.event('plugin-applied', { clips: CLIPS.length, cli: 'dynamic-inject' })

  /** The library listing, shared by /videos.json and /status.json. */
  const libraryPayload = (sessionId = null) => {
    const clips = registry.list()
    const { clip, how } = resolver.resolveActive(sessionId)
    const settings = selection.read()
    /**
     * The pin that is actually IN EFFECT for this conversation.
     *
     * Derived from `how` rather than read from the store, so the listing and the
     * playback decision can never disagree: a pin whose clip has been moved away
     * reports as "no pin here" in both places (and is recorded in diagnostics).
     */
    const conversationClipId = how === 'conversation' && clip !== null ? clip.id : null
    return {
      clips,
      active: clip,
      how,
      settings,
      payload: {
        // Historical field names, kept: an old client reads these.
        activeId: clip === null ? null : clip.id,
        activeHow: how,
        activeVersion: clip === null ? null : clip.version(),
        videos: clips.map((item) =>
          publicClip(item, settings, {
            active: clip !== null && item.id === clip.id,
            conversation: conversationClipId !== null && item.id === conversationClipId,
          }),
        ),
        userDir: '%DSH_HOME%/boot-animation/videos',
        accepts: [...new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv'])],
        // New: the settings that used to be split between localStorage and here.
        selectedClipId: settings.selectedClipId,
        randomPlayback: settings.randomPlayback,
        fitMode: settings.fitMode,
        /**
         * Which auto-play rule the client obeys.
         *
         * Deliberately part of the SETTINGS payload and not a client default: it
         * is the user's choice, it must survive a DSH port change (localStorage
         * would not), and the client's decision effect waits for this payload
         * instead of guessing.
         */
        playOnAppStart: settings.playOnAppStart,
        // Optional welcome layer (this fork). Same payload, same store.
        loginOverlay: settings.loginOverlay,
        welcomeTitle: settings.welcomeTitle,
        welcomeName: settings.welcomeName,
        welcomeSubtitle: settings.welcomeSubtitle,
        welcomeHint: settings.welcomeHint,
        selectionVersion: settings.version,
        mediaRoute: MEDIA_ROUTE,
        /**
         * The per-conversation layer, as it applies to the caller.
         *
         * Only THIS session's pin is published — never the whole map. The client
         * has no use for other conversations' ids, and a settings file that leaks
         * every session id a user ever pinned is a worse shape than one that
         * answers the question actually asked.
         */
        conversationClipId,
        conversationOverrideCount: Object.keys(settings.conversationOverrides).length,
        sessionKnown: sessionId !== null,
      },
    }
  }

  const serveList = (req, res) => {
    try {
      sendJson(res, libraryPayload(sessionOf(req)).payload)
    } catch (cause) {
      const error = asBootAnimationError(cause, 'plugin', 'serving the library')
      diagnostics.event('library-error', { message: error.message })
      sendJson(res, { ok: false, error: 'library unavailable', boundary: error.boundary }, 500)
    }
  }

  const serveStatus = (req, res) => {
    try {
      const { payload } = libraryPayload(sessionOf(req))
      sendJson(res, {
        active: payload.activeId,
        activeHow: payload.activeHow,
        activeVersion: payload.activeVersion,
        count: payload.videos.length,
        selectedClipId: payload.selectedClipId,
        randomPlayback: payload.randomPlayback,
        fitMode: payload.fitMode,
        playOnAppStart: payload.playOnAppStart,
        loginOverlay: payload.loginOverlay,
        welcomeTitle: payload.welcomeTitle,
        welcomeName: payload.welcomeName,
        welcomeSubtitle: payload.welcomeSubtitle,
        welcomeHint: payload.welcomeHint,
        conversationClipId: payload.conversationClipId,
        conversationOverrideCount: payload.conversationOverrideCount,
        /**
         * How many embedded clips are currently decoded in memory.
         *
         * Reported because "the plugin must not decode all four clips at
         * install" is otherwise unobservable from outside — and an install-time
         * stall is exactly the kind of regression that no unit test notices.
         * `verify-install.mjs` asserts it is 0 before any media request and 1
         * after one clip is fetched.
         */
        decodedClips: media.decoded.size,
        videos: payload.videos,
        diagnostics: diagnostics.snapshot(),
      })
    } catch (cause) {
      const error = asBootAnimationError(cause, 'plugin', 'serving status')
      sendJson(res, { ok: false, error: 'status unavailable', boundary: error.boundary }, 500)
    }
  }

  /**
   * The single answer to "which clip plays now".
   *
   * With `?session=` and a pin in place, that conversation's clip answers first;
   * otherwise `mode=active` respects random (when enabled) → selection → env →
   * legacy drop-in → library → embedded. `mode=random` asks for a random pick
   * outright and is deliberately NEVER answered by a pin — the caller asked for a
   * random clip, and a pin is a request for a specific one. `mode=selected`
   * returns the user's choice for this conversation (its pin, else the stored
   * selection, else null). Everything downstream plays the returned clipId
   * through ONE media path.
   */
  const serveResolve = (req, res) => {
    try {
      const mode = new URLSearchParams(queryOf(req)).get('mode') ?? 'active'
      const sessionId = sessionOf(req)
      if (mode === 'selected') {
        const pinned = resolver.conversationPick(sessionId)
        const id = pinned === null ? selection.read().selectedClipId : pinned.id
        const clip = id === null ? null : registry.get(id)
        sendJson(res, {
          clipId: clip === null ? null : clip.id,
          version: clip === null ? null : clip.version(),
          how: clip === null ? 'none' : pinned === null ? 'selected' : 'conversation',
          mediaUrl: clip === null ? null : `${MEDIA_ROUTE}/${encodeURIComponent(clip.id)}`,
        })
        return
      }
      if (mode === 'random') {
        const pool = resolver.playable()
        const chosen = random.pick(pool)
        sendJson(res, {
          clipId: chosen === null ? null : chosen.id,
          version: chosen === null ? null : chosen.version(),
          how: chosen === null ? 'none' : 'random',
          poolSize: pool.length,
          mediaUrl: chosen === null ? null : `${MEDIA_ROUTE}/${encodeURIComponent(chosen.id)}`,
        })
        return
      }
      const { clip, how } = resolver.resolveActive(sessionId)
      sendJson(res, {
        clipId: clip === null ? null : clip.id,
        version: clip === null ? null : clip.version(),
        how,
        sessionScoped: how === 'conversation',
        mediaUrl: clip === null ? null : `${MEDIA_ROUTE}/${encodeURIComponent(clip.id)}`,
      })
    } catch (cause) {
      const error = asBootAnimationError(cause, 'plugin', 'resolving the active clip')
      diagnostics.event('resolve-error', { message: error.message })
      sendJson(res, { clipId: null, how: 'error', boundary: error.boundary }, 500)
    }
  }

  /** `POST /select` — the user's choice, and nothing but the choice. */
  const handleSelect = (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: 'POST required' }, 405)
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 8192) req.destroy()
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, { ok: false, error: 'invalid JSON body' }, 400)
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, { ok: false, error: 'body must be an object' }, 400)
        return
      }
      /**
       * `scope: 'conversation'` writes the per-conversation layer instead of the
       * global settings. Anything else (including no scope at all) is the
       * original global write, byte for byte.
       */
      const scope = typeof parsed.scope === 'string' ? parsed.scope : 'global'
      if (scope === 'conversation') {
        const sessionId = normalizeSessionId(parsed.sessionId)
        if (sessionId === null) {
          sendJson(res, { ok: false, error: 'scope=conversation needs a usable sessionId' }, 400)
          return
        }
        const requested = Object.prototype.hasOwnProperty.call(parsed, 'selectedClipId')
          ? parsed.selectedClipId
          : Object.prototype.hasOwnProperty.call(parsed, 'id')
            ? parsed.id
            : undefined
        if (requested === undefined) {
          sendJson(res, { ok: false, error: 'scope=conversation needs id (or selectedClipId); null clears the pin' }, 400)
          return
        }
        const clearing = requested === null || requested === ''
        const id = clearing ? null : normalizeClipId(requested)
        if (id === null && !clearing) {
          sendJson(res, { ok: false, error: 'conversation override must be a real ClipId' }, 400)
          return
        }
        if (id === ACTIVE_ALIAS) {
          sendJson(res, { ok: false, error: 'conversation override must be a real ClipId' }, 400)
          return
        }
        if (id !== null && registry.get(id) === null) {
          sendJson(res, { ok: false, error: 'no clip with that id' }, 404)
          return
        }
        try {
          const pinned = selection.setConversationOverride(sessionId, id)
          diagnostics.event('conversation-override-written', { clipId: pinned })
          registry.invalidate()
          sendJson(res, {
            ok: true,
            scope: 'conversation',
            conversationClipId: pinned,
            name: pinned === null ? null : (registry.get(pinned)?.name ?? null),
          })
        } catch (cause) {
          const error = asBootAnimationError(cause, 'clip', 'saving the conversation override')
          diagnostics.event('conversation-override-write-failed', { message: error.message })
          sendJson(res, { ok: false, error: error.message, boundary: error.boundary }, 500)
        }
        return
      }
      if (scope !== 'global') {
        sendJson(res, { ok: false, error: `unknown scope "${scope}"` }, 400)
        return
      }

      /** @type {Record<string, unknown>} */
      const patch = {}
      // `id` is the 0.1.x/0.2.x spelling; keep accepting it.
      if (Object.prototype.hasOwnProperty.call(parsed, 'selectedClipId')) patch.selectedClipId = parsed.selectedClipId
      else if (Object.prototype.hasOwnProperty.call(parsed, 'id')) patch.selectedClipId = parsed.id
      if (Object.prototype.hasOwnProperty.call(parsed, 'randomPlayback')) patch.randomPlayback = parsed.randomPlayback
      if (Object.prototype.hasOwnProperty.call(parsed, 'fitMode')) patch.fitMode = parsed.fitMode
      // The app-start toggle travels the same path as every other setting, so it
      // is written atomically and with the same validation as the rest.
      if (Object.prototype.hasOwnProperty.call(parsed, 'playOnAppStart')) patch.playOnAppStart = parsed.playOnAppStart
      if (Object.prototype.hasOwnProperty.call(parsed, 'loginOverlay')) patch.loginOverlay = parsed.loginOverlay
      for (const key of ['welcomeTitle', 'welcomeName', 'welcomeSubtitle', 'welcomeHint']) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) patch[key] = parsed[key]
      }

      if (Object.keys(patch).length === 0) {
        sendJson(res, { ok: false, error: 'nothing to change' }, 400)
        return
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'selectedClipId')) {
        const id = normalizeClipId(patch.selectedClipId)
        if (id === null || id === ACTIVE_ALIAS) {
          sendJson(res, { ok: false, error: 'selectedClipId must be a real ClipId' }, 400)
          return
        }
        if (registry.get(id) === null) {
          sendJson(res, { ok: false, error: 'no clip with that id' }, 404)
          return
        }
        patch.selectedClipId = id
      }
      try {
        const next = selection.write(/** @type {any} */ (patch))
        diagnostics.event('selection-written', { ...patch, selectedClipId: next.selectedClipId })
        // The listing changed under us: drop the cached scan so the next read
        // reports the new state rather than the previous answer.
        registry.invalidate()
        sendJson(res, {
          ok: true,
          selectedClipId: next.selectedClipId,
          randomPlayback: next.randomPlayback,
          fitMode: next.fitMode,
          playOnAppStart: next.playOnAppStart,
          loginOverlay: next.loginOverlay,
          welcomeTitle: next.welcomeTitle,
          welcomeName: next.welcomeName,
          welcomeSubtitle: next.welcomeSubtitle,
          welcomeHint: next.welcomeHint,
          name: next.selectedClipId === null ? null : (registry.get(next.selectedClipId)?.name ?? null),
        })
      } catch (cause) {
        const error = asBootAnimationError(cause, 'clip', 'saving the selection')
        diagnostics.event('selection-write-failed', { message: error.message })
        sendJson(res, { ok: false, error: error.message, boundary: error.boundary }, 500)
      }
    })
    req.on('error', () => {
      try {
        sendJson(res, { ok: false, error: 'request error' }, 400)
      } catch {
        /* socket already gone */
      }
    })
  }

  /**
   * `POST /delete` — delete user clips AND the files they were discovered from.
   *
   * Only clips the listing marked `writable` can be deleted (never embedded
   * ones), and only when the real file lives inside one of the managed folders.
   * A batch is best-effort: per-id failures are reported instead of aborting the
   * whole request. References to deleted clips are cleaned up so no setting keeps
   * pointing at a file that no longer exists.
   */
  const handleDelete = (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: 'POST required' }, 405)
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, { ok: false, error: 'invalid JSON body' }, 400)
        return
      }
      const requested = parsed !== null && typeof parsed === 'object' ? parsed.clipIds : undefined
      if (!Array.isArray(requested) || requested.length === 0) {
        sendJson(res, { ok: false, error: 'clipIds must be a non-empty array' }, 400)
        return
      }
      if (requested.length > 200) {
        sendJson(res, { ok: false, error: 'at most 200 clips per request' }, 400)
        return
      }
      const writableDirs = scanDirs()
        .filter((entry) => entry.writable === true)
        .map((entry) => entry.dir)
      const deleted = []
      const failed = []
      const deletedIds = new Set()
      const seen = new Set()
      for (const raw of requested) {
        if (typeof raw !== 'string') {
          failed.push({ id: String(raw), error: 'clip id must be a string' })
          continue
        }
        const id = raw.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const clip = registry.get(id)
        if (clip === null || clip === undefined) {
          failed.push({ id, error: 'no such clip' })
          continue
        }
        if (clip.kind !== 'file' || clip.writable !== true) {
          failed.push({ id, error: 'not a deletable user clip' })
          continue
        }
        if (containedFilePath(clip.path, writableDirs) === null) {
          failed.push({ id, error: 'file is outside the managed folder' })
          continue
        }
        try {
          unlinkSync(clip.path)
          deleted.push({ id: clip.id, name: clip.name })
          deletedIds.add(clip.id)
        } catch (cause) {
          failed.push({ id, error: String(cause?.message ?? cause) })
        }
      }
      if (deletedIds.size === 0) {
        sendJson(res, { ok: false, error: 'nothing was deleted', deleted: [], failed }, 400)
        return
      }
      registry.invalidate()
      let clearedSelection = false
      try {
        const settings = selection.read()
        if (settings.selectedClipId !== null && deletedIds.has(settings.selectedClipId)) {
          selection.write({ selectedClipId: null })
          clearedSelection = true
        }
        for (const [session, clipId] of Object.entries(selection.read().conversationOverrides)) {
          if (!deletedIds.has(clipId)) continue
          try {
            selection.setConversationOverride(session, null)
          } catch {
            /* a stale pin is harmless: the resolver falls back to the selection */
          }
        }
      } catch (cause) {
        diagnostics.event('delete-cleanup-failed', {
          message: String(cause?.message ?? cause),
        })
      }
      diagnostics.event('clips-deleted', { deleted: deleted.map((entry) => entry.id), failed: failed.length })
      sendJson(res, {
        ok: true,
        deleted: deleted.map((entry) => entry.id),
        deletedNames: deleted.map((entry) => entry.name),
        failed,
        clearedSelection,
        selectedClipId: selection.read().selectedClipId,
        count: registry.list().length,
      })
    })
    req.on('error', () => {
      try {
        sendJson(res, { ok: false, error: 'request error' }, 400)
      } catch {
        /* socket already gone */
      }
    })
  }

  /** `GET /media/<clipId>` — the canonical resource. One clip, one identity. */
  const serveMedia = (req, res) => {
    const raw = typeof req.url === 'string' ? req.url : ''
    const path = raw.split('?')[0]
    let id = ''
    if (path.length > MEDIA_ROUTE.length + 1) {
      try {
        id = decodeURIComponent(path.slice(MEDIA_ROUTE.length + 1))
      } catch {
        sendText(res, 400, 'dsh-boot-animation: malformed clip id')
        return
      }
    }
    // A clip id never contains a path separator; refusing one keeps a decoded
    // traversal attempt away from the registry and the resolver entirely.
    if (id.includes('/') || id.includes('\\')) {
      sendText(res, 400, 'dsh-boot-animation: malformed clip id')
      return
    }
    const clip = id === '' ? null : resolver.resolve(id)?.clip ?? null
    if (clip === null) {
      sendText(res, 404, 'dsh-boot-animation: no such clip id')
      return
    }
    void media.serve(req, res, clip)
  }

  /**
   * `GET /boot.mp4` — backward compatibility ONLY.
   *
   * It redirects to the canonical per-clip URL instead of serving bytes under a
   * shared name. That is what removes the stale-cache hazard for any client that
   * still asks for it: the bytes always come from a URL that identifies one clip.
   */
  const serveBoot = (req, res) => {
    try {
      const { clip } = resolver.resolveActive(sessionOf(req))
      if (clip === null) {
        sendText(
          res,
          404,
          'dsh-boot-animation: no clip found (drop an .mp4 into ' +
            '%DSH_HOME%/boot-animation/videos' +
            ', set DSH_BOOT_ANIMATION, or add $DSH_HOME/boot-animation/intro.mp4)',
        )
        return
      }
      const version = clip.version()
      const location =
        `${MEDIA_ROUTE}/${encodeURIComponent(clip.id)}` + (version === null ? '' : `?v=${encodeURIComponent(version)}`)
      diagnostics.event('legacy-redirect', { id: clip.id })
      res.writeHead(302, { location, 'cache-control': 'no-store' })
      res.end()
    } catch (cause) {
      const error = asBootAnimationError(cause, 'plugin', 'redirecting the legacy route')
      diagnostics.event('legacy-route-error', { message: error.message })
      sendText(res, 500, 'dsh-boot-animation: could not resolve a clip')
    }
  }

  // A failure while REGISTERING is the plugin boundary: report it and stop,
  // never let it escape into the host boot.
  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: MEDIA_ROUTE, handler: localOnly(serveMedia) }),
      'dsh-boot-animation: clip media',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: localOnly(serveBoot) }),
      'dsh-boot-animation: legacy boot url',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: RESOLVE_ROUTE, handler: localOnly(serveResolve) }),
      'dsh-boot-animation: resolve',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: LIST_ROUTE, handler: localOnly(serveList) }),
      'dsh-boot-animation: library',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: SELECT_ROUTE, handler: localOnly(handleSelect) }),
      'dsh-boot-animation: select',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: STATUS_ROUTE, handler: localOnly(serveStatus) }),
      'dsh-boot-animation: status',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: DELETE_ROUTE, handler: localOnly(handleDelete) }),
      'dsh-boot-animation: delete clips',
    )
  } catch (cause) {
    const error = cause instanceof PluginError ? cause : new PluginError(`route registration failed: ${String(cause)}`)
    diagnostics.event('plugin-failed', { message: error.message })
    throw error
  }
}
