# MPRIS Lyrics

MPRIS Lyrics 是一个面向 GNOME Shell 50 的极简扩展。它自动发现会话总线上的
`org.mpris.MediaPlayer2.*` 播放器，从 MPRIS 元数据查询 LRCLIB，并在顶部状态栏
显示当前一句同步歌词。

它不调用 `playerctl`，不使用 Spotify Web API、OAuth 或 Spotify track ID。Firefox
中的 Spotify Web 和暴露标准 MPRIS 的 Spotify Linux 客户端走同一条数据路径。

## 安装和调试

```sh
make check
make install
gnome-extensions enable mpris-lyrics@eureka
```

更新代码后可以运行：

```sh
make reload
```

事件驱动 MPRIS 调用计数和本地 HTTP 错误/取消测试：

```sh
make integration
```

有正在运行的 MPRIS 播放器且网络可用时，可以执行真实集成检查：

```sh
gjs -m tests/integration-current-player.js
```

`tests/integration-playback-sync.js` 是开发期行为测试：它会暂时控制当前播放器完成
Play/Pause/Resume 和前后 Seek，验证 monotonic 推算、暂停冻结和跳转校准，然后恢复
原状态与位置。

GNOME 50 的嵌套 Shell 生命周期检查使用打包后的 zip：

```sh
make check
dbus-run-session -- gnome-shell-test-tool --headless \
  --extension /tmp/mpris-lyrics@eureka.shell-extension.zip \
  tests/shell-extension.js
```

Wayland 会话中无法用 `Alt+F2` 后输入 `r` 重启 Shell。如果首次安装后当前 Shell
没有发现扩展，请注销并重新登录一次。查看本次登录的扩展日志：

```sh
journalctl --user -b -o cat | grep 'MPRIS Lyrics'
```

Fish 用户可直接运行上述命令；Makefile 内部使用 `make` 自己的变量语法。

## 结构

- `extension.js`：生命周期、选曲状态与歌词/UI 协调、逐歌词时间戳的一次性定时器。
- `mpris.js`：播放器发现和选择、D-Bus 信号、Position 单次校准和 monotonic 推算。
- `lyrics.js`：LRCLIB 异步请求、取消、限速/429 重试、内存缓存、LRC 解析与二分查找。
- `indicator.js`：GNOME 面板 UI、最大宽度和省略显示。

没有周期性 polling。播放器发现使用 `NameOwnerChanged`，状态更新使用
`PropertiesChanged`，跳转使用 `Seeked`；歌词显示只为下一条时间戳安排一次性本地
timer。暂停、恢复和换歌时会单次读取 Position 重新校准，Seeked 信号直接提供新的
Position 锚点。

## 行为

- 有同步歌词时显示 `♪ 当前歌词`。
- 查询中、无同步歌词、歌词开始前以及 LRC 的空白时间标签处显示
  `♪ Title — Artist`。
- 优先选择状态为 `Playing` 的播放器；没有正在播放的播放器时保留当前暂停播放器。
- 播放器全部消失或没有有效标题时隐藏面板项。
- LRCLIB 请求仅携带 title、artist、album 和以秒为单位的 duration。

## 上游接口

- [GNOME Shell 扩展 ESM 与模块](https://gjs.guide/extensions/overview/imports-and-modules.html)
- [GNOME Shell 50 移植说明](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)
- [MPRIS 2.2 Player 接口](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html)
- [LRCLIB API](https://lrclib.net/docs)
