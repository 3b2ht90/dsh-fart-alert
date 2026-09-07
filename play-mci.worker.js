// play-mci.worker.js
// 在 worker 线程内通过 koffi 直接调用 Windows 自带的 winmm.dll（MCI 接口）
// 播放音效。全程进程内完成：不启动子进程、不调用 Shell/PowerShell、不执行
// 脚本，因此不会被杀毒软件拦截。仅供 fart-alert 插件使用（index.js 通过
// new Worker() 启动本脚本，workerData.soundPath 为要播放的音频文件路径）。
import { parentPort, workerData } from 'node:worker_threads'

const { soundPath } = workerData ?? {}

const BUF_SIZE = 2048

/** 上报结果给主线程（先投递、稍等、再退出，确保消息送达）。 */
const finish = async (payload) => {
  parentPort.postMessage(payload)
  await new Promise((resolve) => setTimeout(resolve, 50))
  process.exit(0)
}

async function main() {
  let koffi
  try {
    const mod = await import('koffi')
    koffi = mod.default ?? mod
  } catch (error) {
    return finish({ ok: false, error: `koffi 加载失败（将回退 PowerShell 播放）: ${error?.message ?? error}` })
  }

  let winmm
  try {
    winmm = koffi.load('winmm.dll')
  } catch (error) {
    return finish({ ok: false, error: `winmm.dll 加载失败: ${error?.message ?? error}` })
  }

  const mciSendStringW = winmm.func('int mciSendStringW(const char16_t *command, void *buffer, int bufferLength, void *callback)')

  /** 执行一条 MCI 命令；失败时从返回缓冲区读出 MCI 错误说明。 */
  function mci(command) {
    const buffer = Buffer.alloc(BUF_SIZE)
    const code = mciSendStringW(command, buffer, BUF_SIZE / 2, null)
    if (code === 0) return { ok: true }
    let message = ''
    try {
      let end = 0
      while (end + 1 < BUF_SIZE && buffer.readUInt16LE(end) !== 0) end += 2
      message = buffer.subarray(0, end).toString('utf16le')
    } catch {}
    return { ok: false, code, message }
  }

  const alias = 'fartsnd'
  const lower = String(soundPath).toLowerCase()
  // WAV 用 waveaudio 设备；MP3 等其他格式用 mpegvideo（MCI 可自动解码）。
  const mediaType = lower.endsWith('.wav') ? 'waveaudio' : 'mpegvideo'
  const quoted = `"${String(soundPath).replace(/"/g, '""')}"`

  mci(`close ${alias}`) // 清理上一次可能残留的别名；未打开时本就不需要关闭
  const opened = mci(`open ${quoted} type ${mediaType} alias ${alias}`)
  if (!opened.ok) return finish({ ok: false, error: `MCI open 失败(${opened.code}): ${opened.message}` })
  // `wait` 让调用阻塞到播放结束，worker 线程内同步完成，不影响主线程。
  const played = mci(`play ${alias} wait`)
  mci(`close ${alias}`)
  if (!played.ok) return finish({ ok: false, error: `MCI play 失败(${played.code}): ${played.message}` })

  await finish({ ok: true })
}

main().catch((error) => finish({ ok: false, error: `worker 异常: ${error?.message ?? error}` }))
