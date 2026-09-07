# fart-alert

当 DeepSeek Harness（DSH）需要用户**授予权限**或进行**选择/确认**时，在电脑上播放放屁音效提醒用户。

## 触发时机

| 场景 | 触发事件 |
| --- | --- |
| 需要用户授予权限（文件/工具权限审批） | 会话事件 `approval/asked` |
| 模型调用 `ask_user_question` 提问（需要选择/确认/补充信息） | 工具调用 `tool/call`（name = `ask_user_question`） |
| 模型调用 `ask_user_vision` 提问（需要用户看图/描述） | 工具调用 `tool/call`（name = `ask_user_vision`） |
| 计划模式审核（`exit_plan_mode`，让用户批准计划） | 工具调用 `tool/call`（name = `exit_plan_mode`） |

## 配置

插件的 `config` 可写在 profile 的 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: fart-alert
      name: 'fart-alert'
      config:
        enabled: true              # 总开关
        soundPath: 'G:\放屁音效.mp3' # 音效文件路径（WAV/MP3）
        playOnApproval: true       # 需要授予权限时播放
        playOnQuestion: true       # 需要选择/确认时播放
        minIntervalMs: 2000        # 两次播放最短间隔（毫秒）
```

未填写时使用默认值（默认 `G:\放屁音效.mp3`）。音效文件必须是**包含实际音频数据**的文件；WAV 会校验 `data` 块字节数，MP3 会校验 ID3 标签或 MPEG 帧同步。文件缺失、无效或为空（0 字节音频数据）时会记警告日志并跳过播放，不会发出声音。

## 实现说明

- 纯 Node 内置模块实现（`node:child_process` / `node:fs`），无第三方依赖。
- 播放走 Windows PowerShell，隐藏窗口异步执行，不阻塞 DSH：WAV 用 `System.Media.SoundPlayer`（PlaySync 精确阻塞至播完），MP3 等其他格式用 WPF `System.Windows.Media.MediaPlayer`（异步播放后轮询到播完或超时）。
- 订阅 `session/event` 全局事件流，不修改 DSH 内核任何行为。
- 内置防堆叠：同一时刻只允许一个播放进程，且受 `minIntervalMs` 节流。
