window.__ModuleLoader__.load({
	id: "dsh-boot-animation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/diagnostics.ts
		/** Bounded, so a retry loop in a render cannot fill the console. */
		const MAX_ENTRIES = 200;
		const entries = [];
		function formatArgs(args) {
			return args.map((a) => {
				if (typeof a === "object" && a !== null) try {
					return JSON.stringify(a);
				} catch {
					return String(a);
				}
				return String(a);
			}).join(" ");
		}
		function narrate(text) {
			try {
				console.log("[dsh-boot-animation] " + text);
			} catch {}
		}
		/** Record one always-on line. Never throws. */
		function notify(...args) {
			const text = formatArgs(args);
			try {
				entries.push(text);
				while (entries.length > MAX_ENTRIES) entries.shift();
			} catch {}
			narrate(text);
		}
		//#endregion
		//#region src/client/store.ts
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
		/** Host defaults for the login layer, mirrored for the pre-payload state. */
		const DEFAULT_LOGIN = {
			loginOverlay: false,
			welcomeTitle: "欢迎回来，",
			welcomeName: "管理员",
			welcomeSubtitle: "WELCOME BACK, ADMINISTRATOR",
			welcomeHint: "点击任意处进入"
		};
		/** The host's default, mirrored so the pre-payload state equals "not loaded yet". */
		const DEFAULT_PLAY_ON_APP_START = true;
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
		const SETTINGS_FALLBACK_MS = 8e3;
		/**
		* Backoff for a failed `/videos.json` read: three attempts, ~1.6s of total wait.
		*
		* Long enough to ride out a route that is registered a beat after the bundle
		* runs, short enough that a genuinely broken host still fails visibly instead of
		* hanging in `loading` forever.
		*/
		const CATALOG_RETRY_DELAYS_MS = [400, 1200];
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const BASE = "/dsh-boot-animation";
		const LIST_URL = `${BASE}/videos.json`;
		const SELECT_URL = `${BASE}/select`;
		const DELETE_URL = `${BASE}/delete`;
		const RESOLVE_URL = `${BASE}/resolve.json`;
		const EMPTY_SETTINGS = {
			selectedClipId: null,
			randomPlayback: false,
			fitMode: "cover",
			playOnAppStart: true,
			...DEFAULT_LOGIN
		};
		const IDLE_PLAYBACK = {
			clipId: null,
			previewClipId: null,
			url: null,
			phase: "idle",
			reason: "none",
			nonce: 0,
			message: ""
		};
		/**
		* The media URL for one clip.
		*
		* Addressed by ClipId, with the clip's own content identity pinned as `?v=`.
		* That is what makes "select A, then B, then C" deterministic without a reload:
		* every clip is a different resource, so nothing can be served from the previous
		* clip's cache entry, and a pinned URL is immutable because it cannot go stale.
		*/
		function mediaUrlFor(clip) {
			const path = clip.mediaUrl ?? `${BASE}/media/${encodeURIComponent(clip.id)}`;
			const version = clip.version;
			return typeof version === "string" && version !== "" ? `${path}?v=${encodeURIComponent(version)}` : path;
		}
		var ClientStore = class {
			#snapshot = {
				catalog: null,
				settings: EMPTY_SETTINGS,
				settingsLoaded: false,
				playback: IDLE_PLAYBACK,
				sessionId: null,
				conversationClipId: null,
				loading: false,
				busy: false,
				status: {
					text: "",
					kind: ""
				}
			};
			#listeners = /* @__PURE__ */ new Set();
			/** Set once the client stopped waiting for the host's settings (0.4.3). */
			#fallbackDecided = false;
			subscribe = (listener) => {
				this.#listeners.add(listener);
				return () => {
					this.#listeners.delete(listener);
				};
			};
			getSnapshot = () => this.#snapshot;
			#set(patch) {
				this.#snapshot = {
					...this.#snapshot,
					...patch
				};
				for (const listener of this.#listeners) try {
					listener();
				} catch {}
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
			setSession(sessionId) {
				if (this.#snapshot.sessionId === sessionId) return;
				this.#set({ sessionId });
			}
			/** `session=<id>` for a host call, or '' when no conversation is open yet. */
			#sessionParam() {
				const id = this.#snapshot.sessionId;
				return id === null || id === "" ? "" : "session=" + encodeURIComponent(id);
			}
			#listUrl() {
				const param = this.#sessionParam();
				return param === "" ? LIST_URL : LIST_URL + "?" + param;
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
			async loadCatalog() {
				this.#set({ loading: true });
				let lastError = null;
				for (let attempt = 0; attempt <= CATALOG_RETRY_DELAYS_MS.length; attempt++) {
					if (attempt > 0) await sleep(CATALOG_RETRY_DELAYS_MS[attempt - 1] ?? 1e3);
					try {
						const response = await fetch(this.#listUrl(), { cache: "no-store" });
						if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
						const data = await response.json();
						this.#set({
							catalog: {
								clips: Array.isArray(data.videos) ? data.videos : [],
								userDir: typeof data.userDir === "string" ? data.userDir : "",
								accepts: Array.isArray(data.accepts) ? data.accepts : []
							},
							settings: {
								selectedClipId: typeof data.selectedClipId === "string" ? data.selectedClipId : null,
								randomPlayback: data.randomPlayback === true,
								fitMode: data.fitMode === "contain" ? "contain" : "cover",
								/**
								* A host that predates 0.4.2 does not send this field. Its behaviour
								* WAS "play once per new conversation", so an old host reads as `false`
								* — the older rule — rather than being handed the new one it does not
								* know about. A 0.4.2+ host always sends an explicit boolean.
								*/
								playOnAppStart: data.playOnAppStart === void 0 ? false : data.playOnAppStart === true,
								loginOverlay: data.loginOverlay === void 0 ? DEFAULT_LOGIN.loginOverlay : data.loginOverlay === true,
								welcomeTitle: typeof data.welcomeTitle === "string" ? data.welcomeTitle : DEFAULT_LOGIN.welcomeTitle,
								welcomeName: typeof data.welcomeName === "string" ? data.welcomeName : DEFAULT_LOGIN.welcomeName,
								welcomeSubtitle: typeof data.welcomeSubtitle === "string" ? data.welcomeSubtitle : DEFAULT_LOGIN.welcomeSubtitle,
								welcomeHint: typeof data.welcomeHint === "string" ? data.welcomeHint : DEFAULT_LOGIN.welcomeHint
							},
							settingsLoaded: true,
							conversationClipId: typeof data.conversationClipId === "string" ? data.conversationClipId : null,
							loading: false,
							status: {
								text: "",
								kind: ""
							}
						});
						data.videos?.length, data.conversationClipId;
						return;
					} catch (error) {
						lastError = error;
					}
				}
				notify("catalog load failed", String(lastError));
				this.#set({
					loading: false,
					status: {
						text: "读取片库失败：" + String(lastError),
						kind: "dba-err"
					}
				});
			}
			/**
			* Decide with what we have, because the host is not going to answer (0.4.3).
			*
			* Called on a timer by AppRoot while `settingsLoaded` is still false. Keeps the
			* current settings (the host's defaults) rather than inventing a rule, flips the
			* gate, and leaves one line in the diagnostic log. Idempotent, and a no-op when
			* the payload did arrive or the fallback already ran.
			*/
			markSettingsFallback(why) {
				if (this.#snapshot.settingsLoaded || this.#fallbackDecided) return;
				this.#fallbackDecided = true;
				notify("settings never arrived — deciding with defaults", { why });
				this.#set({
					settingsLoaded: true,
					loading: false
				});
			}
			/** True once the client stopped waiting for the host's settings payload. */
			get usedSettingsFallback() {
				return this.#fallbackDecided;
			}
			/** Everything that reaches the host's selection endpoint goes through here. */
			async #writeSettings(patch, okText) {
				this.#set({ busy: true });
				try {
					const data = await (await fetch(SELECT_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch)
					})).json();
					if (data.ok !== true) {
						this.#set({
							busy: false,
							status: {
								text: "保存失败：" + String(data.error ?? "未知错误"),
								kind: "dba-err"
							}
						});
						return false;
					}
					const previous = this.#snapshot;
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
							selectedClipId: data.selectedClipId === void 0 ? previous.settings.selectedClipId : typeof data.selectedClipId === "string" ? data.selectedClipId : null,
							randomPlayback: data.randomPlayback === void 0 ? previous.settings.randomPlayback : data.randomPlayback === true,
							fitMode: data.fitMode === void 0 ? previous.settings.fitMode : data.fitMode === "contain" ? "contain" : "cover",
							playOnAppStart: data.playOnAppStart === void 0 ? previous.settings.playOnAppStart : data.playOnAppStart === true,
							loginOverlay: data.loginOverlay === void 0 ? previous.settings.loginOverlay : data.loginOverlay === true,
							welcomeTitle: typeof data.welcomeTitle === "string" ? data.welcomeTitle : previous.settings.welcomeTitle,
							welcomeName: typeof data.welcomeName === "string" ? data.welcomeName : previous.settings.welcomeName,
							welcomeSubtitle: typeof data.welcomeSubtitle === "string" ? data.welcomeSubtitle : previous.settings.welcomeSubtitle,
							welcomeHint: typeof data.welcomeHint === "string" ? data.welcomeHint : previous.settings.welcomeHint
						},
						conversationClipId: data.conversationClipId === void 0 ? previous.conversationClipId : typeof data.conversationClipId === "string" ? data.conversationClipId : null,
						status: {
							text: okText,
							kind: "dba-ok"
						}
					});
					await this.loadCatalog();
					return true;
				} catch (error) {
					this.#set({
						busy: false,
						status: {
							text: "保存失败：" + String(error),
							kind: "dba-err"
						}
					});
					return false;
				}
			}
			/**
			* Choose a clip. The ONLY method that changes `settings.selectedClipId`.
			*
			* Preview deliberately does not call this: previewing a clip you have not
			* chosen must never silently become your choice.
			*/
			async selectClip(clipId) {
				const clip = this.clip(clipId);
				return await this.#writeSettings({ selectedClipId: clipId }, `已选为片头：${clip?.name ?? clipId}`);
			}
			async setRandomPlayback(on) {
				return this.#writeSettings({ randomPlayback: on }, on ? "已开启随机播放" : "已关闭随机播放");
			}
			/**
			* Delete user clips AND their files, in one batch.
			*
			* The host decides what is deletable (only writable user clips inside the
			* managed folder); this method only moves the request and reports the result.
			* Playback pointing at a deleted clip is stopped before the catalog reloads.
			*/
			async deleteClips(clipIds) {
				if (clipIds.length === 0) return null;
				this.#set({ busy: true });
				try {
					const data = await (await fetch(DELETE_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ clipIds })
					})).json();
					const deleted = data.deleted ?? [];
					if (this.#snapshot.playback.clipId !== null && deleted.includes(this.#snapshot.playback.clipId)) this.#set({ playback: IDLE_PLAYBACK });
					await this.loadCatalog();
					const failed = data.failed ?? [];
					if (data.ok !== true) {
						this.#set({
							busy: false,
							status: {
								text: "删除失败：" + String(data.error ?? "未知错误"),
								kind: "dba-err"
							}
						});
						return null;
					}
					this.#set({
						busy: false,
						status: {
							text: `已删除 ${String(deleted.length)} 个视频文件` + (failed.length === 0 ? "" : `，${String(failed.length)} 个失败`),
							kind: failed.length === 0 ? "dba-ok" : "dba-err"
						}
					});
					return {
						deleted: deleted.length,
						failed: failed.length
					};
				} catch (error) {
					this.#set({
						busy: false,
						status: {
							text: "删除失败：" + String(error),
							kind: "dba-err"
						}
					});
					return null;
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
			async setPlayOnAppStart(on) {
				return this.#writeSettings({ playOnAppStart: on }, on ? "已开启：每次启动 DSH 播一次" : "已关闭：只在新建会话时播一次");
			}
			/** Turn the optional welcome layer on or off (off = the plain full-screen clip). */
			async setLoginOverlay(on) {
				return this.#writeSettings({ loginOverlay: on }, on ? "已开启：显示「欢迎回来」登录界面" : "已关闭：只播全屏片头视频");
			}
			/** Save one configurable login-layer string. */
			async setLoginText(field, value) {
				const labels = {
					welcomeTitle: "欢迎语",
					welcomeName: "称呼",
					welcomeSubtitle: "英文副标题",
					welcomeHint: "底部提示"
				};
				const trimmed = value.trim();
				if (trimmed === "") {
					this.#set({ status: {
						text: `${labels[field]}不能为空`,
						kind: "dba-err"
					} });
					return false;
				}
				return this.#writeSettings({ [field]: trimmed }, `${labels[field]}已保存`);
			}
			/**
			* Pin THIS conversation to a clip, or clear its pin with `null`.
			*
			* Deliberately not `selectClip`: a per-conversation pin sits ON TOP of the
			* global choice, so writing it must not overwrite that choice. That separation
			* is the entire point of the layer, and it is why the host keeps the two in
			* different fields.
			*/
			async setConversationClip(clipId) {
				const sessionId = this.#snapshot.sessionId;
				if (sessionId === null) {
					this.#set({ status: {
						text: "还没有打开的会话：先打开一个对话，才能只对它生效",
						kind: "dba-err"
					} });
					return false;
				}
				const clip = clipId === null ? null : this.clip(clipId);
				const okText = clipId === null ? "已取消本会话的固定片头" : "本会话固定播放：" + (clip?.name ?? clipId);
				return this.#writeSettings({
					scope: "conversation",
					sessionId,
					id: clipId
				}, okText);
			}
			async setFitMode(mode) {
				return this.#writeSettings({ fitMode: mode }, mode === "cover" ? "已设为「铺满屏幕」" : "已设为「完整显示」");
			}
			/** One clip from the loaded catalog. */
			clip(clipId) {
				const catalog = this.#snapshot.catalog;
				if (catalog === null) return null;
				return catalog.clips.find((item) => item.id === clipId) ?? null;
			}
			setStatus(text, kind) {
				this.#set({ status: {
					text,
					kind
				} });
			}
			/**
			* Point the player at one clip. THE playback entry point.
			*
			* `reason` is recorded so diagnostics can say why this clip is playing
			* ('preview', 'new-conversation', 'pinned', 'random', 'manual'), and every
			* caller — preview, new conversation, pinned session, random — arrives here.
			*/
			playClip(clipId, reason) {
				const clip = this.clip(clipId);
				if (clip === null) {
					notify("play requested for an unknown clip", {
						clipId,
						reason
					});
					return false;
				}
				const playback = this.#snapshot.playback;
				this.#set({ playback: {
					...playback,
					clipId,
					url: mediaUrlFor(clip),
					phase: "loading",
					reason,
					nonce: playback.nonce + 1,
					message: ""
				} });
				notify("play", {
					clipId,
					reason,
					url: mediaUrlFor(clip)
				});
				return true;
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
			async playMode(mode, reason) {
				try {
					const param = this.#sessionParam();
					const response = await fetch(`${RESOLVE_URL}?mode=${mode}${param === "" ? "" : "&" + param}`, { cache: "no-store" });
					if (response.ok) {
						const data = await response.json();
						if (typeof data.clipId === "string" && data.clipId !== "") return this.playClip(data.clipId, data.how ?? reason);
					}
					notify("resolve fell back to the catalog", { mode });
				} catch (error) {
					notify("resolve failed", String(error));
				}
				const settings = this.#snapshot.settings;
				if (settings.randomPlayback) {
					const pool = this.#snapshot.catalog?.clips ?? [];
					if (pool.length > 0) return this.playClip(pool[0].id, "fallback");
					return false;
				}
				if (settings.selectedClipId !== null) return this.playClip(settings.selectedClipId, "fallback");
				return false;
			}
			/**
			* Preview one specific clip.
			*
			* Records `previewClipId` so the UI can mark what is being auditioned, and
			* plays it — without touching the selection. Previewing B while A is selected
			* must show B and leave A selected.
			*/
			preview(clipId, reason = "preview") {
				const played = this.playClip(clipId, reason);
				if (played) this.#set({ playback: {
					...this.#snapshot.playback,
					previewClipId: clipId
				} });
				return played;
			}
			/** Report the phase the <video> element reached. */
			setPhase(phase, message = "") {
				if (this.#snapshot.playback.phase === phase && this.#snapshot.playback.message === message) return;
				this.#set({ playback: {
					...this.#snapshot.playback,
					phase,
					message
				} });
			}
			/** Stop playback (overlay closed, ended, or skipped). */
			stop() {
				const playback = this.#snapshot.playback;
				if (playback.phase === "idle" && playback.clipId === null) return;
				this.#set({ playback: {
					...playback,
					phase: "idle",
					clipId: null,
					url: null,
					message: ""
				} });
			}
		};
		/** The store as React sees it, without the 1005-line component that used to own it. */
		function useClientStore(store) {
			return (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
		}
		//#endregion
		//#region src/client/session.ts
		/**
		* Session binding: which conversation is current, and whether it is new.
		*
		* Two pieces of hard-won knowledge live here and must not be lost:
		*
		* 1. `hooks.session` is a `SessionFace` — `ISession & ObservableSnapshot<SessionSnapshot>`
		*    (see `@deepseek-ai/dsh-api-session-controller`) — so "this conversation has
		*    no turns yet" is `getSnapshot().blank`. Before DSH 0.2.0 the flag was a
		*    `blankBit` field directly on the binding. Reading the field that is no
		*    longer there does not throw, it answers `undefined`, so the failure was
		*    silence: auto-play simply stopped happening. Both shapes are read, and the
		*    face is SUBSCRIBED to rather than sampled once, because the flag arrives on
		*    a nested snapshot that can settle after the binding changes.
		*
		* 2. The pin is per session, keyed by session id, and lives in localStorage.
		*    It is a client concern: the host never learns a session id from this
		*    plugin.
		*
		* 3. THE AUTO-PLAY RECORD IS BOOT-SCOPED, NOT SESSION-SCOPED (0.4.2). Up to
		*    0.4.1 the record was a per-session "already played" list in localStorage,
		*    so the intro ran exactly once per conversation and never again in it — the
		*    field report was "开了一次之后就再也没有见过" / "是个一次性的". A boot
		*    animation has to key off the APPLICATION LAUNCH, so the record now lives in
		*    sessionStorage (`dsh-boot-animation:boot`), which the browser scopes to one
		*    tab and drops when that tab closes. Opening DSH plays it once; the rest of
		*    that launch never replays it. The per-session list survives as the
		*    documented fallback path (`hasPlayed` / `markPlayed`), not as the rule.
		*
		* 4. Storage is never allowed to decide WHETHER the intro can play. Every read
		*    and write goes through `readStore`/`setItem`, which tolerate a Storage that
		*    is missing or throws (private mode, blocked third-party context, quota) and
		*    fall back to module-level memory flags. Without that fallback a blocked
		*    sessionStorage looks like "already played" forever, or like "not played
		*    yet" on every render — both are real risks now that the record decides
		*    playback.
		*/
		/**
		* True when the current conversation still has no turns, from whichever shape
		* the running host exposes.
		*
		* Exported so `scripts/verify-blank.mjs` can exercise THIS shipped function
		* rather than a copy of it. The bug it guards against is a silent one — a field
		* that moved answers `undefined` instead of throwing — so a test that only
		* checked "the bundle built" would not have caught it.
		*/
		function isBlankSession(session) {
			if (session === null || session === void 0) return false;
			if (typeof session.getSnapshot === "function") try {
				const snapshot = session.getSnapshot();
				if (snapshot !== null && typeof snapshot === "object" && "blank" in snapshot) return snapshot.blank === true;
			} catch {}
			return session.blankBit === true;
		}
		/**
		* Resolve the current Session identity across the host shapes this plugin supports.
		*
		* Ported from @windyduan's PR #2. Reading only `props.sessionId` does not throw on
		* a host that moved the identity — it answers `undefined`, so the per-session
		* "already played" record and the pin silently stopped matching. The modern
		* Session face carries `sessionId` in its snapshot; ui-session's current adapter
		* also publishes the same identity as `binding.key`; the old prop stays last as a
		* compatibility fallback.
		*
		* Exported so `scripts/verify-session-id.mjs` exercises THIS shipped function.
		*/
		function resolveSessionId(binding) {
			const session = binding?.hooks?.session;
			let snapshot = null;
			try {
				if (session !== void 0 && typeof session.getSnapshot === "function") snapshot = session.getSnapshot();
			} catch {}
			const candidate = (snapshot !== null && typeof snapshot === "object" && "sessionId" in snapshot ? snapshot.sessionId : void 0) ?? (typeof binding?.key === "string" ? binding.key : void 0) ?? (typeof binding?.props?.sessionId === "string" ? binding.props.sessionId : void 0);
			return typeof candidate === "string" && candidate !== "" ? candidate : null;
		}
		const noopSubscribe = () => () => {};
		/** Subscribe to the current-conversation store, tolerating its absence. */
		function useCurrentSession(store) {
			const binding = (0, react.useSyncExternalStore)(store === null ? noopSubscribe : store.subscribe, store === null ? () => null : store.getSnapshot);
			const session = binding?.hooks?.session;
			const subscribeBlank = (0, react.useCallback)((onChange) => {
				if (session === void 0 || typeof session.subscribe !== "function") return () => {};
				const stop = session.subscribe(onChange);
				return typeof stop === "function" ? stop : () => {};
			}, [session]);
			const isNewConversation = (0, react.useSyncExternalStore)(subscribeBlank, () => isBlankSession(session));
			return {
				sessionId: resolveSessionId(binding),
				isNewConversation
			};
		}
		const SEEN_KEY = "dsh-boot-animation:played";
		const PIN_KEY = "dsh-boot-animation:pinned";
		/** Boot scope: dropped by the browser when the tab (i.e. the DSH launch) closes. */
		const BOOT_KEY = "dsh-boot-animation:boot";
		/**
		* Written by the desktop shell's SEPARATE splash window (localStorage, because a
		* second window does not share sessionStorage). Consumed once on app mount.
		*/
		const DESKTOP_SPLASH_KEY = "dsh-boot-animation:desktop-splash";
		const MAX_SEEN = 80;
		/**
		* A Storage that may not exist and may throw on any call.
		*
		* `window.sessionStorage` can be *missing* (a host that stubs `window`, a
		* non-browser evaluation of the bundle) and the property access itself throws in
		* some sandboxed contexts, so it is always read through this call rather than at
		* module scope.
		*/
		function readStore(kind) {
			try {
				return (kind === "local" ? window.localStorage : window.sessionStorage) ?? null;
			} catch {
				return null;
			}
		}
		function getItem(kind, key) {
			try {
				const store = readStore(kind);
				return store === null ? null : store.getItem(key);
			} catch {
				return null;
			}
		}
		/** `false` when nothing could be written — the caller then keeps its memory flag. */
		function setItem(kind, key, value) {
			try {
				const store = readStore(kind);
				if (store === null) return false;
				store.setItem(key, value);
				return true;
			} catch {
				return false;
			}
		}
		function removeItem(kind, key) {
			try {
				const store = readStore(kind);
				if (store !== null) store.removeItem(key);
			} catch {}
		}
		/**
		* Memory fallbacks, used only when the real Storage cannot answer.
		*
		* A blocked Storage must not become "never plays" (if the record read back as
		* already-played) nor "plays on every render" (if the record never stuck). One
		* boolean is enough for the boot flag: it is one-way for the life of the tab.
		*/
		let bootPlayedInMemory = false;
		let seenInMemory = [];
		function readSeen() {
			const raw = getItem("local", SEEN_KEY);
			if (raw === null) return seenInMemory.slice();
			try {
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
			} catch {
				return [];
			}
		}
		/**
		* Has this conversation already had its intro?
		*
		* Since 0.4.2 the auto-play rule is boot-scoped and no longer asks this — it is
		* kept because it is the per-session memory `markPlayed` writes, and because
		* `scripts/verify-boot-scope.mjs` exercises both as the documented fallback.
		*/
		function hasPlayed(sessionId) {
			return readSeen().includes(sessionId);
		}
		function markPlayed(sessionId) {
			const seen = readSeen();
			if (!seen.includes(sessionId)) seen.push(sessionId);
			while (seen.length > MAX_SEEN) seen.shift();
			if (!setItem("local", SEEN_KEY, JSON.stringify(seen))) seenInMemory = seen;
		}
		/** Has the intro already played in THIS launch of the DSH GUI? */
		function hasBootPlayed() {
			const raw = getItem("session", BOOT_KEY);
			if (raw === null) return bootPlayedInMemory;
			return raw !== "" && raw !== "0";
		}
		/** Record that this launch has had its intro. Called BEFORE `playMode` plays. */
		function markBootPlayed() {
			bootPlayedInMemory = true;
			setItem("session", BOOT_KEY, String(Date.now()));
		}
		/** Forget the boot record — lets a test model a fresh application launch. */
		function clearBootPlayed() {
			bootPlayedInMemory = false;
			removeItem("session", BOOT_KEY);
		}
		/**
		* When the boot record was written, in epoch milliseconds.
		*
		* The desktop shell can show the clip itself while the harness boots, and it
		* writes the same launch record when it does; this reading lets the rule tell a
		* launch that already saw a clip from a later conversation entry.
		*/
		function readBootPlayedAt() {
			const raw = getItem("session", BOOT_KEY);
			if (raw === null || raw === "" || raw === "0") return null;
			const value = Number(raw);
			return Number.isFinite(value) && value > 0 ? value : null;
		}
		/** How long after a launch clip a replay still counts as that same launch. */
		const LAUNCH_GRACE_MS = 6e4;
		/**
		* When the DESKTOP splash window showed the clip in this launch, in ms.
		*
		* The splash is a separate window, so its sessionStorage is not this window's;
		* it records the launch in localStorage (shared per origin) instead.
		*/
		function readDesktopSplash() {
			const raw = getItem("local", DESKTOP_SPLASH_KEY);
			if (raw === null || raw === "") return null;
			const value = Number(raw);
			return Number.isFinite(value) && value > 0 ? value : null;
		}
		/** Remove the desktop splash record so it never suppresses a later launch. */
		function consumeDesktopSplash() {
			removeItem("local", DESKTOP_SPLASH_KEY);
		}
		function readPinned() {
			const value = getItem("local", PIN_KEY);
			return value === null || value === "" ? null : value;
		}
		function writePinned(sessionId) {
			if (sessionId === null) removeItem("local", PIN_KEY);
			else setItem("local", PIN_KEY, sessionId);
		}
		/**
		* THE when-to-play rule, as one pure function.
		*
		* Three outcomes, in priority order:
		*
		*   1. PINNED     the current conversation is the pinned one and we just entered
		*                 it -> replay. Unaffected by `playOnAppStart` and by any record.
		*   2. APP-START  `playOnAppStart` is on and this launch has not played yet ->
		*                 play once. **No conversation required** (0.4.3): the launch is
		*                 the scope, so a host that has not settled a binding yet, or a
		*                 launch that opens to the session list, still gets its intro.
		*   3. NEW CONV.  `playOnAppStart` is off -> the original rule: a conversation
		*                 with no turns yet that has not played before.
		*
		* The `settingsLoaded` gate is what keeps the client from guessing: the toggle is
		* the host's, so until the host answers, no rule is applied at all. Guessing
		* either way would play the intro against a user who turned it off.
		*
		* Pure on purpose — `scripts/verify-play-decision.mjs` drives THIS function over
		* the whole matrix instead of inferring the rule from a rendered overlay.
		*/
		function decidePlay(input) {
			if (input.sessionId !== null && input.pinned !== null && input.pinned === input.sessionId) {
				if (!input.entered) return {
					action: "none",
					reason: "already in the pinned conversation"
				};
				if (input.desktopSplash === true && typeof input.bootPlayedAt === "number" && Date.now() - input.bootPlayedAt < 6e4) return {
					action: "none",
					reason: "desktop splash already played this launch"
				};
				return {
					action: "play",
					reason: "pinned"
				};
			}
			if (!input.settingsLoaded) return {
				action: "none",
				reason: "settings not loaded yet"
			};
			if (input.settings.playOnAppStart) return input.bootPlayed ? {
				action: "none",
				reason: "this launch already played"
			} : {
				action: "play",
				reason: "app-start"
			};
			if (input.sessionId === null) return {
				action: "none",
				reason: "no conversation yet"
			};
			if (!input.isNewConversation) return {
				action: "none",
				reason: "not a new conversation"
			};
			if (input.sessionPlayed) return {
				action: "none",
				reason: "this conversation already played"
			};
			return {
				action: "play",
				reason: "new-conversation"
			};
		}
		/**
		* Apply a decision's bookkeeping. Called by the effect, never by `decidePlay`,
		* so the pure rule stays pure and side effects stay in one place.
		*/
		function recordDecision(decision, sessionId) {
			if (decision.action !== "play" || decision.reason === "pinned") return;
			if (decision.reason === "app-start") markBootPlayed();
			if (sessionId !== null) markPlayed(sessionId);
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* The stylesheet, injected once.
		*
		* Kept in its own module so `scripts/check-css-template.mjs` has one obvious
		* place to guard: the sheet is a template literal, and a stray backtick inside
		* it ends the literal and breaks the build in a way that leaves the previous
		* bundle in place — which once shipped silently.
		*
		* The layout note is load-bearing: the two fit modes differ ONLY by `object-fit`.
		* An earlier "improvement" that also rewrote the layout mechanics took the overlay
		* fully black in the real app, so it was reverted and is not to be retried.
		*/
		const STYLE_ID = "dsh-boot-animation-style";
		const CSS = `
/* ---------------------------------------------------------------------------
   0.4.3: a reset that scopes to OUR subtree and nothing else.

   The official desktop client ships a GLOBAL button style (fixed height,
   padding, background, font, sometimes a border), and our controls inherited it.
   That is why the same markup looked right in a browser and wrong in the app
   (issue #6): the buttons were not ours, they were the host's with our colours
   painted on.

   :where() keeps this reset at ELEMENT specificity (it contributes 0), so every
   class rule below still wins over it. Never raise its specificity: the day it
   starts beating .dba-skip / .dba-pin, the overlay loses its only exit.
   --------------------------------------------------------------------------- */
:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap),:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap) *{box-sizing:border-box}
:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap) button{appearance:none;-webkit-appearance:none;
  margin:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:normal;
  text-transform:none;text-align:center;min-width:0;min-height:0;height:auto;line-height:1.4;
  cursor:pointer;white-space:nowrap}
.dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
  display:flex;align-items:center;justify-content:center;
  pointer-events:auto;cursor:pointer;overflow:hidden;
  transition:background-color .46s ease}
.dba-video{width:100%;height:100%;object-fit:contain;background:#000;display:block;
  transform-origin:center;animation:dba-focus-in .34s ease;
  transition:opacity .46s ease,filter .46s ease,transform .46s ease}
/* The ONLY difference between the fit modes is object-fit.
   Do not "harden" this with position/inset changes: the bar fix does not need
   them, and an overlay that rendered correctly under flex + percentage sizing
   went fully black in the real app the one time the layout mechanics were
   rewritten for no reason. Minimal change, or you trade a cosmetic defect for
   a functional one.
   NOTE: never put a backtick in this block — the whole sheet is a template
   literal, and one backtick ends it. scripts/check-css-template.mjs enforces it. */
.dba-video.dba-cover{object-fit:cover;object-position:center}
/* ---------------------------------------------------------------------------
   0.4.4: the hand-off. The animation used to CUT: store.stop() unmounted this
   layer in the same frame, so the app appeared behind a hard edge.

   Now the clip defocuses and fades while a backdrop blur on the layer decays
   from 18px to none. Because the blur is BEHIND the video, the app resolves out
   of softness instead of popping in: at the first frame the video is still
   opaque and hides the blur, and by the time the video is transparent the blur
   is already clearing. One transition, no second layer, no overlay left behind.

   The timing here must stay SHORTER than HANDOFF_MS (ui.ts); a transition cut
   halfway looks worse than no transition at all. verify-handoff.mjs asserts it.
   --------------------------------------------------------------------------- */
@keyframes dba-focus-in{from{opacity:0;filter:blur(14px);transform:scale(1.04)}
  to{opacity:1;filter:blur(0);transform:scale(1)}}
@keyframes dba-defocus{from{backdrop-filter:blur(18px) saturate(1.06);-webkit-backdrop-filter:blur(18px) saturate(1.06)}
  to{backdrop-filter:blur(0px) saturate(1);-webkit-backdrop-filter:blur(0px) saturate(1)}}
.dba-root.dba-leaving{background-color:transparent;pointer-events:none;
  animation:dba-defocus .46s ease forwards}
.dba-root.dba-leaving .dba-video{opacity:0;filter:blur(16px);transform:scale(1.02)}
/* Chrome IS faded, not merely hidden: the hint runs an infinite opacity
   animation, which would otherwise keep winning over the declaration below. */
.dba-root.dba-leaving .dba-skip,.dba-root.dba-leaving .dba-hint,
.dba-root.dba-leaving .dba-status{opacity:0;animation:none}
@media (prefers-reduced-motion:reduce){
  .dba-video{animation:none}
  .dba-root{transition:none}
  .dba-root.dba-leaving{animation:none}
  .dba-root.dba-leaving .dba-video{transition:none}
}
/* 0.4.3 (issue #5): the top strip of the window belongs to the OS caption
   buttons on the desktop client, and a native window control always wins the
   hit test — no z-index can reach it. So the button keeps its right edge but
   drops BELOW that strip, using the Window Controls Overlay geometry the
   browser publishes. Without WCO the env() resolves to 0px and nothing moves;
   the plain declaration first keeps older engines at the old position. */
.dba-skip{position:absolute;top:20px;right:22px;z-index:2;
  top:calc(env(titlebar-area-height,0px) + 14px);
  border:1px solid rgba(255,255,255,.42);background:rgba(0,0,0,.42);
  color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;line-height:1.4;
  font-family:inherit;cursor:pointer;opacity:.92;transition:opacity .15s ease,background-color .15s ease}
.dba-skip:hover,.dba-skip:focus-visible{opacity:1;background:rgba(0,0,0,.7)}
.dba-skip:focus-visible{outline:2px solid rgba(255,255,255,.8);outline-offset:2px}
.dba-hint{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);
  z-index:2;color:rgba(255,255,255,.82);font-size:13px;letter-spacing:.06em;
  font-family:inherit;text-shadow:0 1px 8px rgba(0,0,0,.9);
  animation:dba-breathe 2.4s ease-in-out infinite;white-space:nowrap}
@keyframes dba-breathe{0%,100%{opacity:.55}50%{opacity:1}}
.dba-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:2;color:rgba(255,255,255,.88);font-size:14px;letter-spacing:.04em;
  font-family:inherit;text-align:center;max-width:78vw;
  background:rgba(0,0,0,.46);border-radius:10px;padding:10px 18px;
  text-shadow:0 1px 10px rgba(0,0,0,.9)}
/* 0.4.3 (issue #1): the sidebar footer is ONE flex row shared with other
   plugins, and a neighbour that renders a full-width panel used to squeeze this
   cell until the 🎛 button could not be hit. Never shrink, and paint above. */
.dba-pin-wrap{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;
  position:relative;z-index:2;min-width:0}
.dba-pin{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:0;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#6b7075);
  font-size:14px;line-height:1;font-family:inherit}
.dba-pin:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));
  color:var(--dsw-alias-label-primary,#191919)}
.dba-pin:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#408cff);outline-offset:1px}
.dba-pin.dba-pin-on{color:#07c160;background:rgba(7,193,96,.14)}
.dba-veil{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;padding:24px}
/* OPAQUE surface on purpose: --dsw-specific-menu resolves to a 58% translucent
   menu fill, and a settings panel that lets the conversation show through is
   unreadable. layer-1 is opaque in both themes. */
.dba-lib{width:min(620px,100%);max-height:min(78vh,660px);overflow:auto;isolation:isolate;
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#191919);
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:14px;padding:18px 18px 14px;
  box-shadow:0 18px 60px rgba(0,0,0,.42);font-family:inherit;
  font-size:13px;line-height:1.55}
.dba-lib h3{margin:0 0 4px;font-size:15px;font-weight:600}
.dba-lib p{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12.5px}
.dba-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:9px;
  border:1px solid transparent}
.dba-item:hover{background:rgba(127,127,127,.14)}
.dba-item.dba-cur{border-color:rgba(7,193,96,.55);background:rgba(7,193,96,.10)}
/* The per-conversation pin is a DIFFERENT question from the global selection, so
   it gets a different colour rather than competing for the same green. */
.dba-item.dba-ses-cur{border-color:rgba(64,140,255,.55);background:rgba(64,140,255,.10)}
.dba-item .dba-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dba-badge{font-size:11px;padding:1px 7px;border-radius:999px;
  background:rgba(127,127,127,.18);color:var(--dsw-alias-label-secondary,#777);white-space:nowrap}
.dba-badge.dba-b-sel{background:rgba(7,193,96,.16);color:#07974b}
.dba-badge.dba-b-ses{background:rgba(64,140,255,.18);color:#2c6bd6}
.dba-badge.dba-b-prev{background:rgba(64,140,255,.18);color:#2c6bd6}
.dba-badge.dba-b-warn{background:rgba(210,120,40,.18);color:#b46214;cursor:help}
.dba-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}
.dba-mark{width:14px;text-align:center;color:#07c160;font-weight:700;font-size:12px}
.dba-row-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:rgba(127,127,127,.08);color:inherit;
  border-radius:7px;padding:3px 10px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}
.dba-row-btn:hover{background:rgba(127,127,127,.18)}
.dba-row-btn.dba-go{border-color:rgba(7,193,96,.55);color:#07974b;font-weight:600}
.dba-dir{margin:12px 0 0;padding:9px 10px;border-radius:9px;background:rgba(127,127,127,.10);
  font-size:11.5px;color:var(--dsw-alias-label-secondary,#777);word-break:break-all}
.dba-dir code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--dsw-alias-label-primary,#333)}
.dba-ses{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:8px 10px;
  border-radius:9px;background:rgba(64,140,255,.10);
  font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dba-ses .dba-row-btn{margin-left:auto}
.dba-delbar{flex-wrap:wrap;background:rgba(127,127,127,.08)}
.dba-delbar .dba-row-btn{margin-left:0}
.dba-delbar .dba-danger-text{flex:1 1 100%;color:var(--dsw-alias-state-error-primary,#c0392b)}
.dba-check{width:14px;height:14px;margin:0;padding:0;flex:0 0 auto;cursor:pointer;
  accent-color:var(--dsw-alias-brand-primary,#408cff)}
.dba-check-gap{display:inline-block;width:14px;flex:0 0 auto}
.dba-row-btn.dba-danger{border-color:rgba(236,19,19,.45);
  color:var(--dsw-alias-state-error-primary,#c0392b)}
.dba-row-btn.dba-danger:hover{background:rgba(236,19,19,.12)}
.dba-bar{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.dba-fit{display:flex;align-items:center;gap:8px;margin-top:12px;
  font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dba-fit .dba-flex{flex:1}
.dba-fit .dba-note{font-size:11px;opacity:.8}
.dba-btn.dba-btn-on{border-color:rgba(7,193,96,.6);background:rgba(7,193,96,.12);color:#07974b}
.dba-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:rgba(127,127,127,.08);color:inherit;
  border-radius:8px;padding:5px 14px;font-size:12.5px;font-family:inherit;cursor:pointer}
.dba-btn:hover{background:rgba(127,127,127,.18)}
.dba-btn[disabled]{opacity:.5;cursor:default}
.dba-msg{margin-top:10px;font-size:12px;min-height:16px;color:var(--dsw-alias-label-secondary,#777)}
.dba-msg.dba-err{color:#c0392b}
.dba-msg.dba-ok{color:#07974b}
/* The accent greens/reds above are tuned for a white surface; on the dark
   theme they lose contrast, so the same roles get lighter inks there. */
body[data-ds-dark-theme] .dba-mark,
body[data-ds-dark-theme] .dba-badge.dba-b-sel,
body[data-ds-dark-theme] .dba-msg.dba-ok,
body[data-ds-dark-theme] .dba-row-btn.dba-go,
body[data-ds-dark-theme] .dba-btn.dba-btn-on{color:#4ade80}
body[data-ds-dark-theme] .dba-badge.dba-b-ses,
body[data-ds-dark-theme] .dba-badge.dba-b-prev{color:#8ab4ff}
body[data-ds-dark-theme] .dba-badge.dba-b-warn{color:#f0a35e}
body[data-ds-dark-theme] .dba-msg.dba-err{color:#ff8a80}

/* ==========================================================================
   Optional welcome layer (this fork). HTML/CSS only, on top of the clip.
   Everything is pointer-events:none so a click still reaches the root and
   closes the overlay; the skip button keeps its own clickable rule.
   ========================================================================== */
.dba-efe{cursor:pointer}
.dba-efe .dba-video{filter:saturate(.92) brightness(.82) contrast(1.06)}
.efe-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;color:#e8ecf0}
.efe-vignette{position:absolute;inset:0;
  background:radial-gradient(120% 90% at 22% 45%,rgba(0,0,0,0) 0%,rgba(0,0,0,.28) 55%,rgba(0,0,0,.62) 100%)}
.efe-scanlines{position:absolute;inset:0;opacity:.32;
  background:repeating-linear-gradient(180deg,rgba(255,255,255,.05) 0px,rgba(255,255,255,.05) 1px,rgba(0,0,0,0) 1px,rgba(0,0,0,0) 3px);
  mix-blend-mode:overlay;animation:efe-drift 9s linear infinite}
@keyframes efe-drift{from{transform:translateY(0)}to{transform:translateY(3px)}}
.efe-topbar{position:absolute;left:42px;right:42px;top:34px;display:flex;align-items:center;
  gap:12px;font-size:11.5px;letter-spacing:.22em}
.efe-brand{color:#ff7a1a;font-weight:700}
.efe-slash{opacity:.55}
.efe-brand-dim{opacity:.72}
.efe-spacer{flex:1}
.efe-sys{opacity:.6}
.efe-clock{opacity:.85;font-variant-numeric:tabular-nums}
.efe-main{position:absolute;left:9.5%;top:50%;transform:translateY(-52%);display:grid;gap:14px;
  max-width:min(660px,58vw)}
.efe-kicker{font-size:11px;letter-spacing:.42em;color:#ff7a1a;opacity:.9}
.efe-welcome{font-family:"Microsoft YaHei UI","PingFang SC","Noto Sans SC",system-ui,sans-serif;
  font-size:clamp(34px,4.4vw,62px);font-weight:700;letter-spacing:.04em;line-height:1.15;
  display:flex;align-items:baseline;gap:2px;white-space:nowrap}
.efe-welcome-text{text-shadow:0 0 24px rgba(255,122,26,.18)}
.efe-caret{display:inline-block;width:.55em;height:1.02em;background:#ff7a1a;
  transform:translateY(.12em);animation:efe-blink 1s steps(2,start) infinite;opacity:.9}
@keyframes efe-blink{50%{opacity:0}}
.efe-sub{font-size:12px;letter-spacing:.34em;opacity:.62}
.efe-rule{width:min(380px,52vw);height:1px;
  background:linear-gradient(90deg,#ff7a1a 0%,rgba(255,122,26,.45) 22%,rgba(255,122,26,0) 100%)}
.efe-hint{font-size:12.5px;letter-spacing:.2em;opacity:.75;animation:efe-pulse 2.4s ease-in-out infinite}
@keyframes efe-pulse{0%,100%{opacity:.45}50%{opacity:.92}}
.efe-corner{position:absolute;width:46px;height:46px;border:0 solid rgba(255,122,26,.75)}
.efe-c1{left:30px;top:26px;border-left-width:2px;border-top-width:2px}
.efe-c2{right:30px;top:26px;border-right-width:2px;border-top-width:2px}
.efe-c3{left:30px;bottom:26px;border-left-width:2px;border-bottom-width:2px}
.efe-c4{right:30px;bottom:26px;border-right-width:2px;border-bottom-width:2px}
.efe-side{position:absolute;right:34px;top:50%;transform:translateY(-50%);
  writing-mode:vertical-rl;font-size:9.5px;letter-spacing:.42em;opacity:.4}
.efe-loading{position:absolute;left:42px;bottom:34px;font-size:11px;letter-spacing:.28em;opacity:.6}
.dba-efe .dba-skip{right:26px;bottom:24px;top:auto;z-index:2}

/* The login-layer editor inside the clip library panel. */
.dba-login{margin-top:16px;padding-top:12px;border-top:1px solid rgba(127,127,127,.22);
  display:grid;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dba-login-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  font-size:12.5px;color:var(--dsw-alias-label-primary,#333);font-weight:600}
.dba-field{display:grid;grid-template-columns:78px 1fr;align-items:center;gap:8px}
.dba-field-label{opacity:.8}
.dba-input{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));border-radius:7px;padding:5px 9px;
  font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-base,#fff);width:100%;min-width:0}
.dba-input:focus{outline:none;border-color:rgba(255,122,26,.7)}
`;
		/** Inject the sheet once per document. */
		function ensureStyle() {
			try {
				if (document.getElementById("dsh-boot-animation-style") !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
			} catch {}
		}
		//#endregion
		//#region src/client/ui.ts
		/** How long a play attempt may show black before the overlay gives up. */
		const STALL_TIMEOUT_MS = 25e3;
		/** How long an error stays readable before the overlay closes itself. */
		const ERROR_LINGER_MS = 8e3;
		/**
		* Backoff between a failed auto-play attempt and the next one (0.4.3).
		*
		* A failed attempt used to be final for the launch, because the boot record was
		* written BEFORE the play was even requested: one slow `/resolve.json` (or an
		* empty catalog during boot) meant "no intro" for the rest of the session, with
		* nothing on screen to explain it. The record is now written only after a clip is
		* actually pointed at, and these are the retries that fill the gap.
		*/
		const PLAY_RETRY_DELAYS_MS = [
			1200,
			3e3,
			8e3
		];
		/**
		* How long the exit hand-off runs before the overlay leaves the tree (0.4.4).
		*
		* Exported so `scripts/verify-handoff.mjs` can assert this is LONGER than the CSS
		* timing: the two live in different files, and if the numbers drift apart the
		* transition gets cut halfway and silently degrades back into the hard cut it was
		* meant to replace.
		*/
		const HANDOFF_MS = 500;
		function formatBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
			return (n / 1024 / 1024).toFixed(2) + " MB";
		}
		/** Where a clip comes from, as one word a user can act on. */
		const SOURCE_LABEL = {
			yours: "你自己加的",
			embedded: "插件内置",
			env: "环境变量"
		};
		/**
		* The playback surface.
		*
		* It owns no decision: the clip id and the URL come from the store, which got
		* them from the host's resolver or from an explicit preview. Its only job is to
		* drive one <video> element and report what happened.
		*/
		/**
		* Stop a media element completely when the overlay leaves the tree.
		*
		* Ported from @windyduan's PR #2. Detaching a <video> from the DOM does not stop
		* it: HMR, disabling the plugin, or a slot remount all unmount the overlay while
		* the element keeps playing and holding a decoder. `load()` aborts the pending
		* media fetch and releases the decoder.
		*
		* Exported so `scripts/verify-teardown.mjs` exercises THIS shipped function.
		*/
		function releaseVideo(video) {
			try {
				video.pause();
				video.currentTime = 0;
				video.removeAttribute("src");
				video.load();
			} catch {}
		}
		/**
		* Reveal `text` one character at a time (the welcome layer's greeting line).
		* Reduced-motion users get the whole line at once.
		*/
		function useTypewriter(text, speedMs = 55) {
			const [value, setValue] = (0, react.useState)("");
			const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			(0, react.useEffect)(() => {
				if (reduced) {
					setValue(text);
					return;
				}
				setValue("");
				if (text === "") return void 0;
				let index = 0;
				const timer = window.setInterval(() => {
					index += 1;
					setValue(text.slice(0, index));
					if (index >= text.length) window.clearInterval(timer);
				}, speedMs);
				return () => window.clearInterval(timer);
			}, [
				text,
				speedMs,
				reduced
			]);
			return value;
		}
		/** The small HUD clock in the login layer's top bar. */
		function EfeClock() {
			const [now, setNow] = (0, react.useState)(() => /* @__PURE__ */ new Date());
			(0, react.useEffect)(() => {
				const timer = window.setInterval(() => setNow(/* @__PURE__ */ new Date()), 1e3);
				return () => window.clearInterval(timer);
			}, []);
			const pad = (n) => String(n).padStart(2, "0");
			return (0, react.createElement)("span", null, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
		}
		function desktopFullscreenBridge() {
			const candidate = window.__DSH_BOOT_FULLSCREEN__;
			if (candidate !== void 0 && typeof candidate.enter === "function" && typeof candidate.exit === "function") return candidate;
		}
		/**
		* Ask the host window to go fullscreen without a click.
		*
		* With the desktop patch this is a real window fullscreen (taskbar and title bar
		* included), driven by the Electron main process. Without it, the browser API is
		* tried and a rejection just means the window stays maximized until the first
		* interaction; nothing here can break playback.
		*/
		function enterFullscreenQuietly() {
			if (typeof window === "undefined") return;
			const bridge = desktopFullscreenBridge();
			if (bridge !== void 0) {
				bridge.enter().then((ok) => {
					if (ok !== true) notify("desktop fullscreen: refused");
				}).catch((error) => notify("desktop fullscreen: failed", String(error)));
				return;
			}
			if (typeof document === "undefined" || document.fullscreenElement !== null) return;
			const root = document.documentElement;
			if (root === null || typeof root.requestFullscreen !== "function") return;
			try {
				const attempt = root.requestFullscreen();
				if (attempt !== void 0 && typeof attempt.then === "function") attempt.then(() => notify("auto fullscreen: granted")).catch((error) => notify("auto fullscreen: blocked", String(error)));
			} catch (error) {
				notify("auto fullscreen: threw", String(error));
			}
		}
		/** Leave fullscreen by whichever route entered it. */
		function exitFullscreenQuietly() {
			if (typeof window === "undefined") return;
			const bridge = desktopFullscreenBridge();
			if (bridge !== void 0) bridge.exit().catch((error) => notify("desktop fullscreen exit failed", String(error)));
			if (typeof document !== "undefined" && document.fullscreenElement !== null && typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => {});
		}
		function BootOverlay({ store }) {
			ensureStyle();
			const snapshot = useClientStore(store);
			const { url, nonce, phase, clipId, reason, previewClipId } = snapshot.playback;
			const fit = snapshot.settings.fitMode;
			const login = snapshot.settings;
			const efe = login.loginOverlay;
			const typedWelcome = useTypewriter(efe ? `${login.welcomeTitle}${login.welcomeName}` : "");
			const [needsTap, setNeedsTap] = (0, react.useState)(false);
			const [leaving, setLeaving] = (0, react.useState)(false);
			const videoRef = (0, react.useRef)(null);
			const closedRef = (0, react.useRef)(false);
			const exitTimerRef = (0, react.useRef)(null);
			/**
			* Leave through a hand-off instead of a cut (0.4.4).
			*
			* `store.stop()` unmounts the overlay in the same frame, so the app used to
			* appear behind a hard edge — the one moment of the whole animation that looked
			* like a plugin instead of part of the product. Now the overlay marks itself
			* leaving, plays the CSS hand-off (clip blurs/fades out while a backdrop blur
			* decays from strong to none, so the app resolves out of softness), and only
			* then drops out of the tree.
			*
			* The delay is `HANDOFF_MS`, deliberately longer than the CSS timing: cutting a
			* transition halfway is worse than not having one.
			*/
			const close = (0, react.useCallback)(() => {
				if (closedRef.current) return;
				closedRef.current = true;
				exitFullscreenQuietly();
				setLeaving(true);
				exitTimerRef.current = window.setTimeout(() => {
					exitTimerRef.current = null;
					store.stop();
				}, 500);
			}, [store]);
			(0, react.useEffect)(() => () => {
				if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
				exitTimerRef.current = null;
				exitFullscreenQuietly();
			}, []);
			(0, react.useEffect)(() => {
				if (url === null) return void 0;
				const video = videoRef.current;
				if (video === null) return void 0;
				closedRef.current = false;
				setNeedsTap(false);
				setLeaving(false);
				/**
				* Sound follows the Windows default output device — a connected Bluetooth
				* headset is used automatically because the media element has no device
				* choice of its own. Electron normally allows unmuted autoplay; if a host
				* blocks it, this falls back to muted playback and the click hint.
				*/
				video.muted = false;
				video.volume = 1;
				const startedAt = performance.now();
				/** One line carrying everything a black-frame report needs. */
				const report = (label) => notify(label, {
					ms: Math.round(performance.now() - startedAt),
					clipId,
					reason,
					readyState: video.readyState,
					networkState: video.networkState,
					src: video.currentSrc || video.src
				});
				const onPlaying = () => {
					store.setPhase("playing");
					report("first frame painted");
				};
				video.addEventListener("playing", onPlaying);
				video.src = url;
				video.load();
				enterFullscreenQuietly();
				const attempt = video.play();
				if (attempt !== void 0 && typeof attempt.then === "function") attempt.then(() => void 0).catch((error) => {
					video.muted = true;
					const retry = video.play();
					if (retry !== void 0 && typeof retry.then === "function") retry.then(() => {
						setNeedsTap(true);
					}).catch(() => setNeedsTap(true));
					else setNeedsTap(true);
				});
				const guard = window.setTimeout(() => {
					if (!closedRef.current) {
						store.setPhase("stalled", "视频加载超时");
						report("stalled, giving up after " + String(STALL_TIMEOUT_MS) + "ms");
						close();
					}
				}, STALL_TIMEOUT_MS);
				return () => {
					video.removeEventListener("playing", onPlaying);
					window.clearTimeout(guard);
					releaseVideo(video);
				};
			}, [
				url,
				nonce,
				clipId,
				reason,
				store,
				close
			]);
			/**
			* Esc closes the overlay (0.4.3).
			*
			* The desktop client draws its own caption buttons over the top-right corner,
			* and a native window control always wins the click — so on that surface the
			* 「跳过」 button can be unreachable no matter what z-index it has. A keyboard
			* exit is the one escape hatch the window chrome cannot swallow.
			*/
			(0, react.useEffect)(() => {
				if (url === null) return void 0;
				const onKey = (event) => {
					if (event.key === "Escape") close();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [url, close]);
			/**
			* If the gesture-less fullscreen request was blocked, the first interaction
			* still takes the window there — the intro never waits for a click of its own.
			*/
			(0, react.useEffect)(() => {
				if (url === null) return void 0;
				const retry = () => enterFullscreenQuietly();
				window.addEventListener("pointerdown", retry, true);
				window.addEventListener("keydown", retry, true);
				const timer = window.setTimeout(() => {
					window.removeEventListener("pointerdown", retry, true);
					window.removeEventListener("keydown", retry, true);
				}, 15e3);
				return () => {
					window.removeEventListener("pointerdown", retry, true);
					window.removeEventListener("keydown", retry, true);
					window.clearTimeout(timer);
				};
			}, [url]);
			if (url === null || phase === "idle") return null;
			const activate = () => {
				const video = videoRef.current;
				if (video === null) return;
				if (needsTap) {
					setNeedsTap(false);
					video.muted = false;
					const attempt = video.play();
					if (attempt !== void 0 && typeof attempt.catch === "function") attempt.catch(() => {});
				} else if (video.muted) video.muted = false;
				enterFullscreenQuietly();
			};
			return (0, react.createElement)(
				"div",
				{
					className: `${leaving ? "dba-root dba-leaving" : "dba-root"}${efe ? " dba-efe" : ""}`,
					onClick: efe ? close : activate
				},
				(0, react.createElement)("video", {
					ref: videoRef,
					className: fit === "cover" ? "dba-video dba-cover" : "dba-video",
					muted: true,
					autoPlay: true,
					playsInline: true,
					preload: "auto",
					onEnded: close,
					onError: () => {
						const video = videoRef.current;
						notify("video element error", {
							code: video?.error?.code ?? 0,
							message: video?.error?.message ?? "",
							clipId,
							src: video?.currentSrc || url,
							readyState: video?.readyState ?? -1
						});
						store.setPhase("error", "视频加载失败 —— 控制台有 [dsh-boot-animation] 日志");
						window.setTimeout(() => {
							if (!closedRef.current) close();
						}, ERROR_LINGER_MS);
					},
					onClick: (event) => event.stopPropagation()
				}),
				/**
				* The optional welcome layer (this fork). Everything here is HTML/CSS on
				* top of the video: text stays crisp at any window size and theme, and the
				* strings come from the host so the panel can edit them. Turning
				* `loginOverlay` off leaves the plain full-screen clip, unchanged.
				*/
				efe ? (0, react.createElement)("div", { className: "efe-root" }, (0, react.createElement)("div", { className: "efe-vignette" }), (0, react.createElement)("div", { className: "efe-scanlines" }), (0, react.createElement)("div", { className: "efe-topbar" }, (0, react.createElement)("span", { className: "efe-brand" }, "DSH"), (0, react.createElement)("span", { className: "efe-slash" }, "//"), (0, react.createElement)("span", { className: "efe-brand-dim" }, "DEEPSEEK"), (0, react.createElement)("span", { className: "efe-spacer" }), (0, react.createElement)("span", { className: "efe-sys" }, "SYSTEM READY"), (0, react.createElement)("span", { className: "efe-clock" }, (0, react.createElement)(EfeClock, null))), (0, react.createElement)("div", { className: "efe-main" }, (0, react.createElement)("div", { className: "efe-kicker" }, "ADMINISTRATOR ACCESS"), (0, react.createElement)("div", { className: "efe-welcome" }, (0, react.createElement)("span", { className: "efe-welcome-text" }, typedWelcome), (0, react.createElement)("span", { className: "efe-caret" })), (0, react.createElement)("div", { className: "efe-sub" }, login.welcomeSubtitle), (0, react.createElement)("div", { className: "efe-rule" }), (0, react.createElement)("div", { className: "efe-hint" }, login.welcomeHint)), (0, react.createElement)("div", { className: "efe-corner efe-c1" }), (0, react.createElement)("div", { className: "efe-corner efe-c2" }), (0, react.createElement)("div", { className: "efe-corner efe-c3" }), (0, react.createElement)("div", { className: "efe-corner efe-c4" }), (0, react.createElement)("div", { className: "efe-side" }, "PROTOCOL 04", (0, react.createElement)("br"), "DEEPSEEK HARNESS"), phase === "playing" ? null : (0, react.createElement)("div", { className: "efe-loading" }, phase === "error" ? "SIGNAL LOST" : phase === "stalled" ? "SIGNAL UNSTABLE" : "ESTABLISHING CONNECTION…")) : null,
				efe || phase === "playing" ? null : (0, react.createElement)("div", { className: "dba-status" }, phase === "error" ? snapshot.playback.message || "视频加载失败" : phase === "stalled" ? "视频加载超时" : "正在加载视频…"),
				(0, react.createElement)("button", {
					type: "button",
					className: "dba-skip",
					title: "跳过片头（也可以按 Esc）",
					"aria-label": "跳过片头",
					onClick: (event) => {
						event.stopPropagation();
						close();
					}
				}, "跳过"),
				efe ? null : (0, react.createElement)("div", { className: "dba-hint" }, needsTap ? "点击开启声音" : "正在播放 · 点击或 Esc 跳过", previewClipId !== null && previewClipId === clipId ? " · 预览中" : "")
			);
		}
		/** Editable welcome-layer strings. Saves on blur/Enter; blank is refused. */
		function LoginFields({ store }) {
			const settings = useClientStore(store).settings;
			const [drafts, setDrafts] = (0, react.useState)({});
			const fields = [
				{
					key: "welcomeTitle",
					label: "欢迎语",
					hint: "例如：欢迎回来，"
				},
				{
					key: "welcomeName",
					label: "称呼",
					hint: "例如：管理员（可以改成你自己的名字）"
				},
				{
					key: "welcomeSubtitle",
					label: "英文副标题",
					hint: "例如：WELCOME BACK, ADMINISTRATOR"
				},
				{
					key: "welcomeHint",
					label: "底部提示",
					hint: "例如：点击任意处进入"
				}
			];
			const settled = {
				welcomeTitle: settings.welcomeTitle,
				welcomeName: settings.welcomeName,
				welcomeSubtitle: settings.welcomeSubtitle,
				welcomeHint: settings.welcomeHint
			};
			const commit = (key) => {
				const draft = drafts[key];
				if (draft === void 0 || draft.trim() === settled[key]) return;
				store.setLoginText(key, draft).then((ok) => {
					if (!ok) return;
					setDrafts((prev) => {
						const next = { ...prev };
						delete next[key];
						return next;
					});
				});
			};
			return (0, react.createElement)("div", { className: "dba-login" }, (0, react.createElement)("div", { className: "dba-login-head" }, (0, react.createElement)("span", null, "欢迎界面"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn" + (settings.loginOverlay ? " dba-btn-on" : ""),
				title: "关掉后只播全屏视频，不显示欢迎界面 —— 回到最初的效果",
				onClick: () => void store.setLoginOverlay(!settings.loginOverlay)
			}, settings.loginOverlay ? "显示登录界面：开" : "显示登录界面：关")), fields.map((field) => (0, react.createElement)("label", {
				className: "dba-field",
				key: field.key
			}, (0, react.createElement)("span", { className: "dba-field-label" }, field.label), (0, react.createElement)("input", {
				type: "text",
				className: "dba-input",
				value: drafts[field.key] ?? settled[field.key],
				placeholder: field.hint,
				maxLength: 120,
				onChange: (event) => setDrafts((prev) => ({
					...prev,
					[field.key]: event.target.value
				})),
				onBlur: () => commit(field.key),
				onKeyDown: (event) => {
					if (event.key === "Enter") commit(field.key);
				}
			}))), (0, react.createElement)("div", { className: "dba-note" }, settings.loginOverlay ? `当前显示：${settings.welcomeTitle}${settings.welcomeName}` : "登录界面已关闭：只播全屏视频（回到最初的效果）"), (0, react.createElement)("div", { className: "dba-note" }, "片头会自动全屏；声音跟随 Windows 默认输出设备（连着蓝牙耳机就自动走蓝牙）。"), (0, react.createElement)("div", { className: "dba-note" }, "DSH 启动时先播开屏动画，程序在后台加载，加载好后自动进入工作界面（按 Esc 或点击可跳过）。"));
		}
		function VideoLibrary({ store, onClose }) {
			ensureStyle();
			const snapshot = useClientStore(store);
			const clips = snapshot.catalog?.clips ?? [];
			const selectedClipId = snapshot.settings.selectedClipId;
			const playingClipId = snapshot.playback.clipId;
			const previewClipId = snapshot.playback.previewClipId;
			const conversationClipId = snapshot.conversationClipId;
			const hasSession = snapshot.sessionId !== null;
			const nameOf = (clipId) => clips.find((item) => item.id === clipId)?.name ?? clipId;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			const busy = snapshot.busy;
			const [marked, setMarked] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [confirming, setConfirming] = (0, react.useState)(false);
			const deletable = clips.filter((clip) => clip.writable === true);
			const markedIds = [...marked].filter((id) => deletable.some((clip) => clip.id === id));
			const toggleMark = (id, on) => {
				setMarked((previous) => {
					const next = new Set(previous);
					if (on) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			return (0, react.createElement)("div", {
				className: "dba-veil",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				}
			}, (0, react.createElement)(
				"div",
				{
					className: "dba-lib",
					onClick: (event) => event.stopPropagation()
				},
				(0, react.createElement)("h3", null, "片头片库"),
				(0, react.createElement)("p", null, "「▶ 预览」立刻播这一段（不改你的选择）；「选它」设为全局片头；「仅本会话」只让当前这个会话播它。"),
				(0, react.createElement)("div", { className: "dba-ses" }, hasSession ? conversationClipId === null ? "本会话跟随全局片头。想只给这个会话换一段，点那一行的「仅本会话」。" : "本会话固定播放：" + nameOf(conversationClipId) : "还没有打开的会话：先打开一个对话，才能只对它生效。", conversationClipId === null ? null : (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn",
					disabled: busy,
					title: "取消这个会话的固定片头，回到全局选择",
					onClick: () => {
						if (!busy) store.setConversationClip(null);
					}
				}, "取消（回到全局）")),
				deletable.length === 0 ? null : (0, react.createElement)("div", { className: "dba-ses dba-delbar" }, (0, react.createElement)("span", null, "本机视频：" + String(deletable.length) + " 段（可勾选删除）"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn",
					disabled: busy,
					onClick: () => setMarked(new Set(deletable.map((clip) => clip.id)))
				}, "全选"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn",
					disabled: busy || markedIds.length === 0,
					onClick: () => setMarked(/* @__PURE__ */ new Set())
				}, "清空"), markedIds.length === 0 ? null : confirming ? (0, react.createElement)("span", { className: "dba-danger-text" }, "确定删除这 " + String(markedIds.length) + " 个视频文件？文件会从磁盘删除，不可恢复") : null, markedIds.length === 0 ? null : confirming ? (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn dba-danger",
					disabled: busy,
					onClick: () => {
						setConfirming(false);
						store.deleteClips(markedIds).then((result) => {
							if (result !== null) setMarked(/* @__PURE__ */ new Set());
						});
					}
				}, "确认删除") : (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn dba-danger",
					disabled: busy,
					onClick: () => setConfirming(true)
				}, "删除所选（" + String(markedIds.length) + "）"), confirming ? (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn",
					disabled: busy,
					onClick: () => setConfirming(false)
				}, "取消") : null),
				...clips.length === 0 ? [(0, react.createElement)("div", { className: "dba-item" }, (0, react.createElement)("span", { className: "dba-nm" }, snapshot.loading ? "（正在读取…）" : "（还没找到任何视频）"))] : clips.map((clip) => (0, react.createElement)("div", {
					key: clip.id,
					className: "dba-item" + (clip.id === selectedClipId ? " dba-cur" : "") + (clip.id === conversationClipId ? " dba-ses-cur" : ""),
					title: clip.file ?? clip.id
				}, clip.writable === true ? (0, react.createElement)("input", {
					type: "checkbox",
					className: "dba-check",
					checked: marked.has(clip.id),
					disabled: busy,
					title: "勾选后可批量删除这个视频文件",
					onChange: (event) => toggleMark(clip.id, event.target.checked)
				}) : (0, react.createElement)("span", { className: "dba-check-gap" }), (0, react.createElement)("span", { className: "dba-mark" }, clip.id === selectedClipId ? "✓" : ""), (0, react.createElement)("span", { className: "dba-nm" }, clip.name), clip.id === conversationClipId ? (0, react.createElement)("span", { className: "dba-badge dba-b-ses" }, "本会话") : null, clip.id === playingClipId ? (0, react.createElement)("span", { className: "dba-badge dba-b-sel" }, previewClipId === clip.id ? "预览中" : "播放中") : null, clip.legacy ? (0, react.createElement)("span", { className: "dba-badge" }, "原片源") : null, (clip.copies ?? 1) > 1 ? (0, react.createElement)("span", {
					className: "dba-badge",
					title: "这一段在磁盘上有 " + String(clip.copies) + " 份相同的副本，已合并成一条。你的文件没有被删，只是不重复列出。"
				}, "合并 " + String(clip.copies) + " 份重复") : null, (clip.ext === ".mp4" || clip.ext === ".m4v") && clip.faststart === false ? (0, react.createElement)("span", {
					className: "dba-badge dba-b-warn",
					title: "这个文件的索引表(moov)在末尾：浏览器要整段下载完才出画面，容易黑屏。用 ffmpeg -c copy -movflags +faststart 重排一次即可。"
				}, "⚠ 未优化") : null, (0, react.createElement)("span", { className: "dba-badge" }, SOURCE_LABEL[clip.source] ?? clip.source), (0, react.createElement)("span", { className: "dba-meta" }, formatBytes(clip.bytes)), (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn",
					title: "立刻播放这一段，不改变你的选择",
					onClick: () => {
						store.preview(clip.id);
					}
				}, "▶ 预览"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn" + (clip.id === selectedClipId ? "" : " dba-go"),
					disabled: busy || clip.id === selectedClipId,
					title: "设为以后开片头时播放的片段",
					onClick: () => {
						if (!busy) store.selectClip(clip.id);
					}
				}, clip.id === selectedClipId ? "已选" : "选它"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-row-btn" + (clip.id === conversationClipId ? " dba-go" : ""),
					disabled: busy || !hasSession,
					title: hasSession ? "只让当前这个会话播这一段 —— 不改你给其它会话和全局选的那一段" : "先打开一个对话，才能只对它生效",
					onClick: () => {
						if (!busy && hasSession) store.setConversationClip(clip.id);
					}
				}, clip.id === conversationClipId ? "本会话 ✓" : "仅本会话"))),
				(0, react.createElement)("div", { className: "dba-dir" }, "想加自己的片子：把 mp4 放进这个文件夹，再点「刷新」", (0, react.createElement)("br", null), (0, react.createElement)("code", null, snapshot.catalog?.userDir ?? "…")),
				(0, react.createElement)("div", { className: "dba-fit" }, (0, react.createElement)("span", null, "播放方式："), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn" + (snapshot.settings.fitMode === "cover" ? " dba-btn-on" : ""),
					title: "铺满整个窗口，超出部分裁掉 —— 不留黑边",
					onClick: () => void store.setFitMode("cover")
				}, "铺满屏幕"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn" + (snapshot.settings.fitMode === "contain" ? " dba-btn-on" : ""),
					title: "完整显示整帧，长宽比不匹配时留黑边",
					onClick: () => void store.setFitMode("contain")
				}, "完整显示"), (0, react.createElement)("span", { className: "dba-flex" }), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn" + (snapshot.settings.randomPlayback ? " dba-btn-on" : ""),
					title: "每次开片头时，从所有可播放的片段里随机挑一段（连续两次不会挑到同一段）",
					onClick: () => void store.setRandomPlayback(!snapshot.settings.randomPlayback)
				}, snapshot.settings.randomPlayback ? "🎲 随机播放：开" : "🎲 随机播放：关")),
				/**
				* The when-to-play switch (0.4.2). Its state is the HOST's
				* `playOnAppStart`, read back from `/videos.json` — never a client-side
				* guess — and the label spells out both rules so it cannot mislead.
				*/
				(0, react.createElement)("div", { className: "dba-fit" }, (0, react.createElement)("span", null, "什么时候播："), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn" + (snapshot.settings.playOnAppStart ? " dba-btn-on" : ""),
					title: "每次启动 DSH 应用时播放一次片头；同一轮使用中不重复，下次打开 DSH 再播一次。关掉后只在你新建会话时播一次。被钉住的会话不受这个开关影响，仍然每次进入都重播。",
					onClick: () => void store.setPlayOnAppStart(!snapshot.settings.playOnAppStart)
				}, snapshot.settings.playOnAppStart ? "🚀 每次启动 DSH 时播放一次：开" : "🚀 每次启动 DSH 时播放一次：关（只在新建会话时播）"), (0, react.createElement)("span", { className: "dba-note" }, snapshot.settings.playOnAppStart ? "同一轮使用中不重复；下次打开 DSH 再播" : "只在新建会话时播一次")),
				(0, react.createElement)(LoginFields, { store }),
				(0, react.createElement)("div", { className: "dba-bar" }, (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn",
					title: "立刻按当前设置播一次（随机开启时就是从全部片段里随机挑一段）",
					onClick: () => void store.playMode(snapshot.settings.randomPlayback ? "random" : "selected", "active")
				}, "▶ 播一次"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn",
					onClick: () => void store.loadCatalog()
				}, "刷新"), (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn",
					onClick: onClose
				}, "关闭")),
				(0, react.createElement)("div", { className: "dba-msg " + snapshot.status.kind }, snapshot.status.text)
			));
		}
		/** The pin toggle that lives beside Settings at the sidebar foot. */
		function PinAction({ store, sessionStore, onOpen }) {
			ensureStyle();
			const { sessionId } = useCurrentSession(sessionStore);
			const [pinned, setPinned] = (0, react.useState)(() => readPinned());
			const isPinned = sessionId !== null && pinned === sessionId;
			const toggle = () => {
				const next = isPinned ? null : sessionId;
				writePinned(next);
				setPinned(next);
				if (next !== null) store.setStatus("已把这个会话设为片头会话", "dba-ok");
			};
			const title = isPinned ? "这个会话已设为片头会话：每次打开都会播放片头动画（点击取消）" : "把这个会话设为片头会话：以后每次打开它都会播放片头动画";
			return (0, react.createElement)("span", { className: "dba-pin-wrap" }, (0, react.createElement)("button", {
				type: "button",
				className: isPinned ? "dba-pin dba-pin-on" : "dba-pin",
				title,
				"aria-label": title,
				disabled: sessionId === null,
				onClick: toggle
			}, isPinned ? "🎬" : "🎞"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-pin dba-lib-open",
				title: "片头片库：查看、预览、切换或添加片头视频",
				"aria-label": "打开片头片库",
				onClick: onOpen
			}, "🎛"));
		}
		/**
		* The overlay's host component: the only place the "when to play" rules live.
		*
		* Two rules, and the user picks which one by toggling `playOnAppStart` in the
		* library panel (the value lives on the HOST, in selection.json):
		*
		*   on  (default)  play once per DSH launch, in whatever conversation the app
		*                  opens first — the "boot animation" reading, and the fix for
		*                  the field report 「一次性的」
		*   off            the original rule: once per new conversation, per session
		*
		* A pinned conversation replays on every entry under BOTH rules, and neither
		* rule nor the toggle touches it. The decision itself is `decidePlay` in
		* session.ts — pure, so it can be tested exhaustively; this component only
		* gathers its inputs and calls `playMode`, so there is still exactly one
		* playback path for a pin, a random setting and an auto-play alike.
		*/
		function AppRoot({ store, sessionStore }) {
			const snapshot = useClientStore(store);
			const { sessionId, isNewConversation } = useCurrentSession(sessionStore);
			const [libraryOpen, setLibraryOpen] = (0, react.useState)(false);
			/** Bumped by the retry timer, so the decision effect can run again. */
			const [attempt, setAttempt] = (0, react.useState)(0);
			const lastSessionRef = (0, react.useRef)(null);
			const inFlightRef = (0, react.useRef)(false);
			const triesRef = (0, react.useRef)(0);
			const retryTimerRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				store.setSession(sessionId);
			}, [sessionId, store]);
			(0, react.useEffect)(() => {
				store.loadCatalog();
			}, [store, sessionId]);
			(0, react.useEffect)(() => {
				const handler = () => setLibraryOpen(true);
				libraryOpeners.add(handler);
				return () => {
					libraryOpeners.delete(handler);
				};
			}, []);
			/**
			* Stop waiting for the host's settings (0.4.3).
			*
			* `settingsLoaded` is a hard gate on the decision, which is correct when the
			* payload arrives — and becomes "no intro at all, silently" when it does not.
			* A boot animation must degrade to "plays with the host's defaults", never to
			* "nothing happened and nothing said so".
			*/
			(0, react.useEffect)(() => {
				if (snapshot.settingsLoaded) return void 0;
				const timer = window.setTimeout(() => {
					store.markSettingsFallback(`no answer from the host within ${String(SETTINGS_FALLBACK_MS)}ms`);
				}, SETTINGS_FALLBACK_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [snapshot.settingsLoaded, store]);
			(0, react.useEffect)(() => () => {
				if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}, []);
			/**
			* The desktop splash is a SEPARATE window, so its record lives in localStorage.
			* Consuming it here marks this launch as already shown: the app-start rule and
			* the pinned-conversation launch grace both stay quiet for this launch.
			*/
			(0, react.useEffect)(() => {
				if (readDesktopSplash() === null) return;
				markBootPlayed();
				consumeDesktopSplash();
			}, []);
			(0, react.useEffect)(() => {
				const entered = lastSessionRef.current !== sessionId;
				lastSessionRef.current = sessionId;
				const decision = decidePlay({
					sessionId,
					entered,
					settingsLoaded: snapshot.settingsLoaded,
					settings: snapshot.settings,
					pinned: readPinned(),
					isNewConversation,
					bootPlayed: hasBootPlayed(),
					bootPlayedAt: readBootPlayedAt(),
					desktopSplash: desktopFullscreenBridge() !== void 0,
					sessionPlayed: sessionId === null ? false : hasPlayed(sessionId)
				});
				if (decision.action !== "play") return;
				if (inFlightRef.current) return;
				inFlightRef.current = true;
				decision.reason;
				(async () => {
					const started = await store.playMode("active", decision.reason);
					inFlightRef.current = false;
					if (started) {
						recordDecision(decision, sessionId);
						triesRef.current = 0;
						return;
					}
					const delay = PLAY_RETRY_DELAYS_MS[triesRef.current];
					if (delay === void 0) {
						notify("giving up on the intro after repeated failures", {
							reason: decision.reason,
							sessionId
						});
						return;
					}
					triesRef.current += 1;
					retryTimerRef.current = window.setTimeout(() => {
						retryTimerRef.current = null;
						setAttempt((value) => value + 1);
					}, delay);
				})();
			}, [
				sessionId,
				isNewConversation,
				snapshot.settingsLoaded,
				snapshot.settings,
				store,
				attempt
			]);
			return (0, react.createElement)(react.Fragment, null, (0, react.createElement)(BootOverlay, { store }), libraryOpen ? (0, react.createElement)(VideoLibrary, {
				store,
				onClose: () => setLibraryOpen(false)
			}) : null);
		}
		/** Openers registered by mounted AppRoots. */
		const libraryOpeners = /* @__PURE__ */ new Set();
		/** Ask whichever AppRoot is mounted to show the picker. */
		function openLibrary() {
			for (const open of libraryOpeners) try {
				open();
			} catch {}
		}
		//#endregion
		//#region src/client/index.ts
		/** The ui-session store, when the host provides one that behaves. */
		function storeOf(ready) {
			const candidate = ready.uiSession?.adapter?.current;
			return candidate !== void 0 && typeof candidate.getSnapshot === "function" && typeof candidate.subscribe === "function" ? candidate : null;
		}
		function apply(ctx) {
			const wire = (ready) => {
				const sessionStore = storeOf(ready);
				const store = new ClientStore();
				ready.uiSession;
				const register = () => {
					ready.slots.inject("shell.overlay", () => ready.slots.register({
						name: "shell.overlay",
						id: "dsh-boot-animation",
						order: 900
					}, () => (0, react.createElement)(AppRoot, {
						store,
						sessionStore
					})));
					ready.slots.inject("sidebar.footer.action", () => ready.slots.register({
						name: "sidebar.footer.action",
						id: "dsh-boot-animation-pin",
						order: 40,
						label: () => "片头动画"
					}, () => (0, react.createElement)(PinAction, {
						store,
						sessionStore,
						onOpen: () => openLibrary()
					})));
				};
				if (typeof ready.effect === "function") ready.effect(register, "dsh-boot-animation: mounts");
				else register();
			};
			if (typeof ctx.inject === "function") {
				ctx.inject(["slots", "uiSession"], wire);
				return;
			}
			if (ctx.slots !== void 0 && ctx.uiSession !== void 0) wire(ctx);
			else notify("idle: host offers no dynamic injection and no uiSession");
		}
		//#endregion
		exports.ClientStore = ClientStore;
		exports.DEFAULT_PLAY_ON_APP_START = DEFAULT_PLAY_ON_APP_START;
		exports.HANDOFF_MS = HANDOFF_MS;
		exports.LAUNCH_GRACE_MS = LAUNCH_GRACE_MS;
		exports.apply = apply;
		exports.clearBootPlayed = clearBootPlayed;
		exports.decidePlay = decidePlay;
		exports.hasBootPlayed = hasBootPlayed;
		exports.hasPlayed = hasPlayed;
		exports.isBlankSession = isBlankSession;
		exports.markBootPlayed = markBootPlayed;
		exports.markPlayed = markPlayed;
		exports.mediaUrlFor = mediaUrlFor;
		exports.readBootPlayedAt = readBootPlayedAt;
		exports.readPinned = readPinned;
		exports.recordDecision = recordDecision;
		exports.releaseVideo = releaseVideo;
		exports.resolveSessionId = resolveSessionId;
		exports.writePinned = writePinned;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map