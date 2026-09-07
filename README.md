# fart-alert

当 DeepSeek Harness（DSH）需要用户**授予权限**或进行**选择/确认**时，在电脑上播放放屁音效提醒用户。

音效**随插件内置**（`assets/fart.mp3`），开箱即用；也支持替换成你自己的音频文件。

## 触发时机

| 场景 | 触发事件 |
| --- | --- |
| 需要用户授予权限（文件/工具权限审批） | 会话事件 `approval/asked` |
| 模型调用 `ask_user_question` 提问（需要选择/确认/补充信息） | 工具调用 `tool/call`（name = `ask_user_question`） |
| 模型调用 `ask_user_vision` 提问（需要用户看图/描述） | 工具调用 `tool/call`（name = `ask_user_vision`） |
| 计划模式审核（`exit_plan_mode`，让用户批准计划） | 工具调用 `tool/call`（name = `exit_plan_mode`） |

## 安装

把插件包放到 DSH profile 的 `node_modules` 下（如 `C:\Users\你的用户名\.dsh\profiles\web-desktop\node_modules\fart-alert\`），并在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: fart-alert
      name: 'fart-alert'
```

重启 DSH 客户端后生效。

## 替换音效

默认使用内置音效，无需任何配置。想换成自己的音效时，在 patch 行的 `config` 里设置 `soundPath` 指向你的 WAV/MP3 文件：

```yaml
- insert:
    - id: fart-alert
      name: 'fart-alert'
      config:
        soundPath: 'D:\my-sounds\fart.wav' # 换成你自己的音效文件
```

其他可选配置：

```yaml
      config:
        enabled: true              # 总开关
        soundPath: 'D:\my-sounds\fart.wav' # 音效文件路径（WAV/MP3，省略=内置）
        playback: 'auto'           # 播放后端：auto（默认，优先 MCI）| mci | powershell
        playOnApproval: true       # 需要授予权限时播放
        playOnQuestion: true       # 需要选择/确认时播放
        minIntervalMs: 2000        # 两次播放最短间隔（毫秒）
```

音效文件必须是**包含实际音频数据**的文件；WAV 会校验 `data` 块字节数，MP3 会校验 ID3 标签或 MPEG 帧同步。文件缺失、无效或为空（0 字节音频数据）时会记警告日志并跳过播放，不会发出声音。

## 实现说明

- 纯 Node 内置模块实现（`node:child_process` / `node:fs` / `node:url` / `node:worker_threads`），无第三方依赖。
- **默认播放后端是 MCI**：在 worker 线程内用 `koffi`（DSH 桌面端自带的原生 FFI 库）直接调用 Windows 自带的 `winmm.dll` 播放音效。全程**进程内完成**——不启动子进程、不调用 Shell/PowerShell、不执行脚本，**不会被杀毒软件拦截**，也无需安装任何播放器。
- 若 `koffi` 不可用（`config.playback: 'powershell'` 或自动回退），则退回旧方案：通过 PowerShell（`System.Media.SoundPlayer` / WPF `MediaPlayer`）播放。注意：部分杀毒软件会拦截 PowerShell 执行，所以仅作回退。
- 默认音效通过 `import.meta.url` 定位到插件包内的 `assets/fart.mp3`，不依赖任何外部绝对路径。
- 订阅 `session/event` 全局事件流，不修改 DSH 内核任何行为。
- 内置防堆叠：同一时刻只允许一个播放，且受 `minIntervalMs` 节流。

## 许可证

插件代码为 MIT。内置音效 `assets/fart.mp3` 的版权归其原作者；如需在商业或需要授权的场合使用，请用 `soundPath` 替换为你自己的音效。
