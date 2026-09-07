/**
 * fart-alert — DeepSeek Harness 插件
 *
 * 当 DSH 需要用户授予权限（approval/asked 会话事件）或需要用户进行
 * 选择/确认（ask_user_question / ask_user_vision 提问、exit_plan_mode
 * 计划审核）时，在电脑上播放放屁音效提醒用户。
 *
 * 默认播放随插件内置的音效（assets/fart.mp3）；通过 cordis.patch.yml 的
 * config.soundPath 可换成任意 WAV/MP3 文件（内置音效可被替换）。
 *
 * 播放策略（config.playback）：
 * - mci（首选）：在 worker 线程内用 koffi 直接调用 Windows 自带
 *   winmm.dll 的 MCI 接口播放。全程进程内完成，不启动子进程、不调用
 *   Shell/PowerShell、不执行脚本，不会被杀毒软件拦截。
 * - powershell：旧方案，通过 PowerShell（SoundPlayer / WPF MediaPlayer）
 *   播放，部分杀毒软件会拦截，仅作回退。
 * - auto（默认）：优先 MCI，koffi 不可用时回退到 PowerShell。
 *
 * koffi 是 DSH 桌面端自带的原生 FFI 库（profiles 共享依赖），无需额外安装。
 */

import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'fart-alert'

/** 需要用户输入/选择的工具调用名（对应 tool/call 会话事件）。 */
const QUESTION_TOOLS = Object.freeze([
  'ask_user_question',
  'ask_user_vision',
  'exit_plan_mode',
])

/** 随插件内置的默认音效（与 index.js 同目录的 assets/fart.mp3）。 */
const BUNDLED_SOUND = fileURLToPath(new URL('./assets/fart.mp3', import.meta.url))

/** MCI 播放 worker 脚本（与 index.js 同目录）。 */
const MCI_WORKER = new URL('./play-mci.worker.js', import.meta.url)

/** MCI 播放兜底超时（毫秒）：worker 卡住时强制终止，避免 playing 卡死。 */
const MCI_TIMEOUT_MS = 32000

/** 默认配置：与 cordis.patch.yml 的 config 块合并（patch 优先）。 */
const DEFAULTS = Object.freeze({
  /** 总开关：false 时完全不加载提醒监听。 */
  enabled: true,
  /** 提示音效文件路径（WAV/MP3）；省略时使用内置音效，可改为自己的文件路径以替换。 */
  soundPath: BUNDLED_SOUND,
  /** 播放后端：'auto'（默认，优先 MCI）| 'mci' | 'powershell'。 */
  playback: 'auto',
  /** 需要用户授予权限时播放。 */
  playOnApproval: true,
  /** 需要用户选择/确认（提问、计划审核）时播放。 */
  playOnQuestion: true,
  /** 两次播放的最短间隔（毫秒），防止连续提示时音效堆叠。 */
  minIntervalMs: 2000,
})

function resolveConfig(config = {}) {
  return { ...DEFAULTS, ...config }
}

/**
 * 读取 WAV 文件中 `data` chunk 的字节数；0 表示文件缺失、非 WAV 或没有任何
 * 实际音频数据（如仅有文件头的空文件）。用来避免“播放”一个无声空文件。
 * @param soundPath - WAV 文件路径。
 * @returns `data` chunk 的字节数，无效文件返回 0。
 */
function wavDataBytes(soundPath) {
  let bytes
  try {
    bytes = readFileSync(soundPath)
  } catch {
    return 0
  }
  if (bytes.length < 12) return 0
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'data') return size
    if (size > bytes.length - offset - 8) return 0
    offset += 8 + size
  }
  return 0
}

/**
 * 判断文件是否为可播放的 MP3：以 ID3 标签开头，或前 64KB 内存在 MPEG
 * 帧同步头（0xFF 0xEx/0xFx）。
 * @param soundPath - MP3 文件路径。
 * @returns 是否判定为有效的 MP3 音频。
 */
function mp3IsPlayable(soundPath) {
  let bytes
  try {
    bytes = readFileSync(soundPath)
  } catch {
    return false
  }
  if (bytes.length < 2) return false
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return true
  const scan = Math.min(bytes.length - 1, 65536)
  for (let i = 0; i < scan; i += 1) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return true
  }
  return false
}

function soundIsPlayable(soundPath) {
  try {
    if (!existsSync(soundPath) || !statSync(soundPath).isFile()) return false
    const size = statSync(soundPath).size
    if (size <= 0) return false
    const lower = String(soundPath).toLowerCase()
    if (lower.endsWith('.wav')) return wavDataBytes(soundPath) > 0
    if (lower.endsWith('.mp3')) return mp3IsPlayable(soundPath)
    // 其他扩展名：文件非空即尝试播放（MCI 支持常见音频格式）。
    return true
  } catch {
    return false
  }
}

function powerShellExecutable() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * 构建播放 MP3 等非 WAV 音频的 PowerShell 命令（仅回退方案）：WPF
 * MediaPlayer 异步播放，轮询直到播完（NaturalDuration 可得时）或超时
 * （30 秒）退出。
 * @param soundPath - 已校验可播放的音频文件路径。
 * @returns PowerShell 命令字符串。
 */
function mediaPlayerCommand(soundPath) {
  const escaped = String(soundPath).replace(/'/g, "''")
  return [
    'Add-Type -AssemblyName PresentationCore',
    '$m = New-Object System.Windows.Media.MediaPlayer',
    '$m.Volume = 1.0',
    `$m.Open([System.Uri]'${escaped}')`,
    '$m.Play()',
    '$deadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Date) -lt $deadline) {',
    '  Start-Sleep -Milliseconds 200',
    '  if ($m.NaturalDuration.HasTimeSpan -and $m.NaturalDuration.TimeSpan.TotalSeconds -gt 0 -and $m.Position -ge $m.NaturalDuration.TimeSpan) { break }',
    '}',
    '$m.Close()',
  ].join('; ')
}

/**
 * 回退方案：异步启动一个隐藏的 PowerShell 进程播放音效。
 * @param soundPath - 已校验可播放的音频文件路径。
 * @returns 子进程句柄（ChildProcess）。
 */
function playViaPowershell(soundPath) {
  const quoted = `'${String(soundPath).replace(/'/g, "''")}'`
  const lower = String(soundPath).toLowerCase()
  // WAV 用 SoundPlayer 的 PlaySync（精确阻塞至播完）；其余格式用 WPF MediaPlayer。
  const command = lower.endsWith('.wav')
    ? `(New-Object System.Media.SoundPlayer ${quoted}).PlaySync()`
    : mediaPlayerCommand(soundPath)
  return spawn(powerShellExecutable(), [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command', command,
  ], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

/** koffi 是否可用（惰性探测，结果缓存）。 */
let mciAvailable = null
async function mciPlaybackAvailable() {
  if (mciAvailable !== null) return mciAvailable
  try {
    await import('koffi')
    mciAvailable = true
  } catch {
    mciAvailable = false
  }
  return mciAvailable
}

/**
 * 首选方案：在 worker 线程内用 koffi + winmm.dll（MCI）播放音效。
 * 进程内完成，无子进程/Shell/PowerShell，杀毒软件不会拦截。返回 Worker，
 * 沿用与子进程一致的 'error'/'exit' 事件接口；播放失败经 'message' 上报。
 * @param soundPath - 已校验可播放的音频文件路径。
 * @param logger - 日志对象。
 * @returns worker 实例（Worker）。
 */
function playViaMci(soundPath, logger) {
  const worker = new Worker(MCI_WORKER, {
    workerData: { soundPath },
    name: 'fart-alert-mci',
  })
  worker.once('message', (message) => {
    if (message && message.ok === false) {
      logger.warn?.(`[fart-alert] MCI 播放失败: ${message.error ?? '未知错误'}`)
    }
  })
  const timer = setTimeout(() => {
    worker.terminate().catch(() => {})
  }, MCI_TIMEOUT_MS)
  worker.once('exit', () => clearTimeout(timer))
  return worker
}

/**
 * 按 playback 配置分发到对应播放后端。
 * @param soundPath - 已校验可播放的音频文件路径。
 * @param cfg - 合并后的插件配置。
 * @param logger - 日志对象。
 * @returns Worker 或 ChildProcess（均带 'error'/'exit' 事件）。
 */
async function playSound(soundPath, cfg, logger) {
  if (cfg.playback === 'powershell') return playViaPowershell(soundPath)
  if (cfg.playback === 'mci' || (await mciPlaybackAvailable())) return playViaMci(soundPath, logger)
  return playViaPowershell(soundPath)
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const logger = ctx.logger ?? console

  if (cfg.enabled !== true) {
    logger.info?.('[fart-alert] 已禁用，不加载提醒监听')
    return
  }

  let lastPlayedAt = 0
  let playing = false

  const trigger = async () => {
    if (playing) return
    const now = Date.now()
    if (now - lastPlayedAt < cfg.minIntervalMs) return
    if (!soundIsPlayable(cfg.soundPath)) {
      logger.warn?.(
        `[fart-alert] 音效文件不可播放（缺失、空文件或格式无效）：${cfg.soundPath}。`
        + '请放入有效的 WAV/MP3 音频文件后重试。',
      )
      return
    }
    lastPlayedAt = now
    playing = true
    let child
    try {
      child = await playSound(cfg.soundPath, cfg, logger)
    } catch (error) {
      playing = false
      logger.warn?.(`[fart-alert] 启动播放失败: ${error?.message ?? error}`)
      return
    }
    child.once('error', (error) => {
      playing = false
      logger.warn?.(`[fart-alert] 播放进程异常: ${error?.message ?? error}`)
    })
    child.once('exit', () => {
      playing = false
    })
  }

  // 订阅所有会话事件，只对“需要用户授权/选择”的事件触发音效。
  // `{ global: true }` 使用未加作用域的总线，兼容被 Loader 放入作用域组合的加载方式。
  const offEvent = ctx.on('session/event', (_session, event) => {
    if (event.type === 'approval/asked') {
      if (cfg.playOnApproval) trigger()
      return
    }
    if (event.type === 'tool/call' && cfg.playOnQuestion) {
      const toolName = event.data?.name
      if (QUESTION_TOOLS.includes(toolName)) trigger()
    }
  }, { global: true })

  // 启动时探测并记录播放后端。
  mciPlaybackAvailable().then((ok) => {
    logger.info?.(`[fart-alert] 播放后端：${ok ? 'MCI (koffi+winmm，进程内)' : 'PowerShell（回退）'}`)
  }).catch(() => {})

  logger.info?.('[fart-alert] 已启用：授权/选择时播放放屁音效提醒')

  ctx.effect(() => () => {
    offEvent?.()
  })
}
