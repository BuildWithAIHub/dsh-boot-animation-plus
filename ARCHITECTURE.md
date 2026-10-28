# Architecture

This fork keeps the upstream architecture; only the library deletion path is new.

## Halves

- **Host** (`src/host/`): registers HTTP routes under `/dsh-boot-animation`, keeps
  the selection store (`%DSH_HOME%/boot-animation/selection.json`), serves the
  embedded clips, and owns the per-conversation pin map.
- **Client** (`src/client/`): mounts the overlay in the `shell.overlay` slot, the
  library/settings panel in the sidebar footer, and talks to the host routes.
- **Build** (`scripts/build.mjs`, `tsdown`, `scripts/embed-clips.mjs`): compiles
  the client and embeds `media/*.mp4` as base64 into `lib/clips.data.js`, so the
  installed package needs no external video files. `lib/` is committed.

## Batch delete (this fork)

1. The library panel marks clips whose `writable` flag is true (clips added by the
   user) and posts `{ clipIds }` to `POST /dsh-boot-animation/delete`.
2. `handleDelete` in `src/host/index.js` validates the payload (array, max 200,
   file-backed and writable clips only), resolves each path through
   `containedFilePath` (realpath inside the writable scan directories), deletes
   the files, then invalidates the clip registry.
3. If the selected clip or a conversation pin pointed at a deleted clip, the host
   clears that selection and tells the client, which reloads the catalog and stops
   any playback.

## Network

No outbound requests. Media is served from an in-process local route; all state
stays under the DSH home directory.
