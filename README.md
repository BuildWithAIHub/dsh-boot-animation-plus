# DSH Boot Animation Plus

给 DeepSeek Harness（DSH）加一个「打开就有片头动画」的开机效果：每次打开 DSH、打开新会话，或每次进入你**钉住**的那个会话时，满窗口播一段片头动画，再淡出进入工作区。

这是 [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) 的社区 fork（BSD-3-Clause），在保留上游全部能力的基础上增加了**片库批量删除**。

> English: see [README.en.md](README.en.md).

## 功能

- **内置 4 段 DeepSeek 片头**：品牌、赛博朋克、数字角色苏醒、启动片头。全部**嵌入在代码里**（`lib/clips.data.js`），安装后不依赖任何外部视频文件。
- **片库面板**：切换内置片头、预览选中项、把你自己的视频加进片库；支持「顺序 / 随机 / 单次」播放与适配方式（cover / contain）。
- **按会话钉住**：把某个会话钉住后，每次进入它都重播（新会话则按全局设置）。
- **本 fork 新增：批量删除** —— 片库支持多选、全选/清空，确认后**同步删除**你自己加入的视频文件（内置片头不可删，删除前有二次确认）。
- **可选欢迎层**：在片头之上叠加一层欢迎界面（文字可自定义），**默认关闭**，喜欢纯视频的同学不用管它。

## 安装

DSH Desktop 可以在 **Settings → Plugins** 的安装框里填 GitHub 地址，或者用命令行：

```bash
dsh plugin --profile desktop add github:BuildWithAIHub/dsh-boot-animation-plus
```

普通 `dsh web` 把 `desktop` 换成你的 profile 名（常见是 `web`）。安装后刷新页面或重启 DSH。

要求：DSH `>= 0.1.5-rc.1`（`package.json` 的 `dsh.engines.dsh`），Node.js `>= 20`。

## 与上游的差异

| 项 | 上游 dsh-boot-animation | 本 fork |
|---|---|---|
| 片库批量删除 | 无 | ✅ 多选 / 全选 / 确认删除，同时删除用户视频文件 |
| 内置片头 | 4 段 DeepSeek 片头 | 相同 4 段，不再包含第三方游戏片头 |
| 欢迎层 | 默认开启 | 默认**关闭**（纯视频体验） |
| 包名 | `dsh-boot-animation` | `dsh-boot-animation-plus`（避免与上游冲突） |

## 开发

```bash
npm run build     # 构建 lib/（含把 media/*.mp4 嵌入 lib/clips.data.js）
npm run check     # 22 组校验脚本
```

构建产物 `lib/` 已提交在仓库里，所以从源码安装时**不会**触发任何构建脚本。

## 隐私

- 插件只读写本地 DSH 配置和视频目录，不发送任何网络请求；
- 没有遥测、统计或账号相关代码。

## 许可与素材

- 代码：BSD-3-Clause，见 [LICENSE](LICENSE)；上游版权归 NativeDog1/dsh-boot-animation，见 [NOTICE.md](NOTICE.md)。
- 内置的 4 段片头视频来自 DSH/DeepSeek 品牌素材，版权归权利人所有，仅随插件作为开屏演示分发；如权利人要求会立即移除。
