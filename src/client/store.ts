/**
 * ClientStore — the client's ONE source of truth.
 *
 * The 0.2.x client kept this state in four unrelated places: a module-level
 * `activeVersion` fetched once per page, a `src` frozen with `useState` at
 * overlay mount, the library's own local list, and a `fit` value that lived only
 * in localStorage. Nothing could answer "which clip is playing right now", which
 * is why selecting B could keep playing A until a reload.
 *
 * Here every one of those is one field on one object, and the three clip
 * identities are deliberately NOT the same field:
 *
 *   settings.selectedClipId      what the user chose; changes ONLY on select()
 *   conversationClipId           the pin THIS conversation carries, if any. It
 *                                outranks the global choice on the host and is
 *                                never written into selectedClipId — the two are
 *                                different questions ("what do I usually want"
 *                                vs "what does this one conversation want").
 *   playback.clipId              what the <video> element is being pointed at
 *   playback.previewClipId       what the last preview asked for (may equal
 *                                neither of the others, and never persists)
 *
 * A mutation replaces the snapshot object, so `useSyncExternalStore` sees a new
 * reference exactly when something changed — and never otherwise.
 *
 * `playback.nonce` increments on every play request. Without it, asking to play
 * the same clip twice would be a no-op for React (same clipId, same url), and a
 * replay button that does nothing is the bug this guards against.
 */
import { useSyncExternalStore } from 'react'
import { log, notify } from './diagnostics.js'

export type FitMode = 'cover' | 'contain'
export type PlaybackPhase = 'idle' | 'loading' | 'playing' | 'stalled' | 'error'

/** One clip as the host lists it. */
export type ClipInfo = {
  id: string
  name: string
  file: string | null
  ext: string
  source: string
  kind?: string
  writable?: boolean
  embedded?: string | null
  bytes: number
  mtime?: string | null
  legacy?: boolean
  faststart?: boolean
  version?: string | null
  mediaUrl?: string
  copies?: number
  alsoAt?: string[]
  active?: boolean
  selected?: boolean
}

export type Catalog = {
  clips: ClipInfo[]
  userDir: string
  accepts: string[]
}

export type Settings = {
  selectedClipId: string | null
  randomPlayback: boolean
  fitMode: FitMode
  /**
   * Which auto-play rule the client obeys (0.4.2).
   *
   *   true   the intro plays once per DSH launch, in whatever conversation the
   *          app opens first (the "boot animation" reading)
   *   false  the original rule: once per NEW conversation, recorded per session
   *
   * Host-owned, not localStorage: a DSH port change would otherwise drop it.
   * A pinned conversation replays on every entry regardless of this setting.
   */
  playOnAppStart: boolean
  /** Optional welcome layer (this fork). All host-owned. */
  loginOverlay: boolean
  welcomeTitle: string
  welcomeName: string
  welcomeSubtitle: string
  welcomeHint: string
}

/** Host defaults for the login layer, mirrored for the pre-payload state. */
export const DEFAULT_LOGIN = {
  loginOverlay: false,
  welcomeTitle: '欢迎回来，',
  welcomeName: '管理员',
  welcomeSubtitle: 'WELCOME BACK, ADMINISTRATOR',
  welcomeHint: '点击任意处进入',
} as const

/** The host's default, mirrored so the pre-payload state equals "not loaded yet". */
export const DEFAULT_PLAY_ON_APP_START = true

/**
 * How long the client waits for the host's settings before deciding anyway (0.4.3).
 *
 * `settingsLoaded` is a HARD gate on the when-to-play rule: no payload, no
 * decision. That is right for the normal case (the payload arrives in
 * milliseconds) and wrong for a host whose `/videos.json` never answers — then
 * the gate does not protect the user's choice, it just means "no intro, silently,
 * for the rest of this launch". After this long the client decides with whatever
 * it already has and says so in the diagnostic log.
 */
export const SETTINGS_FALLBACK_MS = 8000

/**
 * Backoff for a failed `/videos.json` read: three attempts, ~1.6s of total wait.
 *
 * Long enough to ride out a route that is registered a beat after the bundle
 * runs, short enough that a genuinely broken host still fails visibly instead of
 * hanging in `loading` forever.
 */
const CATALOG_RETRY_DELAYS_MS = [400, 1200]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type Playback = {
  clipId: string | null
  previewClipId: string | null
  url: string | null
  phase: PlaybackPhase
  reason: string
  nonce: number
  message: string
}

export type Snapshot = {
  catalog: Catalog | null
  settings: Settings
  /**
   * Has a host payload actually answered with settings?
   *
   * The when-to-play decision waits for this instead of assuming a default. The
   * setting is the HOST's; a client that guessed "not loaded, so play" would play
   * against a user who turned the toggle off, and one that guessed "play once per
   * launch" would do the same. Until the answer arrives there is no decision to
   * make.
   */
  settingsLoaded: boolean
  playback: Playback
  /** Which conversation the client is in, as far as the host told us. */
  sessionId: string | null
  /**
   * The clip pinned to THIS conversation, or null.
   *
   * A separate field from `settings.selectedClipId` on purpose: the per
   * conversation pin sits ON TOP of the global choice and must never be confused
   * with it — the same reason the host keeps two fields.
   */
  conversationClipId: string | null
  loading: boolean
  busy: boolean
  status: { text: string; kind: string }
}

const BASE = '/dsh-boot-animation'
const LIST_URL = `${BASE}/videos.json`
const SELECT_URL = `${BASE}/select`
const DELETE_URL = `${BASE}/delete`
const RESOLVE_URL = `${BASE}/resolve.json`

const EMPTY_SETTINGS: Settings = {
  selectedClipId: null,
  randomPlayback: false,
  fitMode: 'cover',
  playOnAppStart: DEFAULT_PLAY_ON_APP_START,
  ...DEFAULT_LOGIN,
}

const IDLE_PLAYBACK: Playback = {
  clipId: null,
  previewClipId: null,
  url: null,
  phase: 'idle',
  reason: 'none',
  nonce: 0,
  message: '',
}

/**
 * The media URL for one clip.
 *
 * Addressed by ClipId, with the clip's own content identity pinned as `?v=`.
 * That is what makes "select A, then B, then C" deterministic without a reload:
 * every clip is a different resource, so nothing can be served from the previous
 * clip's cache entry, and a pinned URL is immutable because it cannot go stale.
 */
export function mediaUrlFor(clip: ClipInfo): string {
  const path = clip.mediaUrl ?? `${BASE}/media/${encodeURIComponent(clip.id)}`
  const version = clip.version
  return typeof version === 'string' && version !== '' ? `${path}?v=${encodeURIComponent(version)}` : path
}

export class ClientStore {
  #snapshot: Snapshot = {
    catalog: null,
    settings: EMPTY_SETTINGS,
    settingsLoaded: false,
    playback: IDLE_PLAYBACK,
    sessionId: null,
    conversationClipId: null,
    loading: false,
    busy: false,
    status: { text: '', kind: '' },
  }

  #listeners = new Set<() => void>()

  /** Set once the client stopped waiting for the host's settings (0.4.3). */
  #fallbackDecided = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): Snapshot => this.#snapshot

  #set(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        /* one broken subscriber must not stop the others */
      }
    }
  }

  /**
   * Which conversation the client is in.
   *
   * Every per-conversation question is answered by the HOST; the client only
   * carries the identity. That is what keeps one implementation of the priority
   * chain, and it is why this is set once per session change rather than being
   * threaded through every call site.
   *
   * Does not fetch: the caller re-reads the catalog (which is where the pin
   * arrives from the host) when the conversation changes.
   */
  setSession(sessionId: string | null): void {
    if (this.#snapshot.sessionId === sessionId) return
    this.#set({ sessionId })
  }

  /** `session=<id>` for a host call, or '' when no conversation is open yet. */
  #sessionParam(): string {
    const id = this.#snapshot.sessionId
    return id === null || id === '' ? '' : 'session=' + encodeURIComponent(id)
  }

  #listUrl(): string {
    const param = this.#sessionParam()
    return param === '' ? LIST_URL : LIST_URL + '?' + param
  }

  /**
   * Read the library and the settings from the host, with a bounded retry.
   *
   * Safe to call repeatedly. The retry exists because ONE failed read used to cost
   * the whole launch: `settingsLoaded` stayed false, `decidePlay` refuses to decide
   * without it, and the user just got no intro — silently. First paint races the
   * plugin's own routes, so a single early 502 is not a reason to lose the
   * animation until the next restart.
   */
  async loadCatalog(): Promise<void> {
    this.#set({ loading: true })
    let lastError: unknown = null
    for (let attempt = 0; attempt <= CATALOG_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(CATALOG_RETRY_DELAYS_MS[attempt - 1] ?? 1000)
      try {
        const response = await fetch(this.#listUrl(), { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const data = (await response.json()) as {
          videos?: ClipInfo[]
          userDir?: string
          accepts?: string[]
          selectedClipId?: string | null
          randomPlayback?: boolean
          fitMode?: FitMode
          playOnAppStart?: boolean
          loginOverlay?: boolean
          welcomeTitle?: string
          welcomeName?: string
          welcomeSubtitle?: string
          welcomeHint?: string
          conversationClipId?: string | null
        }
        this.#set({
          catalog: {
            clips: Array.isArray(data.videos) ? data.videos : [],
            userDir: typeof data.userDir === 'string' ? data.userDir : '',
            accepts: Array.isArray(data.accepts) ? data.accepts : [],
          },
          settings: {
            selectedClipId: typeof data.selectedClipId === 'string' ? data.selectedClipId : null,
            randomPlayback: data.randomPlayback === true,
            fitMode: data.fitMode === 'contain' ? 'contain' : 'cover',
            /**
             * A host that predates 0.4.2 does not send this field. Its behaviour
             * WAS "play once per new conversation", so an old host reads as `false`
             * — the older rule — rather than being handed the new one it does not
             * know about. A 0.4.2+ host always sends an explicit boolean.
             */
            playOnAppStart:
              data.playOnAppStart === undefined ? false : data.playOnAppStart === true,
            loginOverlay:
              data.loginOverlay === undefined ? DEFAULT_LOGIN.loginOverlay : data.loginOverlay === true,
            welcomeTitle:
              typeof data.welcomeTitle === 'string' ? data.welcomeTitle : DEFAULT_LOGIN.welcomeTitle,
            welcomeName:
              typeof data.welcomeName === 'string' ? data.welcomeName : DEFAULT_LOGIN.welcomeName,
            welcomeSubtitle:
              typeof data.welcomeSubtitle === 'string'
                ? data.welcomeSubtitle
                : DEFAULT_LOGIN.welcomeSubtitle,
            welcomeHint:
              typeof data.welcomeHint === 'string' ? data.welcomeHint : DEFAULT_LOGIN.welcomeHint,
          },
          settingsLoaded: true,
          conversationClipId: typeof data.conversationClipId === 'string' ? data.conversationClipId : null,
          loading: false,
          status: { text: '', kind: '' },
        })
        log('catalog loaded', {
          clips: data.videos?.length ?? 0,
          conversationClipId: data.conversationClipId ?? null,
          attempt,
        })
        return
      } catch (error) {
        lastError = error
      }
    }
    notify('catalog load failed', String(lastError))
    // `settingsLoaded` stays false: the host never answered. AppRoot then waits at
    // most `SETTINGS_FALLBACK_MS` before calling `markSettingsFallback()`, so a
    // broken route degrades to "plays with defaults" instead of "never plays".
    this.#set({ loading: false, status: { text: '读取片库失败：' + String(lastError), kind: 'dba-err' } })
  }

  /**
   * Decide with what we have, because the host is not going to answer (0.4.3).
   *
   * Called on a timer by AppRoot while `settingsLoaded` is still false. Keeps the
   * current settings (the host's defaults) rather than inventing a rule, flips the
   * gate, and leaves one line in the diagnostic log. Idempotent, and a no-op when
   * the payload did arrive or the fallback already ran.
   */
  markSettingsFallback(why: string): void {
    if (this.#snapshot.settingsLoaded || this.#fallbackDecided) return
    this.#fallbackDecided = true
    notify('settings never arrived — deciding with defaults', { why })
    this.#set({ settingsLoaded: true, loading: false })
  }

  /** True once the client stopped waiting for the host's settings payload. */
  get usedSettingsFallback(): boolean {
    return this.#fallbackDecided
  }

  /** Everything that reaches the host's selection endpoint goes through here. */
  async #writeSettings(patch: Record<string, unknown>, okText: string): Promise<boolean> {
    this.#set({ busy: true })
    try {
      const response = await fetch(SELECT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await response.json()) as {
        ok?: boolean
        error?: string
        selectedClipId?: string | null
        randomPlayback?: boolean
        fitMode?: FitMode
        playOnAppStart?: boolean
        loginOverlay?: boolean
        welcomeTitle?: string
        welcomeName?: string
        welcomeSubtitle?: string
        welcomeHint?: string
        conversationClipId?: string | null
      }
      if (data.ok !== true) {
        this.#set({ busy: false, status: { text: '保存失败：' + String(data.error ?? '未知错误'), kind: 'dba-err' } })
        return false
      }
      const previous = this.#snapshot
      this.#set({
        busy: false,
        /**
         * Only the fields the host actually ANSWERED with.
         *
         * A `scope=conversation` write answers with the pin and nothing else, so
         * a blanket assignment here would blank the global settings every time a
         * user pinned one conversation. The catalog reload below is what makes
         * the final state authoritative.
         */
        settings: {
          selectedClipId:
            data.selectedClipId === undefined
              ? previous.settings.selectedClipId
              : typeof data.selectedClipId === 'string'
                ? data.selectedClipId
                : null,
          randomPlayback:
            data.randomPlayback === undefined ? previous.settings.randomPlayback : data.randomPlayback === true,
          fitMode:
            data.fitMode === undefined
              ? previous.settings.fitMode
              : data.fitMode === 'contain'
                ? 'contain'
                : 'cover',
          playOnAppStart:
            data.playOnAppStart === undefined
              ? previous.settings.playOnAppStart
              : data.playOnAppStart === true,
          loginOverlay:
            data.loginOverlay === undefined ? previous.settings.loginOverlay : data.loginOverlay === true,
          welcomeTitle:
            typeof data.welcomeTitle === 'string' ? data.welcomeTitle : previous.settings.welcomeTitle,
          welcomeName:
            typeof data.welcomeName === 'string' ? data.welcomeName : previous.settings.welcomeName,
          welcomeSubtitle:
            typeof data.welcomeSubtitle === 'string'
              ? data.welcomeSubtitle
              : previous.settings.welcomeSubtitle,
          welcomeHint:
            typeof data.welcomeHint === 'string' ? data.welcomeHint : previous.settings.welcomeHint,
        },
        conversationClipId:
          data.conversationClipId === undefined
            ? previous.conversationClipId
            : typeof data.conversationClipId === 'string'
              ? data.conversationClipId
              : null,
        status: { text: okText, kind: 'dba-ok' },
      })
      await this.loadCatalog()
      return true
    } catch (error) {
      this.#set({ busy: false, status: { text: '保存失败：' + String(error), kind: 'dba-err' } })
      return false
    }
  }

  /**
   * Choose a clip. The ONLY method that changes `settings.selectedClipId`.
   *
   * Preview deliberately does not call this: previewing a clip you have not
   * chosen must never silently become your choice.
   */
  async selectClip(clipId: string): Promise<boolean> {
    const clip = this.clip(clipId)
    const ok = await this.#writeSettings({ selectedClipId: clipId }, `已选为片头：${clip?.name ?? clipId}`)
    return ok
  }

  async setRandomPlayback(on: boolean): Promise<boolean> {
    return this.#writeSettings({ randomPlayback: on }, on ? '已开启随机播放' : '已关闭随机播放')
  }

  /**
   * Delete user clips AND their files, in one batch.
   *
   * The host decides what is deletable (only writable user clips inside the
   * managed folder); this method only moves the request and reports the result.
   * Playback pointing at a deleted clip is stopped before the catalog reloads.
   */
  async deleteClips(clipIds: string[]): Promise<{ deleted: number; failed: number } | null> {
    if (clipIds.length === 0) return null
    this.#set({ busy: true })
    try {
      const response = await fetch(DELETE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clipIds }),
      })
      const data = (await response.json()) as {
        ok?: boolean
        error?: string
        deleted?: string[]
        failed?: Array<{ id: string; error: string }>
      }
      const deleted = data.deleted ?? []
      if (this.#snapshot.playback.clipId !== null && deleted.includes(this.#snapshot.playback.clipId)) {
        this.#set({ playback: IDLE_PLAYBACK })
      }
      await this.loadCatalog()
      const failed = data.failed ?? []
      if (data.ok !== true) {
        this.#set({
          busy: false,
          status: { text: '删除失败：' + String(data.error ?? '未知错误'), kind: 'dba-err' },
        })
        return null
      }
      this.#set({
        busy: false,
        status: {
          text:
            `已删除 ${String(deleted.length)} 个视频文件` +
            (failed.length === 0 ? '' : `，${String(failed.length)} 个失败`),
          kind: failed.length === 0 ? 'dba-ok' : 'dba-err',
        },
      })
      return { deleted: deleted.length, failed: failed.length }
    } catch (error) {
      this.#set({ busy: false, status: { text: '删除失败：' + String(error), kind: 'dba-err' } })
      return null
    }
  }

  /**
   * Switch the auto-play rule: once per DSH launch, or once per new conversation.
   *
   * Written to the HOST (`playOnAppStart` in selection.json), not localStorage,
   * so the choice survives a port change and is the same one the decision effect
   * reads back. The host answers with the stored value, which is what the UI
   * shows — the client never keeps its own idea of this setting.
   */
  async setPlayOnAppStart(on: boolean): Promise<boolean> {
    return this.#writeSettings(
      { playOnAppStart: on },
      on ? '已开启：每次启动 DSH 播一次' : '已关闭：只在新建会话时播一次',
    )
  }

  /** Turn the optional welcome layer on or off (off = the plain full-screen clip). */
  async setLoginOverlay(on: boolean): Promise<boolean> {
    return this.#writeSettings(
      { loginOverlay: on },
      on ? '已开启：显示「欢迎回来」登录界面' : '已关闭：只播全屏片头视频',
    )
  }

  /** Save one configurable login-layer string. */
  async setLoginText(
    field: 'welcomeTitle' | 'welcomeName' | 'welcomeSubtitle' | 'welcomeHint',
    value: string,
  ): Promise<boolean> {
    const labels: Record<typeof field, string> = {
      welcomeTitle: '欢迎语',
      welcomeName: '称呼',
      welcomeSubtitle: '英文副标题',
      welcomeHint: '底部提示',
    }
    const trimmed = value.trim()
    if (trimmed === '') {
      this.#set({ status: { text: `${labels[field]}不能为空`, kind: 'dba-err' } })
      return false
    }
    return this.#writeSettings({ [field]: trimmed }, `${labels[field]}已保存`)
  }

  /**
   * Pin THIS conversation to a clip, or clear its pin with `null`.
   *
   * Deliberately not `selectClip`: a per-conversation pin sits ON TOP of the
   * global choice, so writing it must not overwrite that choice. That separation
   * is the entire point of the layer, and it is why the host keeps the two in
   * different fields.
   */
  async setConversationClip(clipId: string | null): Promise<boolean> {
    const sessionId = this.#snapshot.sessionId
    if (sessionId === null) {
      this.#set({ status: { text: '还没有打开的会话：先打开一个对话，才能只对它生效', kind: 'dba-err' } })
      return false
    }
    const clip = clipId === null ? null : this.clip(clipId)
    const okText = clipId === null ? '已取消本会话的固定片头' : '本会话固定播放：' + (clip?.name ?? clipId)
    return this.#writeSettings({ scope: 'conversation', sessionId, id: clipId }, okText)
  }

  async setFitMode(mode: FitMode): Promise<boolean> {
    return this.#writeSettings({ fitMode: mode }, mode === 'cover' ? '已设为「铺满屏幕」' : '已设为「完整显示」')
  }

  /** One clip from the loaded catalog. */
  clip(clipId: string): ClipInfo | null {
    const catalog = this.#snapshot.catalog
    if (catalog === null) return null
    return catalog.clips.find((item) => item.id === clipId) ?? null
  }

  setStatus(text: string, kind: string): void {
    this.#set({ status: { text, kind } })
  }

  /**
   * Point the player at one clip. THE playback entry point.
   *
   * `reason` is recorded so diagnostics can say why this clip is playing
   * ('preview', 'new-conversation', 'pinned', 'random', 'manual'), and every
   * caller — preview, new conversation, pinned session, random — arrives here.
   */
  playClip(clipId: string, reason: string): boolean {
    const clip = this.clip(clipId)
    if (clip === null) {
      notify('play requested for an unknown clip', { clipId, reason })
      return false
    }
    const playback = this.#snapshot.playback
    this.#set({
      playback: {
        ...playback,
        clipId,
        url: mediaUrlFor(clip),
        phase: 'loading',
        reason,
        nonce: playback.nonce + 1,
        message: '',
      },
    })
    notify('play', { clipId, reason, url: mediaUrlFor(clip) })
    return true
  }

  /**
   * Ask the host which clip should play in a given mode, then play it.
   *
   * The client never decides this itself: `selected`, `active` (which honours
   * random playback) and `random` are all answered by the host's ClipResolver, so
   * there is exactly one implementation of the priority chain and one of the
   * "do not repeat" rule. If the host cannot be reached, this degrades to
   * whatever the catalog already knows rather than failing the overlay.
   */
  async playMode(mode: 'active' | 'random' | 'selected', reason: string): Promise<boolean> {
    try {
      // The conversation travels with every resolve: whether THIS conversation
      // has its own pin is a host decision, not a client one.
      const param = this.#sessionParam()
      const response = await fetch(`${RESOLVE_URL}?mode=${mode}${param === '' ? '' : '&' + param}`, { cache: 'no-store' })
      if (response.ok) {
        const data = (await response.json()) as { clipId?: string | null; how?: string }
        if (typeof data.clipId === 'string' && data.clipId !== '') {
          return this.playClip(data.clipId, data.how ?? reason)
        }
      }
      notify('resolve fell back to the catalog', { mode })
    } catch (error) {
      notify('resolve failed', String(error))
    }
    const settings = this.#snapshot.settings
    if (settings.randomPlayback) {
      const pool = this.#snapshot.catalog?.clips ?? []
      if (pool.length > 0) return this.playClip(pool[0].id, 'fallback')
      return false
    }
    if (settings.selectedClipId !== null) return this.playClip(settings.selectedClipId, 'fallback')
    return false
  }

  /**
   * Preview one specific clip.
   *
   * Records `previewClipId` so the UI can mark what is being auditioned, and
   * plays it — without touching the selection. Previewing B while A is selected
   * must show B and leave A selected.
   */
  preview(clipId: string, reason = 'preview'): boolean {
    const played = this.playClip(clipId, reason)
    if (played) {
      this.#set({ playback: { ...this.#snapshot.playback, previewClipId: clipId } })
    }
    return played
  }

  /** Report the phase the <video> element reached. */
  setPhase(phase: PlaybackPhase, message = ''): void {
    if (this.#snapshot.playback.phase === phase && this.#snapshot.playback.message === message) return
    this.#set({ playback: { ...this.#snapshot.playback, phase, message } })
  }

  /** Stop playback (overlay closed, ended, or skipped). */
  stop(): void {
    const playback = this.#snapshot.playback
    if (playback.phase === 'idle' && playback.clipId === null) return
    this.#set({ playback: { ...playback, phase: 'idle', clipId: null, url: null, message: '' } })
  }
}

/** The store as React sees it, without the 1005-line component that used to own it. */
export function useClientStore(store: ClientStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
