import fs from 'fs'
import path from 'path'
import mineflayer from 'mineflayer'
import { loader as autoEatPlugin } from 'mineflayer-auto-eat'

process.on('uncaughtException', (err) => {
  console.error('Uncaught', err)
})
process.on('unhandledRejection', (err) => {
  console.error('Unhandled', err)
})

const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json')
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))

const host = cfg.host || 'mcfallout.net'
const port = Number(cfg.port || 25565)
const version = cfg.version || false
const envIsTermux = String(process.env.PREFIX || '').includes('/data/data/com.termux')
const checkTimeoutMs = Math.max(Number(cfg.checkTimeoutMs || 60000), envIsTermux ? 120000 : 60000)
const reconnectCfg = cfg.reconnect || {}
const baseDelay = Math.max(1, Number(reconnectCfg.baseDelaySeconds || 5)) * 1000
const maxDelay = Math.max(baseDelay, Number(reconnectCfg.maxDelaySeconds || 300)) * 1000
const rateLimitDelay = Math.max(60, Number(reconnectCfg.rateLimitDelaySeconds || 900)) * 1000
const jitterMs = Math.max(0, Number(reconnectCfg.jitterMs || 5000))
const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : []
const whitelist = new Set(Array.isArray(cfg.whitelist) ? cfg.whitelist : [])
const chatCfg = cfg.chat || { enabled: false }

const ensureDir = (p) => { try { fs.mkdirSync(p, { recursive: true }) } catch {} }
const profilesRoot = path.join(process.cwd(), 'profiles')
ensureDir(profilesRoot)

const createFor = (username) => {
  let attempts = 0
  let lastErrorText = ''
  let reconnectTimer = null
  let forceLongDelay = false
  let startedAt = 0
  const start = () => {
    if (reconnectTimer) { try { clearTimeout(reconnectTimer) } catch {} ; reconnectTimer = null }
    startedAt = Date.now()
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      version,
      checkTimeoutInterval: checkTimeoutMs,
      profilesFolder: profilesRoot,
      auth: 'microsoft',
      onMsaCode: (data) => {
        console.log(`[${username}] 請前往 ${data.verification_uri} 並輸入代碼 ${data.user_code}`)
      }
    })

    bot.loadPlugin(autoEatPlugin)

    bot.once('login', () => {
      attempts = 0
      console.log(`[${username}] 登入中...`)
    })

    bot.once('spawn', () => {
      console.log(`[${username}] 已登入伺服器`)
      if (bot.autoEat) {
        if (typeof bot.autoEat.setOpts === 'function') {
          bot.autoEat.setOpts({ priority: 'foodPoints', minHunger: 16 })
          if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto()
        } else {
          bot.autoEat.options = { priority: 'foodPoints', startAt: 16 }
          if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable()
        }
      }
      setupAutoChat(bot, username)
    })

    bot.on('health', () => {
      if (bot.autoEat) {
        const hungry = bot.food < 16
        if (typeof bot.autoEat.enableAuto === 'function' || typeof bot.autoEat.setOpts === 'function') {
          if (hungry && typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto()
          if (!hungry && typeof bot.autoEat.disableAuto === 'function') bot.autoEat.disableAuto()
        } else {
          if (hungry && typeof bot.autoEat.enable === 'function') bot.autoEat.enable()
          if (!hungry && typeof bot.autoEat.disable === 'function') bot.autoEat.disable()
        }
      }
    })

    bot.on('chat', (sender, message) => {
      if (whitelist.size > 0 && !whitelist.has(sender)) return
      handleCommand(bot, sender, message)
    })

    bot.on('message', (jsonMsg) => {
      const obj = typeof jsonMsg.toJSON === 'function' ? jsonMsg.toJSON() : jsonMsg
      const text = typeof jsonMsg.toString === 'function' ? jsonMsg.toString() : flattenText(obj)
      const cmds = extractRunCommands(obj)
      for (const c of cmds) {
        const s = String(c)
        if (s.toLowerCase().includes('agree') || s.includes('同意')) {
          safeChat(bot, s)
        }
      }
      const m1 = text && text.match(/^\[系統\]\s+(\S+)\s+想要傳送到\s+你\s+的位置$/)
      if (m1) {
        const sender = m1[1]
        if (whitelist.size === 0 || whitelist.has(sender)) {
          safeChat(bot, '/tpaccept')
        }
      }
      const m2 = text && text.match(/^\[系統\]\s+(\S+)\s+想要你傳送到\s+該玩家\s+的位置$/)
      if (m2) {
        const sender = m2[1]
        if (whitelist.size === 0 || whitelist.has(sender)) {
          safeChat(bot, '/tpaccept')
        }
      }
    })

    bot.on('windowOpen', (window) => {
      try {
        const idx = window.slots.findIndex(it => it && (
          String(it.name || '').toLowerCase().includes('agree') ||
          String(it.name || '').toLowerCase().includes('lime') ||
          String(it.name || '').toLowerCase().includes('green')
        ))
        if (idx >= 0) bot.clickWindow(idx, 0, 0)
      } catch {}
    })

    bot.on('kicked', (reason) => {
      const obj = typeof reason === 'string' ? { text: reason } : reason
      const text = sanitizeTail(flattenText(obj))
      const zh = sanitizeTail(translateReason(text))
      console.log(`[${username}] 已被伺服器踢出${zh ? '：' + zh : ''}`)
      schedule()
    })

    bot.on('end', () => {
      console.log(`[${username}] 已斷線`)
      try {
        if (bot._autoChatTimer) {
          clearInterval(bot._autoChatTimer)
          bot._autoChatTimer = null
        }
      } catch {}
      schedule()
    })

    bot.on('error', (err) => {
      lastErrorText = String(err && err.message ? err.message : err)
      console.error(`[${username}] 錯誤`, err)
      const m = lastErrorText.toLowerCase()
      if (
        m.includes('econnreset') ||
        m.includes('etimedout') ||
        m.includes('epipe') ||
        m.includes('socket hang up') ||
        m.includes('stream destroyed') ||
        m.includes('client timed out') ||
        m.includes('keepalive')
      ) {
        if (Date.now() - startedAt < 20000) forceLongDelay = true
        try { if (isConnected(bot)) bot.end('error') } catch {}
        schedule()
      }
    })

    const schedule = () => {
      if (reconnectTimer) return
      attempts += 1
      let delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempts - 1))
      if (forceLongDelay) { delay = Math.max(delay, rateLimitDelay); forceLongDelay = false }
      if (lastErrorText.includes('RateLimiter disallowed request')) delay = Math.max(delay, rateLimitDelay)
      delay += Math.floor(Math.random() * jitterMs)
      const secs = Math.ceil(delay / 1000)
      console.log(`[${username}] 將在 ${secs} 秒後重新連線`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        try {
          start()
        } catch (e) {
          console.error(`[${username}] 重新連線失敗`, e)
          schedule()
        }
      }, delay)
    }
  }
  start()
}

const setupAutoChat = (bot, username) => {
  if (!chatCfg.enabled) return
  const intervalMs = Math.max(5, Number(chatCfg.intervalSeconds || 60)) * 1000
  const messages = Array.isArray(chatCfg.messages) && chatCfg.messages.length > 0 ? chatCfg.messages : ['Hello']
  try {
    if (bot._autoChatTimer) {
      clearInterval(bot._autoChatTimer)
      bot._autoChatTimer = null
    }
  } catch {}
  let i = 0
  bot._autoChatTimer = setInterval(() => {
    const msg = messages[i % messages.length]
    safeChat(bot, msg)
    i++
  }, intervalMs)
}

const handleCommand = (bot, sender, message) => {
  const prefix = '!bot'
  if (!message || !message.startsWith(prefix)) return
  const parts = message.trim().split(/\s+/)
  const cmd = parts[1] || ''
  if (cmd === 'say') {
    const text = parts.slice(2).join(' ') || 'Hi'
    safeChat(bot, text)
  } else if (cmd === 'eat') {
    if (bot.autoEat) {
      if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto()
      else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable()
    }
  } else if (cmd === 'status') {
    safeChat(bot, `food=${bot.food} hp=${bot.health}`)
  } else if (cmd === 'agree') {
    safeChat(bot, '/agree')
  }
}

const initialStaggerMs = Math.max(0, Number(cfg.initialStaggerSeconds || 20)) * 1000
accounts.forEach((u, i) => {
  const d = i * initialStaggerMs + Math.floor(Math.random() * jitterMs)
  setTimeout(() => { try { createFor(u) } catch (e) { console.error(`[${u}] 啟動失敗`, e) } }, d)
})

const extractRunCommands = (msg) => {
  const out = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.clickEvent && node.clickEvent.action === 'run_command' && node.clickEvent.value) {
      out.push(node.clickEvent.value)
    }
    if (Array.isArray(node.extra)) for (const e of node.extra) visit(e)
    if (node.hoverEvent && node.hoverEvent.contents) visit(node.hoverEvent.contents)
  }
  visit(msg)
  return out
}

const flattenText = (node) => {
  if (!node) return ''
  if (typeof node === 'string') return node
  let s = ''
  if (node.text) s += node.text
  if (Array.isArray(node.extra)) for (const e of node.extra) s += flattenText(e)
  return s
}

const translateReason = (text) => {
  if (!text) return ''
  const ipMatch = text.match(/address\s*:\s*([^\s]+)/i)
  const ip = ipMatch ? ipMatch[1] : ''
  if (/logged in from another location/i.test(text)) {
    return ip ? `你的帳號於其他位置登入，IP：${ip}` : '你的帳號於其他位置登入'
  }
  return ''
}

const sanitizeTail = (s) => {
  if (!s) return s
  return String(s).replace(/"\}\],?\s*"text"\s*:\s*""\}?$/,'').trim()
}

const isConnected = (bot) => {
  try {
    return !!(bot && bot._client && bot._client.state === 'connected' && bot._client.socket && !bot._client.socket.destroyed)
  } catch {
    return false
  }
}

const safeChat = (bot, msg) => {
  try {
    if (isConnected(bot)) bot.chat(msg)
  } catch {}
}
