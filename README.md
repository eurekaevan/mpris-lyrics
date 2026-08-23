# MPRIS Lyrics

MPRIS Lyrics 是一个面向 GNOME Shell 50 的极简扩展。它自动发现会话总线上的
`org.mpris.MediaPlayer2.*` 播放器，从 MPRIS 元数据查询 LRCLIB，并在顶部状态栏
显示当前一句同步歌词。点击歌词会打开 Shell 原生 popup，其中包含 MPRIS 封面、媒体
信息、播放进度、可滚动歌词、逐行/逐词高亮、可选的行级双语翻译、逐歌曲时间偏移和
播放器选择。
原歌词统一归一化为 `LyricsDocument`，翻译独立保存为按 `lineId` 对齐的
`TranslationDocument`；翻译不会改写原文或 timing。

它不调用 `playerctl`，不使用 Spotify Web API、OAuth 或 Spotify track ID。Firefox
中的 Spotify Web 和暴露标准 MPRIS 的 Spotify Linux 客户端走同一条数据路径。

## 安装和调试

```sh
make check
make install
gnome-extensions enable mpris-lyrics@eureka
```

`make reload` 可以执行当前已加载版本的 disable / enable 生命周期检查：

```sh
make reload
```

GNOME Shell 50 会在当前进程中缓存已经 import 的扩展 ESM。复制了新的 JavaScript
代码后，disable / enable 不会 fresh-import 新模块；要实际运行新代码必须注销并重新
登录。`make reload` 不能替代这一步。

重新登录并让 Shell 发现 `prefs.js` 后，可以打开 GTK4/Libadwaita 设置：

```sh
gnome-extensions prefs mpris-lyrics@eureka
```

设置会通过 GSettings 立即反映到正在运行的扩展，不需要再次 disable / enable。首次从
没有 Preferences 的旧版本升级时，当前登录会话仍缓存旧的扩展描述，需要重新登录一次
后上述命令才会发现新页面。

事件驱动 MPRIS 调用计数，以及本地 HTTP 缓存/错误/取消测试：

```sh
make integration
```

有正在运行的 MPRIS 播放器且网络可用时，可以执行真实集成检查：

```sh
gjs -m tests/integration-current-player.js
```

下面的真实测试会对当前播放器执行一次 Next / Previous，验证 A → B → A 的
session cache hit，并恢复 A 的位置和原播放状态：

```sh
gjs -m tests/integration-track-cache.js
```

`tests/integration-playback-sync.js` 是开发期行为测试：它会暂时控制当前播放器完成
Play/Pause/Resume 和前后 Seek，验证 monotonic 推算、暂停冻结和跳转校准，然后恢复
原状态与位置。

真实 Firefox 与临时第二播放器的 Auto / preferred / fallback 策略测试不会控制播放：

```sh
gjs -m tests/integration-live-player-policy.js
```

读取当前 LRCLIB 的一个 word、一个 plain-only 和一个 instrumental 记录，并只输出
解析统计（不输出歌词正文）：

```sh
gjs -m tests/integration-live-lyricsfile.js
```

翻译的纯逻辑与本地 HTTP contract 测试不消耗真实 API：

```sh
gjs -m tests/test-translation-document.js
gjs -m tests/test-translation-service.js
gjs -m tests/integration-translation-http.js
```

下面的可选测试会在 GNOME Secret Service 写入并立即删除一个独立的测试值：

```sh
make integration-secret
```

安装态 Preferences 的自动打开与控件类型检查：

```sh
gjs -m tests/prefs-window.js \
  ~/.local/share/gnome-shell/extensions/mpris-lyrics@eureka
```

GNOME 50 的嵌套 Shell 生命周期检查使用打包后的 zip：

```sh
make check
dbus-run-session -- env GSETTINGS_BACKEND=memory \
  gnome-shell-test-tool --headless \
  --extension /tmp/mpris-lyrics@eureka.shell-extension.zip \
  tests/shell-extension.js
```

Wayland 会话中无法用 `Alt+F2` 后输入 `r` 重启 Shell。如果首次安装后当前 Shell
没有发现扩展，或安装了新的 JavaScript 版本，请注销并重新登录一次。查看本次登录的
扩展日志：

```sh
journalctl --user -b -o cat | rg 'MPRIS Lyrics'
```

Fish 用户可直接运行上述命令；Makefile 内部使用 `make` 自己的变量语法。

## 结构

- `extension.js`：生命周期、GSettings、effective offset 与歌词/UI 协调、line/word
  时间边界的一次性定时器。
- `mpris.js`：播放器发现、稳定 Identity/DesktopEntry policy、D-Bus 信号、Position
  单次校准和 monotonic 推算。
- `lyrics.js`：LRCLIB `/api/get`、404 后的 `/api/search`、取消、coalescing、限速/429，
  以及 memory/disk cache 分层。
- `lyrics-document.js`、`lyrics-normalizer.js`：统一模型、sync-level validation 和
  Lyricsfile → LRC → plain 的安全 fallback。
- `lyricsfile-parser.js`、`lyrics-parser.js`：Lyricsfile YAML 与 LRC 解析。
- `lyrics-matcher.js`：title/artist/album/duration/同步质量的候选评分和可信阈值。
- `lyrics-synchronizer.js`：当前行、word 状态和下一时间边界计算。
- `translation-document.js`：稳定 lineId、翻译模型、source lyrics hash、返回 ID
  验证与对齐。
- `translation-batching.js`：整首优先、超长歌词按行/字符上限分块，保留边界上下文。
- `translation-provider.js`：可替换 provider contract、OpenAI Responses 实现与
  deterministic mock provider。
- `translation-service.js`：cache-first、provider 选择、请求去重、取消、race validation
  和错误状态。
- `credentials.js`：使用 GNOME Secret Service/libsecret 保存 provider credential。
- `translation-cache.js`：与 LRCLIB cache 分离的长期翻译 cache。
- `storage.js`：SHA-256 track key、cache schema v2 原始 provider payload、v1 兼容和
  per-track offset store。
- `indicator.js`：symbolic panel indicator、媒体 header、播放进度、歌词滚动、offset
  和播放器控件。
- `artwork-loader.js`、`artwork-view.js`：`file://`/HTTP(S) 异步封面加载、大小限制、
  disk cache、取消/race 校验、TextureCache 解码和 fallback。
- `ui-utils.js`：播放时间格式化、进度 fraction、歌词视觉层级、comfortable-zone
  滚动目标和顶栏歌词移动时间轴的纯函数。
- `prefs.js`、`schemas/`：GTK4/Libadwaita Preferences 和正式 GSettings schema。
- `js-yaml.mjs`、`LICENSE.js-yaml`：随扩展打包的 js-yaml 4.1.0 readable ESM 与
  MIT license；`README.js-yaml.md` 记录固定 SHA-256 和可重复取得方式。

没有周期性 MPRIS polling。播放器发现使用 `NameOwnerChanged`，状态更新使用
`PropertiesChanged`，跳转使用 `Seeked`；歌词显示只为下一行或 popup 中下一 word
边界安排一次性本地 timer。popup 打开时每 500ms 从现有 monotonic playback clock
刷新一次纯 UI 进度，关闭后立即移除；不会额外读取 D-Bus Position。popup 关闭、暂停、
换歌或 disable 时 word timer 会移除。
暂停、恢复和换歌时会单次读取 Position 重新校准，Seeked 信号直接提供新的 Position
锚点。
顶栏长歌词使用单个原生 Clutter transition；速度变化、暂停恢复与 Seek 只在已有的
歌词行/播放状态事件上重新锚定，不增加 polling、逐帧 JS loop 或 playback tick
布局计算。

歌词加载后会为每个 `LyricsLine` 创建一次 row。逐词推进只重设当前行 label 的安全
Pango markup；歌词文本先经 `GLib.markup_escape_text()`，不能注入 markup。只有换行
才滚动并更新顶栏，word 变化不会触发顶栏 layout 或重复滚动。
译文是同一 row 中的第二个固定 label；翻译返回只更新译文 label，word
timer 不重建或更新译文 actor。

## 行为

- 有逐行或逐词歌词时，顶栏使用主题 symbolic music icon 加当前整句歌词；歌词区域
  左对齐，关闭 `show-icon` 只隐藏 icon 并释放预留宽度，不改动 label 文本。
- 顶栏 Indicator 的自然宽度约为 320px，同时受 `max-panel-width` 限制；短歌词不会
  反复收窄，长歌词和侧边布局会在触及中间日期区域前让出空间。
- `panel-position` 支持 Left、Right、Center、Far left 和 Far right。Left/Right 位于
  对应 panel box 靠近中间的一侧，Far left/Far right 位于屏幕外缘；移动的是同一个
  Indicator container，不保存 transient bus name。
- 同步歌词超出可用宽度时，图标和 Indicator 边界保持固定，只在裁剪 viewport 内从
  句首向句尾浏览一次。移动距离取实际像素 overflow，时间轴取当前行开始时间、下一行
  开始时间（末行 fallback 显式结束时间、最后一个 word 或歌曲时长）和 MPRIS 播放速率。
  默认约保留开头 12%、移动 68%、句尾 20%，开头最多 600ms、句尾最多 1000ms。
- Seek 会直接定位到该句对应的水平位置；Pause 冻结当前位置，Resume 从当前播放位置
  重新对齐；鼠标停留时暂停移动，离开后重新锚定。系统 reduced-motion 时保留 END
  ellipsize，不执行水平动画。缺少可靠结束时间的内容保持静态，不使用任意固定速度。
- Lyricsfile 的 word timing 只影响 popup；当前 word 使用 inherited theme foreground、
  underline/weight 和 alpha 区分已唱、当前、未唱，不使用固定鲜艳颜色。
- instrumental 在顶栏显示 `Instrumental`，popup 显示 `Instrumental track`，并作为
  positive cache 保存。
- plain lyrics 作为静态内容显示，不自动滚动，也不伪造时间戳。
- 翻译默认关闭。启用后支持 Original + Translation、Original only 和
  Translation only；缺失译文的行始终 fallback 原文。
- 翻译仅按行进行；original word timing 与 karaoke 不变，译文不伪造 word
  timing。顶栏默认仍显示原文，也可选 translated，未加载时 fallback 原文。
- OpenAI provider 使用固定 `gpt-5.4-mini-2026-03-17` snapshot、Responses API
  strict JSON Schema 和 `store: false`。API key 只保存在 Secret Service，不进入
  GSettings、cache 或 journal。
- 翻译 cache 位于
  `$XDG_CACHE_HOME/mpris-lyrics/translations/<sha256>.json`，key 包含
  `sourceLyricsHash + targetLanguage + provider + model + schema version`。
- 查询中、无歌词、歌词开始前以及 LRC 的空白时间标签处显示 `Title — Artist`。
- popup 始终保留 title / artist，album 存在时显示；无歌词时显示 `No lyrics found`。
  `mpris:artUrl` 缺失或失败时保留 symbolic fallback；HTTP(S) 封面按 artUrl SHA-256
  缓存到 `$XDG_CACHE_HOME/mpris-lyrics/artwork/`，最多 128 张或 64 MiB，单次响应上限
  8 MiB。
- popup 的媒体 header 使用 80px 正方形 artwork；Title 最多两行，Artist/Album 各一行，
  Album 缺失时隐藏。歌词滚动视口最大高度为 18em（默认 Shell 字号约 240px），当前行
  目标位置约为 viewport 的 47%，已在 40%–58% comfortable zone 内时不会反复滚动。
- 歌词行视觉权重按与 currentIndex 的距离集中计算：当前行 100%，相邻约 72%，距离 2
  约 56%，更远约 42%；译文在对应原文基础上继续降权。当前行切换只更新已有 row 的
  class/opacity，不重建整首歌词。
- popup 的 symbolic `−`/`+` 和 `Reset` 控制当前歌曲 offset，范围为 -10s 到 +10s；
  Preferences 单独控制全局 offset。最终位置为
  `playbackPosition + globalOffset + trackOffset`。
- 每首歌 offset 使用 track metadata 的 SHA-256 key，保存到
  `$XDG_CONFIG_HOME/mpris-lyrics/offsets.json`，最多保留最近使用的 500 条。
- positive LyricsDocument 和 no-lyrics 结果先进入 100 首 memory LRU；disk cache v2
  保存 LRCLIB id、instrumental、plainLyrics、syncedLyrics、lyricsfile、fetchedAt 和
  lastAccessed 原始字段，加载时重新解析。version 1 的安全 LRC 记录仍可读取。缓存位于
  `$XDG_CACHE_HOME/mpris-lyrics/lyrics/<sha256>.json`。positive cache 有效 30 天，
  negative cache 有效 24 小时，disk cache 最多 500 条。
- Auto 优先状态为 `Playing` 的播放器；preferred player 使用 DesktopEntry、其次
  Identity 匹配。preferred 不存在时临时回退 Auto，重新出现后自动恢复。
- 播放器全部消失或没有有效标题时隐藏面板项。
- `/api/get` 携带 title、artist、album 和秒级 duration；仅在 404 后使用 structured
  `/api/search`，再以 title/artist/album/duration 和同步质量评分，低于阈值不采用。
- LRCLIB 请求使用 `MPRIS Lyrics/5.0 (mpris-lyrics@eureka)` User-Agent，顺序发送并间隔
  300ms；429 最多重试一次且尊重 `Retry-After`。

## 设置键

- Panel：`show-icon`、`panel-position`、`max-panel-width`、`hide-when-paused`。
- Lyrics：`fallback-track-info`、`word-sync-enabled`、`global-offset-ms`。
- Translation：`translation-enabled`、`translation-target-language`、
  `translation-provider`、`translation-display-mode`、`auto-translate`、
  `panel-lyrics-language`。
- Player：`preferred-player` 只保存稳定 DesktopEntry/Identity policy；临时 MPRIS bus name
  不写入设置。
- Maintenance：credential 和 cache 变更通知使用独立 generation keys，不包含 secret。

静态视觉规则集中在 `stylesheet.css`；当前行状态、时间轴位置、运行时宽度和滚动位置由
JavaScript 控制。颜色、accent、symbolic icon 和 scrollbar 均继承 GNOME theme，不从
专辑封面提取颜色，也不硬编码深色/浅色前景。

## 上游接口

- [GNOME Shell 扩展 ESM 与模块](https://gjs.guide/extensions/overview/imports-and-modules.html)
- [GNOME Shell 50 移植说明](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)
- [MPRIS 2.2 Player 接口](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html)
- [LRCLIB API](https://lrclib.net/docs)
- [Lyricsfile 1.0 Draft Specification](https://github.com/tranxuanthang/lyricsfile/blob/main/SPECIFICATION.md)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
