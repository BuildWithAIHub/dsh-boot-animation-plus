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
export const STYLE_ID = 'dsh-boot-animation-style'

export const CSS = `
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
`

/** Inject the sheet once per document. */
export function ensureStyle(): void {
  try {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  } catch {
    /* no document (tests): styling is cosmetic, never fatal */
  }
}
