# DSH Boot Animation Plus

A startup intro animation for DeepSeek Harness (DSH): play a full-frame intro when DSH opens, when a new conversation starts, or every time you enter the conversation you pinned, then fade into the workspace.

This is a community fork of [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) (BSD-3-Clause) that adds **batch delete in the clip library**.

> 中文说明见 [README.md](README.md).

## Features

- **Four embedded DeepSeek clips** (brand, cyberpunk, awakening, startup). They live inside the code (`lib/clips.data.js`) — no external video files required.
- **Clip library panel**: switch clips, preview the selection, add your own videos; sequential / random / once playback and cover / contain fit modes.
- **Per-conversation pinning**: pin a conversation and it replays on every entry.
- **New in this fork: batch delete** — multi-select clips, select all / clear, confirm, and the plugin also deletes the video files you added yourself. Built-in clips are never deletable.
- **Optional welcome layer** on top of the clip, with editable text. Off by default.

## Install

In DSH Desktop use **Settings → Plugins** and paste the GitHub spec, or run:

```bash
dsh plugin --profile desktop add github:BuildWithAIHub/dsh-boot-animation-plus
```

For plain `dsh web`, replace `desktop` with your profile name (often `web`). Refresh the page or restart DSH afterwards.

Requires DSH `>= 0.1.5-rc.1` (see `dsh.engines.dsh`) and Node.js `>= 20`.

## Differences from upstream

| | upstream | this fork |
|---|---|---|
| Batch delete in the library | no | ✅ multi-select, select all, confirm, deletes user clip files |
| Built-in clips | four DeepSeek clips | same four, third-party game clip removed |
| Welcome layer | on by default | off by default |
| Package name | `dsh-boot-animation` | `dsh-boot-animation-plus` |

## Development

```bash
npm run build     # builds lib/, embedding media/*.mp4 into lib/clips.data.js
npm run check     # 22 verification scripts
```

The built `lib/` is committed, so installing from source never runs build scripts.

## Privacy

- Reads and writes only local DSH configuration and the video folder; makes no network requests.
- No telemetry, analytics, or account code.

## License and media

- Code: BSD-3-Clause, see [LICENSE](LICENSE). Upstream copyright belongs to NativeDog1/dsh-boot-animation, see [NOTICE.md](NOTICE.md).
- The four bundled intro clips are DeepSeek brand material and remain the property of their owners; they ship only as a demo of the splash effect and will be removed on request.
