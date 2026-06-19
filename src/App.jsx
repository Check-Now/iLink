import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Users, User, Send, Pencil, Check, ShieldCheck, Lock, Settings, X, Flame, EyeOff, Minus, Plus, Sun, Monitor, Info, Search, Smile, Paperclip, File as FileIcon, Reply, Undo2, Forward, Pin, Bell, BellOff, Trash2, Hand, Upload, Image as ImageIcon, Type, RefreshCw, CircleHelp, Network, UserPlus, Crown, ChevronDown, Copy, Camera, History, CheckCheck, Clock, AlertCircle, Folder, FolderPlus, Download, ArrowLeft, ChevronRight, HardDrive, FolderOpen, WifiOff } from 'lucide-react'

const api = window.api
const FIELD = 'field w-full rounded-lg px-3 py-2 text-sm outline-none'
const EMOJIS = [
  '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 🤩 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🫣 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠',
  '😈 👿 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🙏 ✍️ 💅 💪 🦾 🧠 🫀 🫁 👀 👁️ 👅 👄 💋',
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 💯 🔥 ✨ 🌟 ⭐ 💫 💥 💢 💦 💨 💬 🗨️ 🗯️ 💭 💤 🎉 🎊 🎈 🎁 🏆 🥇 🥈 🥉',
  '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❕ ❗ 〰️ ⚠️ 🚫 ⛔ ♻️ 🔰 🆗 🆕 🆙 🆒 🆓 🆚 🈯 🔒 🔓 🔔 🔕 📢 📣 📌 📎 💡 ⏰ ⏳',
  '🌈 ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌙 🌛 🌜 🌟 🌊 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥝 🍅 🥑 🍔 🍟 🍕 🌭 🍿 🧋 ☕ 🍺 🍻 🥂 🍰 🍫 🍭',
  '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐬 🐳 🐟 🐙 🦕 🚀 ✈️ 🚗 🚕 🚌 🚲 🛵 🏠 🏢 🏫 🏥 🎮 🎲 🎯 🎵 🎶 🎤 🎧 🎬 📷',
].join(' ').split(' ')
const EMOJI_BATCH = 64
const STICKER_BATCH = 24
const AVATAR_PRESETS = ['#34c759', '#007aff', '#ff9500', '#ff2d55', '#af52de', '#5ac8fa', '#5856d6', '#8e8e93']
// GIF 头像可动态同步的上限：base64 dataUrl ≤ 32KB（约 24KB 文件），与 UDP 广播包预算一致；超过则转静态
const ANIMATED_GIF_MAX_CHARS = 32 * 1024
const ANIMATED_GIF_MAX_KB = 24
const MSG_PAGE = 60 // 消息懒加载：每页渲染数量
// 个人状态：绿色在线 / 红色忙碌 / 灰色离开
const PRESENCE = [
  { key: 'online', label: '在线', color: '#30d158' },
  { key: 'busy', label: '忙碌', color: '#ff453a' },
  { key: 'away', label: '离开', color: '#8e8e93' },
  { key: 'dnd', label: '免打扰', color: '#bf5af2' }, // 全局免打扰：禁止一切消息通知
]
// 取联系人/成员的展示状态：离线灰色，在线时按对方广播的 presence 显示
function presenceOf (p) {
  if (!p || !p.online) return { key: 'offline', label: '离线', color: '#8e8e93' }
  return PRESENCE.find((x) => x.key === p.presence) || PRESENCE[0]
}

function fmtTime (ts) { try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch (_) { return '' } }

function dayLabel (ts) {
  const d = new Date(ts); const now = new Date()
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, now)) return '今天'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (same(d, y)) return '昨天'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function avatarColor (key) {
  let h = 0; const s = key || '?'
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 55% 50%)`
}
function avatarImageStyle (avatar) {
  const zoom = Math.max(100, Math.min(240, avatar && avatar.zoom ? avatar.zoom : 120))
  const x = Math.max(0, Math.min(100, avatar && avatar.x != null ? avatar.x : 50))
  const y = Math.max(0, Math.min(100, avatar && avatar.y != null ? avatar.y : 50))
  return { backgroundImage: `url("${avatar.imageDataUrl}")`, backgroundSize: zoom + '%', backgroundPosition: x + '% ' + y + '%' }
}
// 动图静态展示：开启后 GIF 取首帧渲染（设置项 staticGif，由 ChatScreen 每次渲染同步）
let STATIC_GIF = false
const gifStaticCache = new Map() // gif dataUrl -> 首帧静态 dataUrl
function useStaticGifSrc (src) {
  const [, force] = useState(0)
  const freeze = STATIC_GIF && typeof src === 'string' && /^data:image\/gif/i.test(src)
  useEffect(() => {
    if (!freeze || gifStaticCache.has(src)) return
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height
        c.getContext('2d').drawImage(img, 0, 0)
        gifStaticCache.set(src, c.toDataURL('image/png'))
      } catch (_) { gifStaticCache.set(src, src) }
      force((v) => v + 1)
    }
    img.onerror = () => { gifStaticCache.set(src, src); force((v) => v + 1) }
    img.src = src
  }, [src, freeze])
  if (!freeze) return src
  return gifStaticCache.get(src) || src
}
function StaticImg ({ src, ...rest }) {
  const shown = useStaticGifSrc(src)
  return <img src={shown} {...rest} />
}

function Avatar ({ name, id, size = 30, dim, avatar }) {
  const imgSrc = useStaticGifSrc(avatar && avatar.type === 'image' ? avatar.imageDataUrl : null)
  if (avatar && avatar.type === 'image' && avatar.imageDataUrl) {
    return <div className="avatar bg-center bg-no-repeat" style={{ width: size, height: size, opacity: dim ? 0.5 : 1, ...avatarImageStyle({ ...avatar, imageDataUrl: imgSrc }) }} />
  }
  const ch = (name || '?').trim().slice(0, 1).toUpperCase() || '?'
  const text = avatar && avatar.type === 'text' && avatar.text ? avatar.text.trim().slice(0, 2).toUpperCase() : ch
  const bg = avatar && (avatar.type === 'text' || avatar.type === 'preset') && avatar.color ? avatar.color : avatarColor(id || name)
  return <div className="avatar" style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.42), opacity: dim ? 0.5 : 1 }}>{text}</div>
}

function resolveTheme (t) {
  if (t === 'light' || t === 'dark') return t
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
}
function applyDisplay (d) {
  const root = document.documentElement
  root.setAttribute('data-theme', resolveTheme(d.theme))
  root.setAttribute('data-style', d.uiStyle || 'classic')
  root.style.setProperty('--font-px', (d.fontPx || 15) + 'px')
  root.style.setProperty('--chat-font', d.chatFont && d.chatFont.trim() ? d.chatFont : 'inherit')
  root.style.setProperty('--chat-font-px', (d.chatFontPx || 13.5) + 'px') // 仅作用于聊天气泡
}

// 聊天字体：五种常见中文字体（Windows 自带）
const CHAT_FONTS = [
  { label: '微软雅黑', family: '"Microsoft YaHei", sans-serif' },
  { label: '宋体', family: 'SimSun, serif' },
  { label: '黑体', family: 'SimHei, sans-serif' },
  { label: '楷体', family: 'KaiTi, serif' },
  { label: '仿宋', family: 'FangSong, serif' },
]

// 聊天 UI 风格：仅换肤，不改排版。colors 用于预览；classic 为经典样式。
const UI_STYLES = [
  { key: 'classic', label: '经典', colors: ['#7c86f0', '#1a1c28'] },
  { key: 'minimal', label: '极简', colors: ['#1d7bff', '#ffffff'] },
  { key: 'material', label: '材料', colors: ['#7c4dff', '#fafafa'] },
  { key: 'dark', label: '暗色', colors: ['#7c5cff', '#0a0a0c'] },
  { key: 'skeuo', label: '拟物', colors: ['#4caf50', '#e8dec9'] },
  { key: 'glass', label: '磨砂', colors: ['#a855f7', '#1a1030'] },
  { key: 'flat', label: '扁平', colors: ['#00897b', '#ffffff'] },
  { key: 'neu', label: '柔和', colors: ['#5b7cfa', '#e6e9f0'] },
  { key: 'gradient', label: '渐变', colors: ['#8b5cf6', '#f649a7'] },
  { key: 'card', label: '卡片', colors: ['#1d7bff', '#e9ecf1'] },
  { key: 'hand', label: '手绘', colors: ['#2b2b2b', '#fdf6e3'] },
]

function WinBtns () {
  if (!api || !api.win) return null
  return (
    <div className="win-controls no-drag flex items-center">
      <button className="win-btn" title="最小化" onClick={() => api.win.minimize()}><Minus size={14} /></button>
      <button className="win-btn" title="最大化/还原" onClick={() => api.win.maximize()}><Plus size={14} /></button>
      <button className="win-btn win-close" title="关闭" onClick={() => api.win.close()}><X size={14} /></button>
    </div>
  )
}
function TopBar ({ self, onGlobalSearch }) {
  return (
    <div className="titlebar glass-bar flex items-center gap-3 px-4 border-b bd-soft shrink-0" style={{ height: 46 }}>
      <span className="text-[13px] font-semibold txt">iLink</span>
      <span className="inline-flex items-center gap-1.5 text-[11.5px] accent-txt px-2.5 py-1 rounded-full font-semibold" style={{ background: 'var(--accent-tint)' }}>
        <Lock size={11} strokeWidth={2.5} /> 端到端加密
      </span>
      {self && self.localIp && (
        <span className="text-[11px] shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: 'var(--hover)' }}>
          <span className="txt-dim">IP</span>
          <span className="txt font-mono tracking-wide">{self.localIp}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {onGlobalSearch && (
          <button onClick={onGlobalSearch} className="btn-ghost no-drag shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] txt-dim">
            <Search size={13} /> 全局搜索
          </button>
        )}
        <WinBtns />
      </div>
    </div>
  )
}

function Center ({ children }) { return <div className="flex-1 flex items-center justify-center p-8">{children}</div> }
function Badge ({ n, corner, muted }) {
  if (!n) return null
  // corner:瑙掓爣妯″紡,璐村湪头像鍙充笂瑙?muted:免打扰会话用灰色弱化
  return (
    <span
      className={(corner ? 'absolute -top-1 -right-1 z-10 min-w-[16px] h-[16px] text-[9.5px] ' : 'ml-auto min-w-[18px] h-[18px] text-[10px] ') + (muted ? 'badge-muted ' : 'bg-red-500 ') + 'badge-pop px-1 rounded-full text-white font-medium flex items-center justify-center'}
      style={corner ? { boxShadow: '0 0 0 2px rgb(var(--panel-rgb))' } : undefined}
    >{n > 99 ? '99+' : n}</span>
  )
}
function GroupAvatar ({ group, size = 30 }) {
  if (group && group.avatar) return <Avatar name={group.name || '群'} id={group.id} avatar={group.avatar} size={size} />
  return <div className="avatar" style={{ width: size, height: size, background: "linear-gradient(135deg, var(--accent), #8e8ff1)" }}><Users size={Math.round(size / 2)} color="#fff" /></div>
}
function Toggle ({ on, onClick }) {
  return <button onClick={onClick} className={'w-10 h-5 rounded-full transition relative shrink-0 ' + (on ? 'bg-emerald-500' : 'bg-black/20')}><span className={'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ' + (on ? 'left-5' : 'left-0.5')} /></button>
}
function Row ({ label, hint, children }) {
  return <div className="flex items-center justify-between py-2 gap-3"><div><div className="text-sm txt">{label}</div>{hint && <div className="text-[11px] txt-dim">{hint}</div>}</div>{children}</div>
}
// 设置：功能卡片，与整体磨砂风格一致
function SettingsCard ({ title, icon: Icon, danger, children }) {
  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: 'var(--hover)', border: '1px solid var(--border-soft)' }}>
      {title && <div className={'text-[11px] uppercase tracking-wide mb-1 inline-flex items-center gap-1.5 ' + (danger ? 'text-red-400/80' : 'txt-dim')}>{Icon && <Icon size={13} />} {title}</div>}
      {children}
    </div>
  )
}
function Overlay ({ children, onClose, closeOnBackdrop = true }) {
  return (
    <div
      className="floating-overlay"
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div onClick={(e) => e.stopPropagation()} className="floating-overlay-inner">
        {children}
      </div>
    </div>
  )
}
function ConfirmDialog ({ title, text, confirmText = '确认', onConfirm, onClose }) {
  return (
    <Overlay onClose={onClose} closeOnBackdrop={false}>
      <div className="floating-dialog floating-dialog-sm floating-surface glass-panel floating-dialog-pad" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="text-sm font-semibold txt floating-long-text">{title}</div>
        <div className="mt-2 floating-subtle floating-long-text">{text}</div>
        <div className="floating-actions">
          <button onClick={onClose} className="btn-ghost text-sm rounded-lg px-3 py-1.5">取消</button>
          <button onClick={onConfirm} className="bg-red-500 text-white text-sm rounded-lg px-3 py-1.5">{confirmText}</button>
        </div>
      </div>
    </Overlay>
  )
}

// 用 canvas 将任意可显示图片压成正方形 JPEG，兼容 webp/gif 等 nativeImage 不支持的格式
function compressImageDataUrl (dataUrl, size = 96, quality = 0.78) {
  return new Promise((resolve) => {
    try {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = size; canvas.height = size
          const ctx = canvas.getContext('2d')
          const s = Math.min(img.width, img.height) // 居中裁剪成正方形
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch (_) { resolve(null) }
      }
      img.onerror = () => resolve(null)
      img.src = dataUrl
    } catch (_) { resolve(null) }
  })
}

// 复制文本：优先 Clipboard API，失败时回退 execCommand
function copyText (text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      return
    }
  } catch (_) {}
  fallbackCopy(text)
}
function fallbackCopy (text) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch (_) {}
}

function fmtSize (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i]
}
// 传输速度与剩余时间展示
function fmtSpeed (bps) { return (!bps || bps < 1) ? '' : fmtSize(bps) + '/s' }
function fmtEta (sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return ''
  if (sec < 1) return '即将完成'
  if (sec < 60) return '剩余 ' + Math.ceil(sec) + ' 秒'
  if (sec < 3600) return '剩余 ' + Math.ceil(sec / 60) + ' 分钟'
  return '剩余 ' + Math.ceil(sec / 3600) + ' 小时'
}

function FileMsg ({ m, progress, onAccept, onReject, onCancel, onRetry, selfAvatar, peerAvatar, avatarSpacer, hideMeta, metaReactions }) {
  const isImg = m.mime && m.mime.indexOf('image/') === 0
  const offer = m.type === 'file-offer'
  const pct = progress && progress.size ? Math.min(100, Math.round((progress.received / progress.size) * 100)) : null
  const avatarName = m.self ? '?' : (m.name || '')
  const avatarId = m.self ? (m.from || 'self') : (m.from || m.name || '')
  const avatarData = m.self ? selfAvatar : (peerAvatar || m.avatar)
  const rx = metaReactions !== undefined ? metaReactions : (m.reactions || {})
  const avEl = avatarSpacer ? <span className="avatar-spacer" /> : <Avatar name={avatarName} id={avatarId} avatar={avatarData} size={34} />
  return (
    <div className={'group message-row ' + (m.self ? 'message-row-self' : 'message-row-other')}>
      {!m.self && avEl}
      <div className="message-stack max-w-[75%]">
        <div className={'rounded-2xl px-3 py-2 text-sm ' + (m.self ? 'bubble-self' : 'bubble-other')}>
        {(m.scope === 'group' || m.scope === 'room') && !m.self && m.name && <div className="text-[11px] font-medium accent-txt mb-0.5">{m.name}</div>}
        {isImg && m.dataUrl ? (
          <StaticImg src={m.dataUrl} alt={m.fname} onClick={() => !m.sticker && m.path && api.file.open(m.path)} className={'rounded-lg max-w-[240px] max-h-60 object-contain' + (m.sticker ? '' : ' cursor-pointer')} />
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(0,0,0,0.18)' }}><FileIcon size={18} /></div>
            <div className="min-w-0"><div className="truncate font-medium">{m.fname}</div><div className="text-[11px] opacity-70">{fmtSize(m.size)}</div></div>
          </div>
        )}
        {pct != null && pct < 100 && <div className="mt-1 h-1 rounded bg-black/20 overflow-hidden"><div className="h-full bg-white/70" style={{ width: pct + '%' }} /></div>}
        {pct != null && pct < 100 && progress && progress.speed > 0 && <div className="mt-0.5 text-[10px] opacity-70">{fmtSpeed(progress.speed)}{progress.eta != null ? ' · ' + fmtEta(progress.eta) : ''}</div>}
        {m.self && m.scope === 'private' && pct != null && pct < 100 && onCancel && <button onClick={() => onCancel(m.mid)} className="mt-1 block text-[11px] opacity-80 hover:underline">取消</button>}
        {m.self && m.scope === 'private' && m.status === 'failed' && <button onClick={() => onRetry && onRetry(m)} className="mt-1 block text-[11px] text-red-300 hover:underline">发送失败 · 重试</button>}
        {m.self && m.scope === 'private' && m.status === 'queued' && pct == null && <div className="mt-1 text-[10px]" style={{ color: '#f59e0b' }}>待发送 · 对方上线后自动发送</div>}
        {offer && <div className="mt-2 flex gap-2"><button onClick={() => onAccept(m.mid)} className="btn-primary text-xs rounded px-2 py-1">接收</button><button onClick={() => onReject(m.mid)} className="btn-ghost text-xs rounded px-2 py-1">拒绝</button></div>}
          {!offer && m.path && !m.sticker && <div className="mt-1 flex gap-3 text-[11px] opacity-70"><button onClick={() => api.file.open(m.path)} className="hover:underline">打开</button><button onClick={() => api.file.showInFolder(m.path)} className="hover:underline">打开所在文件夹</button></div>}
        </div>
        {!hideMeta && (
          <div className="message-meta">
            {Object.keys(rx).length > 0 && (
              <div className="message-reactions">{Object.entries(rx).map(([e, ids]) => <span key={e} className="message-reaction">{e} {ids.length}</span>)}</div>
            )}
            <span className="message-time">{fmtTime(m.ts)}</span>
          </div>
        )}
      </div>
      {m.self && avEl}
    </div>
  )
}

function BatchMsg ({ items, markdown, showName, selfAvatar, peerAvatar, progressMap, flashMid, onCtx, avatarSpacer, hideMeta, metaReactions, mentionNames }) {
  const first = items[0]
  const selfMsg = !!first.self
  const texts = items.filter((x) => x.type !== 'file' && x.type !== 'file-offer' && x.text)
  const allFiles = items.filter((x) => x.type === 'file')
  const imgs = allFiles.filter((f) => f.mime && f.mime.indexOf('image/') === 0 && f.dataUrl)
  const others = allFiles.filter((f) => !(f.mime && f.mime.indexOf('image/') === 0 && f.dataUrl))
  const avatarName = selfMsg ? '?' : (first.name || '')
  const avatarId = selfMsg ? (first.from || 'self') : (first.from || first.name || '')
  const avatarData = selfMsg ? selfAvatar : (peerAvatar || first.avatar)
  // 合并所有条目的表情回应，外部传入 metaReactions 时优先使用
  let reactions = {}
  if (metaReactions !== undefined) reactions = metaReactions
  else {
    for (const it of items) {
      for (const [e, ids] of Object.entries(it.reactions || {})) {
        reactions[e] = Array.from(new Set([...(reactions[e] || []), ...ids]))
      }
    }
  }
  const ctxProps = (m) => ({ 'data-mid': m.mid || undefined, onContextMenu: (e) => onCtx && onCtx(m, e) })
  const avEl = avatarSpacer ? <span className="avatar-spacer" /> : <Avatar name={avatarName} id={avatarId} avatar={avatarData} size={34} />
  return (
    <div className={'message-row ' + (selfMsg ? 'message-row-self' : 'message-row-other')}>
      {!selfMsg && avEl}
      <div className="message-stack max-w-[75%]">
        {/* 无文字时，群内昵称单独显示在附件上方 */}
        {showName && texts.length === 0 && <div className="text-[11px] font-medium accent-txt">{first.name}</div>}
        {/* 绗竴琛?图片缂╃暐鍥?*/}
        {imgs.length > 0 && (
          <div className="batch-grid batch-grid-bare">
            {imgs.map((f) => (
              <img key={f.mid} {...ctxProps(f)} src={f.dataUrl} alt={f.fname} title={f.fname} onClick={() => f.path && api.file.open(f.path)} className={'batch-thumb ' + (flashMid === f.mid ? 'msg-flash-outline' : '')} />
            ))}
          </div>
        )}
        {/* 第二行：其他文件 */}
        {others.length > 0 && (
          <div className="batch-grid batch-grid-bare">
            {others.map((f) => {
              const prog = progressMap[f.mid]
              const pct = prog && prog.size ? Math.min(100, Math.round((prog.received / prog.size) * 100)) : null
              return (
                <button key={f.mid} {...ctxProps(f)} onClick={() => f.path && api.file.open(f.path)} title={f.fname} className={'batch-file batch-file-card ' + (flashMid === f.mid ? 'msg-flash-outline' : '')}>
                  <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent-tint)' }}><FileIcon size={14} className="accent-txt" /></span>
                  <span className="min-w-0 text-left">
                    <span className="block truncate max-w-[150px]">{f.fname}</span>
                    <span className="block opacity-70 text-[10px]">{fmtSize(f.size)}</span>
                  </span>
                  {pct != null && pct < 100 && <span className="batch-file-progress" style={{ width: pct + '%' }} />}
                </button>
              )
            })}
          </div>
        )}
        {/* 聊天气泡：只放文字消息 */}
        {texts.length > 0 && (
          <div className={'rounded-2xl px-3 py-2 text-sm ' + (selfMsg ? 'bubble-self' : 'bubble-other')}>
            {showName && <div className="text-[11px] font-medium accent-txt mb-0.5">{first.name}</div>}
            {texts.map((t) => (
              <div key={t.mid} {...ctxProps(t)} className={'whitespace-pre-wrap break-words ' + (flashMid === t.mid ? 'msg-flash' : '')}>{renderRich(t.text || '', markdown, mentionNames)}</div>
            ))}
          </div>
        )}
        {!hideMeta && (
          <div className="message-meta">
            {Object.keys(reactions).length > 0 && (
              <div className="message-reactions">{Object.entries(reactions).map(([e, ids]) => <span key={e} className="message-reaction">{e} {ids.length}</span>)}</div>
            )}
            <span className="message-time">{fmtTime(first.ts)}</span>
          </div>
        )}
      </div>
      {selfMsg && avEl}
    </div>
  )
}

// 合并同一发送分组内所有消息的表情回应
function mergeMessageReactions (units) {
  const out = {}
  for (const u of units) {
    for (const it of u.items) {
      for (const [e, ids] of Object.entries(it.reactions || {})) {
        out[e] = Array.from(new Set([...(out[e] || []), ...ids]))
      }
    }
  }
  return out
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉']
function openUrl (u) { if (api && api.sys) api.sys.openExternal(u) }

function cleanMentionName (name) {
  return String(name || '').trim().replace(/[，,。.!！?？:：;；）)]$/g, '')
}

function textMentionsNames (text, names) {
  const set = new Set((names || []).map((x) => cleanMentionName(x)).filter(Boolean))
  if (!set.size) return false
  const tokens = String(text || '').match(/@[^\s@]{1,32}/g) || []
  return tokens.some((tok) => {
    const name = cleanMentionName(tok.slice(1))
    const low = name.toLowerCase()
    for (const it of set) {
      if (name === it || low === it.toLowerCase()) return true
    }
    return false
  })
}

function isShareEntryMessage (m) {
  return !!(m && m.share && m.share.type === 'share-entry')
}

function localizeMentionToken (tok, mentionNames) {
  const raw = String(tok || '').slice(1)
  const base = cleanMentionName(raw)
  const suffix = raw.slice(base.length)
  const shown = (mentionNames && mentionNames[base]) || base
  return '@' + shown + suffix
}

function localizeMentionsText (text, mentionNames) {
  if (!mentionNames) return text || ''
  return String(text || '').replace(/@[^\s@]{1,32}/g, (tok) => localizeMentionToken(tok, mentionNames))
}

function localizeKnownNamesText (text, names) {
  let out = String(text || '')
  const entries = Object.entries(names || {}).filter(([from, to]) => from && to && from !== to).sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of entries) out = out.split(from).join(to)
  return out
}

function renderRich (text, markdown, mentionNames) {
  const out = []
  let key = 0
  const re = markdown
    ? /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|https?:\/\/[^\s]+|@[^\s@]{1,24})/g
    : /(https?:\/\/[^\s]+|@[^\s@]{1,24})/g
  let last = 0; let mt
  re.lastIndex = 0
  while ((mt = re.exec(text)) !== null) {
    if (mt.index > last) out.push(<span key={key++}>{text.slice(last, mt.index)}</span>)
    const tok = mt[0]
    if (/^https?:\/\//.test(tok)) out.push(<a key={key++} onClick={() => openUrl(tok)} className="underline cursor-pointer break-all">{tok}</a>)
    else if (tok[0] === '@') out.push(<span key={key++} className="mention">{localizeMentionToken(tok, mentionNames)}</span>)
    else if (markdown && tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (markdown && tok[0] === '`') out.push(<code key={key++} className="px-1 rounded" style={{ background: 'rgba(0,0,0,0.2)' }}>{tok.slice(1, -1)}</code>)
    else if (markdown && tok[0] === '*') out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    else out.push(<span key={key++}>{tok}</span>)
    last = mt.index + tok.length
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>)
  return out
}

// 历史加载:把残留的“发送中”归一为“已发送”(重启后不应再卡在发送中)
function normalizeHistory (h) {
  for (const k of Object.keys(h || {})) {
    const arr = h[k]
    if (!Array.isArray(arr)) continue
    for (const m of arr) { if (m && m.self && m.status === 'sending') m.status = 'sent' }
  }
  return h
}

// 私聊消息发送状态:发送中/已发送/已送达/失败(可重试)
function MsgStatus ({ m, onRetry }) {
  if (!m || !m.self || m.burn || !m.status) return null
  const s = m.status
  if (s === 'queued') return <Clock size={11} className="message-status" style={{ color: '#f59e0b' }} title="对方离线，已暂存，上线后自动发送" />
  if (s === 'sending') return <Clock size={11} className="message-status txt-dim" title="发送中" />
  if (s === 'sent') return <Check size={11} className="message-status txt-dim" title="已发送" />
  if (s === 'delivered') return <CheckCheck size={11} className="message-status accent-txt" title="已送达" />
  if (s === 'failed') return (
    <button onClick={(e) => { e.stopPropagation(); onRetry && onRetry(m) }} className="message-status text-red-400 inline-flex items-center gap-0.5" title="发送失败，点击重试">
      <AlertCircle size={11} /><RefreshCw size={10} />
    </button>
  )
  return null
}

function Bubble ({ m, now, showName, markdown, selectMode, selected, onToggleSelect, selfAvatar, peerAvatar, avatarSpacer, hideMeta, metaReactions, onRetry, mentionNames }) {
  // 阅后即焚：剩余时间占比(0~1)，用于进度条展示
  const burnTotal = (m.ttl || 10) * 1000
  const burnFrac = m.burn ? Math.max(0, Math.min(1, (m.ts + burnTotal - now) / burnTotal)) : 0
  const cls = m.burn ? 'bubble-burn' : (m.self ? 'bubble-self' : 'bubble-other')
  const avatarName = m.self ? '?' : (m.name || '')
  const avatarId = m.self ? (m.from || 'self') : (m.from || m.name || '')
  const avatarData = m.self ? selfAvatar : (peerAvatar || m.avatar)
  const rx = metaReactions !== undefined ? metaReactions : (m.reactions || {})
  const avEl = avatarSpacer ? <span className="avatar-spacer" /> : <Avatar name={avatarName} id={avatarId} avatar={avatarData} size={34} />
  return (
    <div className={'group message-row ' + (m.self ? 'message-row-self' : 'message-row-other')}>
      {selectMode && <input type="checkbox" checked={!!selected} onChange={() => onToggleSelect(m.mid)} className="accent-emerald-500" />}
      {!m.self && avEl}
      <div className="message-stack max-w-[75%]">
      <div className={'rounded-2xl px-3 py-2 text-sm ' + cls}>
        {showName && <div className="text-[11px] font-medium accent-txt mb-0.5">{m.name}</div>}
        {m.fwd && <div className="text-[10.5px] opacity-75 mb-0.5 inline-flex items-center gap-1"><Forward size={10} /> 转发自 {localizeKnownNamesText(m.fwd.name, mentionNames)}{m.fwd.count ? `（共 ${m.fwd.count} 条）` : ''}</div>}
        {m.reply && <div className="mb-1 px-2 py-1 rounded-lg text-[11px] opacity-80" style={{ borderLeft: '2px solid var(--accent)', background: 'rgba(0,0,0,0.12)' }}><span className="font-medium">{localizeKnownNamesText(m.reply.name, mentionNames)}</span>:{localizeMentionsText(m.reply.text, mentionNames)}</div>}
        <div className="whitespace-pre-wrap break-words">{m.recalled ? <span className="italic opacity-60">[已撤回]</span> : renderRich(m.text || '', markdown, mentionNames)}</div>
        {m.burn && <span className="burn-bar burn-bar-bubble"><span className="burn-bar-fill" style={{ width: (burnFrac * 100) + '%' }} /></span>}
      </div>
      {!hideMeta && (
        <div className="message-meta">
          {Object.keys(rx).length > 0 && (
            <div className="message-reactions">{Object.entries(rx).map(([e, ids]) => <span key={e} className="message-reaction">{e} {ids.length}</span>)}</div>
          )}
          <span className="message-time">{fmtTime(m.ts)}</span>
          <MsgStatus m={m} onRetry={onRetry} />
        </div>
      )}
      </div>
      {m.self && avEl}
    </div>
  )
}

function ShareEntryMsg ({ m, showName, onOpen, selfAvatar, peerAvatar, avatarSpacer, hideMeta, metaReactions, onRetry }) {
  const sh = m.share || {}
  const isFolder = sh.entryType === 'folder'
  const avatarName = m.self ? '?' : (m.name || '')
  const avatarId = m.self ? (m.from || 'self') : (m.from || m.name || '')
  const avatarData = m.self ? selfAvatar : (peerAvatar || m.avatar)
  const rx = metaReactions !== undefined ? metaReactions : (m.reactions || {})
  const avEl = avatarSpacer ? <span className="avatar-spacer" /> : <Avatar name={avatarName} id={avatarId} avatar={avatarData} size={34} />
  const path = (sh.breadcrumb || []).map((x) => x && x.name).filter(Boolean).join(' / ')
  return (
    <div className={'group message-row ' + (m.self ? 'message-row-self' : 'message-row-other')}>
      {!m.self && avEl}
      <div className="message-stack max-w-[75%]">
        {showName && <div className="text-[11px] font-medium accent-txt">{m.name}</div>}
        <button type="button" onClick={() => onOpen && onOpen(sh)} className={'share-entry-card ' + (m.self ? 'share-entry-card-self' : '')} title="打开群空间对应位置">
          <span className="share-entry-icon">{isFolder ? <Folder size={18} /> : <FileIcon size={18} />}</span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-[10.5px] txt-dim truncate">{sh.spaceName || '群文件'}</span>
            <span className="block text-sm font-medium txt truncate">{sh.name || '群空间内容'}</span>
            <span className="block text-[11px] txt-dim truncate">{isFolder ? '文件夹' : fmtSize(sh.size || 0)}{path ? ' · ' + path : ''}</span>
          </span>
          <ChevronRight size={15} className="txt-dim shrink-0" />
        </button>
        {!hideMeta && (
          <div className="message-meta">
            {Object.keys(rx).length > 0 && (
              <div className="message-reactions">{Object.entries(rx).map(([e, ids]) => <span key={e} className="message-reaction">{e} {ids.length}</span>)}</div>
            )}
            <span className="message-time">{fmtTime(m.ts)}</span>
            <MsgStatus m={m} onRetry={onRetry} />
          </div>
        )}
      </div>
      {m.self && avEl}
    </div>
  )
}

// 头像裁剪：直接在圆形预览里拖动图片选择显示区域，滚轮缩放
function AvatarCropper ({ avatar, onChange, size = 132 }) {
  const zoom = Math.max(100, Math.min(240, avatar.zoom || 120))
  const x = avatar.x == null ? 50 : avatar.x
  const y = avatar.y == null ? 50 : avatar.y
  function startDrag (e) {
    e.preventDefault()
    const startX = e.clientX; const startY = e.clientY
    const sx = x; const sy = y
    const range = size * (zoom / 100 - 1) // 图片可移动的像素范围
    const move = (ev) => {
      if (range <= 0) return
      const nx = Math.max(0, Math.min(100, sx - ((ev.clientX - startX) / range) * 100))
      const ny = Math.max(0, Math.min(100, sy - ((ev.clientY - startY) / range) * 100))
      onChange({ x: Math.round(nx), y: Math.round(ny) })
    }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  function onWheel (e) {
    const next = Math.max(100, Math.min(240, zoom + (e.deltaY < 0 ? 10 : -10)))
    if (next !== zoom) onChange({ zoom: next })
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        onMouseDown={startDrag}
        onWheel={onWheel}
        title="拖动图片调整显示区域，滚轮缩放"
        className="rounded-full cursor-move bg-no-repeat shrink-0"
        style={{ width: size, height: size, border: '2px dashed var(--border-hi)', backgroundImage: `url("${avatar.imageDataUrl}")`, backgroundSize: zoom + '%', backgroundPosition: x + '% ' + y + '%' }}
      />
      <div className="text-[10px] txt-dim">拖动图片调整区域 · 滚轮缩放</div>
    </div>
  )
}

function ProfileDialog ({ person, editable, settings, onPatchSettings, onRename, onSetRemark, onClose }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(person.name || '')
  const [sig, setSig] = useState((editable && settings && settings.statusText) || '')
  const [remark, setRemark] = useState(person.remark || '')
  const [avatarMsg, setAvatarMsg] = useState('')
  function commitRemark () {
    const v = remark.trim().slice(0, 32)
    if (onSetRemark && v !== (person.remark || '')) onSetRemark(v)
  }
  const avatar = (editable && settings && settings.avatar) || person.avatar || { type: 'text', text: '', color: '' }
  function patchAvatar (patch) { if (onPatchSettings) onPatchSettings({ avatar: { ...avatar, ...patch } }) }
  async function pickAvatarImage () {
    setAvatarMsg('')
    if (!api.avatar || !api.avatar.pickImage) { setAvatarMsg('请重启窗口后再选择头像'); return }
    const res = await api.avatar.pickImage()
    if (res && res.ok) {
      if (res.gif) {
        const staticThumb = (await compressImageDataUrl(res.dataUrl, 192, 0.8)) || ''
        if (res.dataUrl.length > ANIMATED_GIF_MAX_CHARS) {
          // 超过可同步上限：提示过大，本地与对方都只用静态首帧，保证两端一致
          setAvatarMsg('动图超过 ' + ANIMATED_GIF_MAX_KB + 'KB，已转为静态展示')
          patchAvatar({ type: 'image', imageDataUrl: staticThumb || res.dataUrl, staticDataUrl: '', zoom: 120, x: 50, y: 50 })
        } else {
          patchAvatar({ type: 'image', imageDataUrl: res.dataUrl, staticDataUrl: staticThumb, zoom: 120, x: 50, y: 50 })
        }
      } else {
        const compact = (await compressImageDataUrl(res.dataUrl, 192, 0.8)) || res.dataUrl
        patchAvatar({ type: 'image', imageDataUrl: compact, staticDataUrl: '', zoom: 120, x: 50, y: 50 })
      }
    } else if (res && res.error) setAvatarMsg(res.error)
  }
  function commitSig () {
    const v = sig.slice(0, 40)
    if (onPatchSettings && v !== ((settings && settings.statusText) || '')) onPatchSettings({ statusText: v })
  }
  async function save () { await onRename(draft); setEditing(false) }
  return (
    <Overlay onClose={onClose}>
      <div className={(editable ? 'floating-dialog-md' : 'floating-dialog-sm') + ' floating-dialog floating-surface glass-panel floating-dialog-pad text-center'} role="dialog" aria-modal="true" aria-label={editable ? '我的资料' : '联系人资料'}>
        {/* 头像：自己且为图片头像时显示拖拽裁剪，否则普通展示 */}
        {editable && avatar.type === 'image' && avatar.imageDataUrl ? (
          <div className="flex justify-center"><AvatarCropper avatar={avatar} onChange={patchAvatar} /></div>
        ) : (
          <div className="flex justify-center"><Avatar name={person.remark || person.name} id={person.id} avatar={avatar} size={editable ? 96 : 64} /></div>
        )}
        {editable && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button onClick={pickAvatarImage} className="btn-ghost text-xs rounded-lg px-2 py-1.5 inline-flex items-center gap-1"><Upload size={13} /> 上传图片</button>
            <button onClick={() => patchAvatar({ type: 'text', imageDataUrl: '', text: avatar.text || '', color: avatar.color || AVATAR_PRESETS[0] })} className="btn-ghost text-xs rounded-lg px-2 py-1.5 inline-flex items-center gap-1"><Type size={13} /> 文字</button>
            <button onClick={() => patchAvatar({ type: 'preset', imageDataUrl: '', color: avatar.color || AVATAR_PRESETS[1] })} className="btn-ghost text-xs rounded-lg px-2 py-1.5 inline-flex items-center gap-1"><ImageIcon size={13} /> 预设</button>
          </div>
        )}
        {editable && avatarMsg && <div className="mt-2 text-xs text-red-400">{avatarMsg}</div>}
        {editable && (avatar.type === 'text' || avatar.type === 'preset') && (
          <div className="mt-3 space-y-2 text-left">
            <Row label="头像文字" hint="最多 2 个字符"><input value={avatar.text || ''} maxLength={2} onChange={(e) => patchAvatar({ type: 'text', text: e.target.value })} className="field w-20 rounded px-2 py-1 text-sm" placeholder="?" /></Row>
            <Row label="预设颜色"><div className="flex gap-1">{AVATAR_PRESETS.map((c) => <button key={c} onClick={() => patchAvatar({ type: avatar.type === 'preset' ? 'preset' : 'text', color: c })} className="w-6 h-6 rounded-full border" style={{ background: c, borderColor: avatar.color === c ? 'var(--text)' : 'transparent' }} />)}</div></Row>
          </div>
        )}
        {editable && editing ? (
          <div className="mt-3 flex items-center justify-center gap-1">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }} autoFocus className="field rounded-lg px-2 py-1 text-sm text-center w-40 outline-none" />
            <button onClick={save} className="accent-txt"><Check size={16} /></button>
          </div>
        ) : (
          <div className="mt-3 text-lg font-semibold txt inline-flex items-center gap-1 justify-center">{person.remark || person.name}{editable && <button onClick={() => { setDraft(person.name); setEditing(true) }} className="txt-dim hover:opacity-70"><Pencil size={13} /></button>}</div>
        )}
        {!editable && person.remark && <div className="mt-0.5 text-xs txt-dim">昵称: {person.name}</div>}
        {typeof person.online === 'boolean' && <div className="mt-1 text-xs txt-dim">{person.online ? '在线' : '离线'}</div>}
        {/* 备注：仅本机可见 */}
        {!editable && onSetRemark && (
          <input
            value={remark}
            maxLength={32}
            onChange={(e) => setRemark(e.target.value.slice(0, 32))}
            onBlur={commitRemark}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRemark() } }}
            placeholder="设置备注（仅本机可见）"
            className="field mt-2 w-full rounded-lg px-2 py-1 text-xs text-center"
          />
        )}
        {/* 个性签名：自己可编辑，他人仅展示 */}
        {editable ? (
          <input
            value={sig}
            maxLength={40}
            onChange={(e) => setSig(e.target.value.slice(0, 40))}
            onBlur={commitSig}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitSig() } }}
            placeholder="输入个性签名"
            className="field mt-2 w-full rounded-lg px-2 py-1 text-xs text-center"
          />
        ) : (
          person.status && <div className="mt-1 text-xs accent-txt break-words">{person.status}</div>
        )}
        {person.address && (
          <div className="mt-4 text-left text-xs txt-dim space-y-1.5">
            <div>地址:<span className="txt ml-1">{person.address}</span></div>
          </div>
        )}
        <button onClick={onClose} className="btn-ghost mt-5 w-full rounded-lg py-2 text-sm">关闭</button>
      </div>
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
function SetupScreen ({ onDone }) {
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false)
  async function submit () {
    setErr(null)
    if (pw.length < 4) return setErr('密码至少 4 位')
    if (pw !== pw2) return setErr('两次输入不一致')
    setBusy(true); const res = await api.auth.setup(pw); setBusy(false)
    if (res && res.ok) onDone(res.identity); else setErr((res && res.error) || '设置失败')
  }
  return (
    <div className="auth-surface h-full flex flex-col">
      <TopBar />
      <Center>
        <div className="w-full max-w-sm glass-panel rounded-2xl p-7">
          <div className="flex items-center gap-2 accent-txt"><ShieldCheck size={20} /><span className="text-sm font-medium">iLink · 首次设置</span></div>
          <h1 className="mt-3 text-xl font-semibold txt">首次使用，请设置主密码</h1>
          <p className="mt-1 text-xs txt-dim leading-relaxed">主密码会加密本地身份、密钥和聊天记录，不会上传，且无法找回。</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="主密码" className={FIELD + ' mt-4'} autoFocus />
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} placeholder="再次输入" className={FIELD + ' mt-3'} />
          {err && <div className="mt-3 text-xs text-red-400">{err}</div>}
          <button onClick={submit} disabled={busy} className="btn-primary mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">{busy ? '创建中...' : '创建身份'}</button>
        </div>
      </Center>
    </div>
  )
}

function UnlockScreen ({ onDone, onReset }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false); const [ack, setAck] = useState(false)
  async function submit () { setErr(null); setBusy(true); const res = await api.auth.unlock(pw); setBusy(false); if (res && res.ok) onDone(res.identity); else setErr((res && res.error) || '设置失败') }
  return (
    <div className="auth-surface h-full flex flex-col">
      <TopBar />
      <Center>
        <div className="w-full max-w-sm glass-panel rounded-2xl p-7">
          <div className="flex items-center gap-2 accent-txt"><Lock size={20} /><span className="text-sm font-medium">iLink · 解锁</span></div>
          <h1 className="mt-3 text-xl font-semibold txt">输入主密码解锁</h1>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} placeholder="主密码" className={FIELD + ' mt-4'} autoFocus />
          {err && <div className="mt-3 text-xs text-red-400">{err}</div>}
          <button onClick={submit} disabled={busy} className="btn-primary mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">{busy ? '解锁中...' : '解锁'}</button>
          {!confirmReset ? (
            <button onClick={() => setConfirmReset(true)} className="mt-4 text-xs txt-dim hover:opacity-80">重置身份...</button>
          ) : (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <div className="text-xs text-red-400">此操作会永久删除身份和本地记录，且无法恢复。</div>
              <label className="mt-2 flex items-center gap-2 text-xs txt-dim"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已了解此操作不可恢复</label>
              <div className="mt-2 flex gap-2">
                <button onClick={async () => { await api.auth.resetIdentity(); onReset() }} disabled={!ack} className="text-xs bg-red-500 text-white rounded px-3 py-1.5 disabled:opacity-40">确认重置</button>
                <button onClick={() => { setConfirmReset(false); setAck(false) }} className="text-xs txt-dim px-3 py-1.5">取消</button>
              </div>
            </div>
          )}
        </div>
      </Center>
    </div>
  )
}

const SETTINGS_CATS = [
  { key: 'appearance', label: '外观', icon: Sun },
  { key: 'notify', label: '通知', icon: Bell },
  { key: 'files', label: '文件', icon: FileIcon },
  { key: 'network', label: '网络', icon: Network },
  { key: 'privacy', label: '隐私', icon: ShieldCheck },
  { key: 'about', label: '关于', icon: Info },
]

function SettingsPanel ({ settings, onPatch, onClose, onLock, onReset, onClearHistory, onClearDrafts }) {
  const [cat, setCat] = useState('appearance')
  const [oldPw, setOldPw] = useState(''); const [newPw, setNewPw] = useState(''); const [newPw2, setNewPw2] = useState('')
  const [msg, setMsg] = useState(null); const [confirmReset, setConfirmReset] = useState(false); const [ack, setAck] = useState(false)
  const [appInfo, setAppInfo] = useState(null)
  const [updateMsg, setUpdateMsg] = useState('')
  const s = settings || {}
  const [udpDraft, setUdpDraft] = useState(String(s.udpPort || 51888))
  const [broadcastDraft, setBroadcastDraft] = useState(s.broadcastAddrs || '')
  useEffect(() => { setUdpDraft(String(s.udpPort || 51888)); setBroadcastDraft(s.broadcastAddrs || '') }, [s.udpPort, s.broadcastAddrs])
  useEffect(() => { if (api && api.ping) api.ping().then((p) => setAppInfo(p)).catch(() => {}) }, [])
  function applyNetwork () {
    const port = Math.max(1024, Math.min(65535, parseInt(udpDraft, 10) || 51888))
    setUdpDraft(String(port))
    onPatch({ udpPort: port, broadcastAddrs: broadcastDraft })
  }
  async function checkUpdate () {
    setUpdateMsg('正在检查...')
    const res = api.checkUpdate ? await api.checkUpdate() : null
    setUpdateMsg((res && res.message) || '没有可用更新')
  }
  async function changePw () {
    setMsg(null)
    if (newPw.length < 4) return setMsg({ t: 'err', s: '新密码至少 4 位' })
    if (newPw !== newPw2) return setMsg({ t: 'err', s: '两次输入不一致' })
    const res = await api.auth.changePassword(oldPw, newPw)
    if (res && res.ok) { setMsg({ t: 'ok', s: '密码已修改' }); setOldPw(''); setNewPw(''); setNewPw2('') } else setMsg({ t: 'err', s: (res && res.error) || '修改失败' })
  }
  return (
    <Overlay onClose={onClose}>
      <div className="floating-dialog floating-dialog-xl floating-surface glass-panel overflow-hidden" style={{ height: '78vh', maxHeight: 640 }} role="dialog" aria-modal="true" aria-label="设置">
        <div className="floating-titlebar justify-between">
          <h2 className="text-sm font-semibold txt inline-flex items-center gap-2"><Settings size={16} /> 设置</h2>
          <button onClick={onClose} className="icon-btn"><X size={16} /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 左侧功能分类导航 */}
          <div className="w-[150px] shrink-0 border-r bd-soft p-2 overflow-auto scroll">
            {SETTINGS_CATS.map((c) => (
              <button key={c.key} onClick={() => setCat(c.key)} className={'w-full flex items-center gap-2 px-3 py-2 mb-0.5 rounded-xl text-sm text-left ' + (cat === c.key ? 'side-item side-item-active' : 'side-item')}>
                <c.icon size={15} /> <span className="truncate">{c.label}</span>
              </button>
            ))}
          </div>

          {/* 右侧内容 */}
          <div className="flex-1 overflow-auto scroll p-5">
            {cat === 'appearance' && (
              <SettingsCard title="外观" icon={Sun}>
                <Row label="动图静态展示" hint="开启后 GIF 等动图（头像、聊天图片）以静态画面显示"><Toggle on={!!s.staticGif} onClick={() => onPatch({ staticGif: !s.staticGif })} /></Row>
                <Row label="字体大小"><select value={s.fontPx || 15} onChange={(e) => onPatch({ fontPx: parseInt(e.target.value, 10) })} className="field rounded px-2 py-1 text-sm"><option value={13}>Small</option><option value={15}>中号</option><option value={17}>Large</option></select></Row>
                <div className="py-2">
                  <div className="text-sm txt">主题风格</div>
                  <div className="text-[11px] txt-dim">切换不同配色和界面风格</div>
                  <div className="mt-2 grid grid-cols-5 gap-2">
                    {UI_STYLES.map((st) => {
                      const cur = (s.uiStyle || 'classic') === st.key
                      return (
                        <button key={st.key} onClick={() => onPatch({ uiStyle: st.key })} className="rounded-xl p-2 text-center transition" style={{ border: '1.5px solid ' + (cur ? 'var(--accent)' : 'var(--border-soft)'), background: cur ? 'var(--accent-tint)' : 'var(--hover)' }}>
                          <span className="mx-auto block w-7 h-7 rounded-full" style={{ background: `linear-gradient(135deg, ${st.colors[0]} 0%, ${st.colors[0]} 48%, ${st.colors[1]} 52%, ${st.colors[1]} 100%)`, border: '1px solid rgba(128,128,128,0.3)', boxShadow: cur ? '0 0 0 2px var(--accent)' : 'none' }} />
                          <div className={'mt-1.5 text-[10px] ' + (cur ? 'accent-txt font-semibold' : 'txt-dim')}>{st.label}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingsCard>
            )}

            {cat === 'notify' && (
              <SettingsCard title="通知与输入" icon={Bell}>
                <Row label="通知"><Toggle on={s.notifyEnabled !== false} onClick={() => onPatch({ notifyEnabled: !(s.notifyEnabled !== false) })} /></Row>
                <Row label="消息预览"><Toggle on={s.notifyPreview !== false} onClick={() => onPatch({ notifyPreview: !(s.notifyPreview !== false) })} /></Row>
                <Row label="正在输入"><Toggle on={s.showTyping !== false} onClick={() => onPatch({ showTyping: !(s.showTyping !== false) })} /></Row>
                <Row label="发送键"><select value={s.sendKey || 'enter'} onChange={(e) => onPatch({ sendKey: e.target.value })} className="field rounded px-2 py-1 text-sm"><option value="enter">Enter</option><option value="ctrlEnter">Ctrl+Enter</option></select></Row>
                <Row label="Markdown 渲染" hint="**bold** *italic* `code`"><Toggle on={!!s.markdown} onClick={() => onPatch({ markdown: !s.markdown })} /></Row>
                <Row label="最小化行为" hint="最小化时保留任务栏卡片，托盘图标仍可打开主窗口"><span className="text-xs txt-dim">收起到任务栏</span></Row>
                <Row label="关闭主窗口时"><select value={s.closeAction || 'ask'} onChange={(e) => onPatch({ closeAction: e.target.value })} className="field rounded px-2 py-1 text-sm"><option value="ask">询问</option><option value="tray">最小化到托盘</option><option value="quit">退出程序</option></select></Row>
                <Row label="开机自启" hint="开机时自动启动"><Toggle on={!!s.autoStart} onClick={() => onPatch({ autoStart: !s.autoStart })} /></Row>
              </SettingsCard>
            )}

            {cat === 'files' && (
              <SettingsCard title="文件" icon={FileIcon}>
                <Row label="接收方式"><select value={s.receiveMode || 'auto'} onChange={(e) => onPatch({ receiveMode: e.target.value })} className="field rounded px-2 py-1 text-sm"><option value="auto">自动</option><option value="manual">手动</option></select></Row>
                <Row label="下载位置" hint={s.downloadDir || '未设置'}><button onClick={async () => { const d = await api.file.chooseDir(); if (d) onPatch({ downloadDir: d }) }} className="btn-ghost text-sm rounded-lg px-3 py-1.5">选择...</button></Row>
                <Row label="单文件大小上限" hint="0 = 不限制（MB）"><input type="number" min={0} max={102400} value={s.maxFileMB || 0} onChange={(e) => onPatch({ maxFileMB: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="field w-24 rounded px-2 py-1 text-sm" /></Row>
              </SettingsCard>
            )}

            {cat === 'network' && (
              <SettingsCard title="网络" icon={Network}>
                <Row label="UDP 端口" hint="需要与其他客户端使用同一端口"><input type="number" min={1024} max={65535} value={udpDraft} onChange={(e) => setUdpDraft(e.target.value)} className="field w-24 rounded px-2 py-1 text-sm" /></Row>
                <div className="py-2">
                   <div className="text-sm txt">广播地址</div>
                  <div className="text-[11px] txt-dim">可选，使用逗号或换行分隔</div>
                  <textarea value={broadcastDraft} onChange={(e) => setBroadcastDraft(e.target.value)} rows={2} className="field mt-2 w-full rounded px-2 py-1 text-sm resize-none" placeholder="例如：192.168.1.255, 255.255.255.255" />
                </div>
                <button onClick={applyNetwork} className="btn-primary text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><RefreshCw size={13} /> 应用网络设置</button>
              </SettingsCard>
            )}

            {cat === 'privacy' && (
              <>
                <SettingsCard title="隐私" icon={EyeOff}>
                  <Row label="匿名聊天" hint="消息中显示匿名昵称"><Toggle on={!!s.anonymous} onClick={() => onPatch({ anonymous: !s.anonymous })} /></Row>
                  <Row label="默认阅后即焚"><Toggle on={!!s.burnDefault} onClick={() => onPatch({ burnDefault: !s.burnDefault })} /></Row>
                  <Row label="阅后即焚时长" hint="3 到 60 秒"><input type="number" min={3} max={60} value={s.burnTtl || 10} onChange={(e) => onPatch({ burnTtl: Math.min(60, Math.max(3, parseInt(e.target.value, 10) || 10)) })} className="field w-16 rounded px-2 py-1 text-sm" /></Row>
                   <Row label="自动锁定分钟" hint="0 = 关闭"><input type="number" min={0} max={240} value={s.autoLockMin || 0} onChange={(e) => onPatch({ autoLockMin: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="field w-16 rounded px-2 py-1 text-sm" /></Row>
                   <Row label="历史保留天数" hint="0 = 永久保留"><input type="number" min={0} max={3650} value={s.retentionDays || 0} onChange={(e) => onPatch({ retentionDays: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="field w-16 rounded px-2 py-1 text-sm" /></Row>
                </SettingsCard>

                <SettingsCard title="修改密码" icon={Lock}>
                  <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} placeholder="旧密码" className={FIELD} />
                  <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="新密码" className={FIELD + ' mt-2'} />
                  <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} placeholder="确认新密码" className={FIELD + ' mt-2'} />
                  {msg && <div className={'mt-2 text-xs ' + (msg.t === 'ok' ? 'accent-txt' : 'text-red-400')}>{msg.s}</div>}
                  <button onClick={changePw} className="btn-primary mt-3 text-sm rounded-lg px-3 py-1.5 font-medium">修改</button>
                </SettingsCard>

                <SettingsCard title="数据管理" icon={Trash2}>
                   <Row label="清空历史"><button onClick={onClearHistory} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><Trash2 size={13} /> 清空</button></Row>
                   <Row label="清空草稿"><button onClick={onClearDrafts} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><Trash2 size={13} /> 清空</button></Row>
                   <Row label="锁定" hint="锁定当前应用"><button onClick={async () => { await api.auth.lock(); onLock() }} className="btn-ghost text-sm rounded-lg px-3 py-1.5">锁定</button></Row>
                </SettingsCard>

                <SettingsCard title="重置身份" icon={Trash2} danger>
                  {!confirmReset ? (
                    <button onClick={() => setConfirmReset(true)} className="text-sm text-red-400 border border-red-500/30 rounded-lg px-3 py-1.5 hover:bg-red-500/10">重置身份...</button>
                  ) : (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                       <div className="text-xs text-red-400">此操作会永久删除身份和本地记录，且无法恢复。</div>
                       <label className="mt-2 flex items-center gap-2 text-xs txt-dim"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已了解此操作不可恢复</label>
                       <div className="mt-2 flex gap-2"><button onClick={async () => { await api.auth.resetIdentity(); onReset() }} disabled={!ack} className="text-xs bg-red-500 text-white rounded px-3 py-1.5 disabled:opacity-40">确认重置</button><button onClick={() => { setConfirmReset(false); setAck(false) }} className="text-xs txt-dim px-3 py-1.5">取消</button></div>
                    </div>
                  )}
                </SettingsCard>
              </>
            )}

            {cat === 'about' && (
              <SettingsCard title="关于" icon={Info}>
                <div className="rounded-lg p-3 text-xs txt-dim" style={{ background: 'var(--bubble-other)' }}>
                  <div className="txt font-medium">iLink {appInfo ? appInfo.appVersion : ''}</div>
                  <div className="mt-1">P2P 局域网点对点通讯，数据默认存放在本地 data 目录。</div>
                  <div className="mt-1">作者：<span className="txt">Claude x WZT</span></div>
                   {appInfo && <div className="mt-1 font-mono">Electron {appInfo.versions.electron} · Node {appInfo.versions.node}</div>}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                   <button onClick={checkUpdate} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><RefreshCw size={13} /> 检查更新</button>
                   {api.sys.revealLog && <button onClick={() => api.sys.revealLog()} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><FileIcon size={13} /> 打开日志</button>}
                   <button onClick={() => setUpdateMsg('帮助：两端需要使用相同 UDP 端口，并检查防火墙和广播地址。')} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><CircleHelp size={13} /> 帮助</button>
                   <button onClick={() => setUpdateMsg('关于：iLink 使用 UDP 发现、端到端加密消息和本地加密存储。')} className="btn-ghost text-sm rounded-lg px-3 py-1.5 inline-flex items-center gap-1"><Info size={13} /> 关于</button>
                </div>
                {updateMsg && <div className="mt-2 text-xs accent-txt">{updateMsg}</div>}
              </SettingsCard>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// 群成员列表：显示人数，群主第一，其余按在线 > 离线 > 名字排序
const PICKER_PAGE = 50 // 添加成员候选列表分页大小：大量用户时增量渲染，避免一次挂载全部节点
function GroupMemberList ({ room, members, peers, selfId, onMemberClick, onAddMember, onKickMember }) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState({}) // 多选：id -> true
  const [showCount, setShowCount] = useState(PICKER_PAGE)
  const onlineCount = members.filter((p) => p.online).length
  const memberIds = new Set(members.map((p) => p.id))
  const isMember = !!selfId && memberIds.has(selfId)
  const needle = query.trim().toLowerCase()
  // 展示全部非成员用户（在线 + 离线联系人），排序：在线 > 离线 > 名字；useMemo 避免每次渲染重排
  const candidates = useMemo(() => {
    const ids = new Set(members.map((p) => p.id))
    const list = []
    for (const p of (peers || [])) {
      if (!p || !p.id || ids.has(p.id)) continue
      if (needle) {
        const hit = (p.remark || '').toLowerCase().includes(needle) || (p.name || '').toLowerCase().includes(needle) || String(p.id).toLowerCase().includes(needle)
        if (!hit) continue
      }
      list.push(p)
    }
    list.sort((a, b) => ((a.online ? 0 : 1) - (b.online ? 0 : 1)) || (a.remark || a.name || '').localeCompare(b.remark || b.name || '', 'zh-CN'))
    return list
  }, [peers, members, needle])
  useEffect(() => { setShowCount(PICKER_PAGE) }, [needle, adding]) // 搜索词或开关变化时回到第一页
  const visibleCandidates = candidates.slice(0, showCount)
  const pickedIds = Object.keys(picked).filter((id) => picked[id])
  function onPickerScroll (e) {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40 && showCount < candidates.length) setShowCount((c) => c + PICKER_PAGE)
  }
  function confirmAdd () {
    if (!pickedIds.length) return
    onAddMember && onAddMember(pickedIds)
    setPicked({}); setQuery(''); setAdding(false)
  }
  const sorted = members.slice().sort((a, b) => {
    const ao = a.id === room.ownerId ? 0 : 1
    const bo = b.id === room.ownerId ? 0 : 1
    if (ao !== bo) return ao - bo
    const aOn = a.online ? 0 : 1
    const bOn = b.online ? 0 : 1
    if (aOn !== bOn) return aOn - bOn
    return (a.name || '').localeCompare(b.name || '', 'zh-CN')
  })
  return (
    <aside className="w-full sidebar-surface border-l bd-soft flex flex-col overflow-hidden">
      <div className="pane-header px-3 flex items-center gap-1.5 border-b bd-soft shrink-0 text-xs txt-dim">
        <Users size={13} />
        <span>群成员</span>
        <span className="txt font-semibold">{members.length}</span>
        <span className="ml-auto accent-txt">{onlineCount} 在线</span>
      </div>
      {isMember && (
        <div className="p-2 border-b bd-soft shrink-0">
          <button onClick={() => setAdding((v) => !v)} className="btn-ghost w-full rounded-lg px-2 py-1.5 text-xs inline-flex items-center justify-center gap-1.5">
              <UserPlus size={13} /> 添加成员
          </button>
          {adding && (
            <div className="mt-2 space-y-1">
              <div className="side-search">
                <Search size={12} className="txt-dim shrink-0" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索用户名/备注/ID" />
              </div>
              <div className="text-[10px] txt-dim px-1">可添加 {candidates.length} 人{pickedIds.length > 0 ? ` · 已选 ${pickedIds.length}` : ''}</div>
              <div className="max-h-56 overflow-auto scroll space-y-0.5" onScroll={onPickerScroll}>
                {visibleCandidates.map((p) => {
                  const sel = !!picked[p.id]
                  return (
                    <div key={p.id} onClick={() => setPicked((prev) => ({ ...prev, [p.id]: !prev[p.id] }))} className={'side-item flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer ' + (sel ? 'side-item-active' : '')}>
                      <Avatar name={p.remark || p.name} id={p.id} size={24} dim={!p.online} avatar={p.avatar} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs txt truncate">{p.remark || p.name}</div>
                        <div className="text-[10px] truncate" style={{ color: p.online ? presenceOf(p).color : 'var(--text-dim)' }}>{p.online ? presenceOf(p).label : '离线'}</div>
                      </div>
                      <span className={'w-4 h-4 rounded-full shrink-0 flex items-center justify-center ' + (sel ? 'btn-primary' : '')} style={sel ? {} : { border: '1.5px solid var(--border-hi)' }}>{sel && <Check size={11} />}</span>
                    </div>
                  )
                })}
                {showCount < candidates.length && <div className="text-[10px] txt-dim text-center py-1.5">向下滚动加载更多</div>}
                {query.trim() && candidates.length === 0 && <div className="text-[11px] txt-dim px-2 py-2">未找到匹配的成员</div>}
                {!query.trim() && candidates.length === 0 && <div className="text-[11px] txt-dim px-2 py-2">暂无可添加成员</div>}
              </div>
              {pickedIds.length > 0 && <button onClick={confirmAdd} className="btn-primary w-full rounded-lg px-2 py-1.5 text-xs font-medium">添加 {pickedIds.length} 人</button>}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 overflow-auto scroll p-2 space-y-0.5">
        {sorted.map((p, i) => {
          const isOwner = p.id === room.ownerId
          return (
            <div key={p.id} style={{ animationDelay: Math.min(i * 30, 240) + 'ms' }} className="row-in side-item w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left">
              <button onClick={() => onMemberClick && onMemberClick(p)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              <div className="relative shrink-0">
                <Avatar name={p.name} id={p.id} size={28} dim={!p.online} avatar={p.avatar} />
                <span className={'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ' + (presenceOf(p).key === 'online' ? 'dot-pulse' : '')} style={{ background: presenceOf(p).color, border: '2px solid rgb(var(--panel-rgb))' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] txt truncate flex items-center gap-1">
                  <span className="truncate">{p.self ? '我' : p.name}</span>
                  {isOwner && <Crown size={11} className="accent-txt shrink-0" />}
                </div>
                <div className="text-[10px]" style={{ color: presenceOf(p).color }}>{isOwner ? '群主 · ' : ''}{presenceOf(p).label}</div>
              </div>
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function DetailPane ({ active, activePeer, activeRoom, roomMembers, peers, self, searchPane, convos, convTitle, locateMessage, onOpenFile, onCloseSearch, onMemberClick, onAddMember, onKickMember, onOpenProfile, displayNameForId, mentionNames }) {
  if (searchPane) {
    return <SearchPane key={searchPane} defaultScope={searchPane === 'global' ? 'all' : 'current'} convos={convos} convTitle={convTitle} activeConv={active} onLocate={locateMessage} onOpenFile={onOpenFile} onClose={onCloseSearch} displayNameForId={displayNameForId} mentionNames={mentionNames} />
  }
  if (activeRoom) {
    return <GroupMemberList room={activeRoom} members={roomMembers} peers={peers} selfId={self && self.id} onMemberClick={onMemberClick} onAddMember={onAddMember} onKickMember={onKickMember} />
  }
  return (
    <aside className="w-full sidebar-surface border-l bd-soft flex flex-col overflow-hidden">
      <div className="pane-header px-3 flex items-center gap-1.5 border-b bd-soft shrink-0 text-xs txt-dim">
        <Info size={13} />
        <span>聊天详情</span>
      </div>
      <div className="flex-1 overflow-auto scroll p-4">
        {activePeer ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center text-center gap-2">
              <Avatar name={(activePeer.remark || activePeer.name)} id={activePeer.id} size={64} dim={!activePeer.online} avatar={activePeer.avatar} />
              <div className="min-w-0">
                <div className="text-base font-semibold txt truncate">{activePeer.remark || activePeer.name}</div>
                <div className="text-xs" style={{ color: presenceOf(activePeer).color }}>{presenceOf(activePeer).label}</div>
              </div>
              {activePeer.status && <div className="text-xs txt-dim rounded-lg px-3 py-2 w-full" style={{ background: 'var(--hover)' }}>{activePeer.status}</div>}
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between gap-2"><span className="txt-dim">ID</span><span className="txt truncate font-mono">{activePeer.id}</span></div>
              {activePeer.address && <div className="flex justify-between gap-2"><span className="txt-dim">IP</span><span className="txt truncate font-mono">{activePeer.address}</span></div>}
            </div>
            <button onClick={() => onOpenProfile && onOpenProfile(activePeer)} className="btn-ghost w-full rounded-lg px-3 py-2 text-sm">Profile</button>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 txt-dim">
            <User size={30} />
            <div className="text-xs">未找到匹配的成员</div>
          </div>
        )}
      </div>
    </aside>
  )
}

// 聊天搜索侧栏：可搜索聊天记录与文件，点击定位到聊天框相应位置
function SearchPane ({ convos, convTitle, activeConv, onLocate, onOpenFile, onClose, defaultScope, displayNameForId, mentionNames }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('all')
  const [scope, setScope] = useState(defaultScope || 'current')
  const needle = q.trim().toLowerCase()
  const results = []

  if (needle || tab === 'file') {
    const convIds = scope === 'current' && activeConv ? [activeConv] : Object.keys(convos)
    for (const conv of convIds) {
      const list = convos[conv] || []
      for (const m of list) {
        if (m.recalled || m.system || m.burn) continue
        const isFile = m.type === 'file' || m.type === 'file-offer'
        if (tab === 'msg' && isFile) continue
        if (tab === 'file' && !isFile) continue
        const body = isFile ? (m.fname || '') : localizeMentionsText(m.text || '', mentionNames)
        const sender = m.self ? '我' : (displayNameForId ? displayNameForId(m.from, m.name || '') : (m.name || ''))
        const hay = (body + ' ' + sender + ' ' + convTitle(conv)).toLowerCase()
        if (!needle || hay.includes(needle)) results.push({ conv, m, isFile, body, sender })
      }
    }
    results.sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0))
  }

  const hl = (value) => {
    const text = value == null ? '' : String(value)
    if (!needle) return text
    let s = text
    let i = s.toLowerCase().indexOf(needle)
    if (i < 0) return s
    if (i > 24 && s.length > 64) {
      s = '...' + s.slice(i - 18)
      i = s.toLowerCase().indexOf(needle)
    }
    return (
      <>
        {s.slice(0, i)}
        <span className="rounded px-0.5 font-bold" style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}>
          {s.slice(i, i + needle.length)}
        </span>
        {s.slice(i + needle.length)}
      </>
    )
  }

  const showing = !!needle || tab === 'file'

  return (
    <aside className="w-full sidebar-surface border-l bd-soft flex flex-col overflow-hidden">
      <div className="pane-header px-3 flex items-center gap-2 border-b bd-soft shrink-0">
        <div className="field flex-1 min-w-0 rounded-full px-3 py-1.5 flex items-center gap-2">
          <Search size={13} className="txt-dim shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={scope === 'all' ? '全局搜索消息、文件和用户名' : '搜索当前会话中的消息、文件和用户名'}
            className="flex-1 min-w-0 bg-transparent outline-none text-xs txt"
            style={{ border: 'none', boxShadow: 'none' }}
          />
          {q && <button onClick={() => setQ('')} className="txt-dim hover:opacity-70 shrink-0"><X size={12} /></button>}
        </div>
        <button onClick={onClose} className="icon-btn shrink-0"><X size={15} /></button>
      </div>

      <div className="px-3 pt-2 pb-2 flex items-center gap-2 shrink-0 border-b bd-soft">
        <div className="seg-tabs grid grid-cols-3 gap-1 flex-1 text-xs">
          <button onClick={() => setTab('all')} className={tab === 'all' ? 'seg-tab seg-tab-active' : 'seg-tab'}>全部</button>
          <button onClick={() => setTab('msg')} className={tab === 'msg' ? 'seg-tab seg-tab-active' : 'seg-tab'}>消息</button>
          <button onClick={() => setTab('file')} className={tab === 'file' ? 'seg-tab seg-tab-active' : 'seg-tab'}>文件</button>
        </div>
        <button
          onClick={() => setScope((v) => (v === 'current' ? 'all' : 'current'))}
          title="切换搜索范围"
          className={'text-[11px] rounded-lg px-2.5 py-1.5 shrink-0 font-medium transition ' + (scope === 'all' ? 'btn-primary' : 'btn-ghost')}
        >
          {scope === 'current' ? '当前会话' : '全部会话'}
        </button>
      </div>

      <div className="px-4 pt-2 text-[10.5px] accent-txt shrink-0">右键可定位到聊天记录中的结果</div>
      {showing && results.length > 0 && <div className="px-4 pt-1 text-[10.5px] txt-dim shrink-0">共 {results.length} 条结果</div>}

      <div className="flex-1 overflow-auto scroll px-3 py-2 space-y-1.5">
        {!showing && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 select-none">
            <div className="text-3xl float-soft">搜索</div>
            <div className="text-xs txt-dim">输入关键字，搜索消息、文件或用户名</div>
          </div>
        )}

        {showing && results.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 select-none">
            <div className="text-3xl">空</div>
            <div className="text-xs txt-dim">没有匹配的结果，换一个关键词试试</div>
          </div>
        )}

        {results.slice(0, 200).map((r, i) => (
          <button
            key={r.m.mid || i}
            onClick={() => { if (r.isFile && r.m.path) onOpenFile(r.m.path); else onLocate(r.conv, r.m.mid) }}
            onContextMenu={(e) => { e.preventDefault(); onLocate(r.conv, r.m.mid) }}
            style={{ animationDelay: Math.min(i * 25, 250) + 'ms' }}
            className="search-card row-in w-full text-left px-2.5 py-2 rounded-xl"
          >
            <div className="flex items-center gap-1.5 text-[10px] min-w-0">
              <span className="px-1.5 py-0.5 rounded-md accent-txt font-semibold shrink-0 max-w-[45%] truncate" style={{ background: 'var(--accent-tint)' }}>
                {convTitle(r.conv)}
              </span>
              {r.sender && <span className="txt-dim truncate">{hl(r.sender)}</span>}
              <span className="ml-auto txt-dim shrink-0">{dayLabel(r.m.ts)} {fmtTime(r.m.ts).slice(0, 5)}</span>
            </div>

            {r.isFile ? (
              <div className="mt-1.5 flex items-center gap-2 min-w-0">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent-tint)' }}>
                  <FileIcon size={14} className="accent-txt" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] txt font-medium truncate">{hl(r.m.fname || '')}</span>
                  <span className="block text-[10px] txt-dim">{fmtSize(r.m.size)}</span>
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] txt leading-relaxed truncate">{hl(r.body)}</div>
            )}
          </button>
        ))}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// 历史记录面板：按日期分组浏览当前会话全部消息
function HistoryPanel ({ title, messages, selfName, selfAvatar, onLocate, onOpenFile, onClose, displayNameForId, mentionNames }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('all')
  const [limit, setLimit] = useState(100)
  const needle = q.trim().toLowerCase()
  const filtered = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.system || m.recalled || m.burn) continue
    const isFile = m.type === 'file' || m.type === 'file-offer'
    const isImg = isFile && m.mime && m.mime.indexOf('image/') === 0
    if (tab === 'img' && !isImg) continue
    if (tab === 'file' && (!isFile || isImg)) continue
    if (needle) {
      const sender = m.self ? (selfName || '我') : (displayNameForId ? displayNameForId(m.from, m.name || '') : (m.name || ''))
      const hay = ((isFile ? (m.fname || '') : localizeMentionsText(m.text || '', mentionNames)) + ' ' + sender).toLowerCase()
      if (!hay.includes(needle)) continue
    }
    filtered.push(m)
  }

  const shown = filtered.slice(0, limit)
  let lastDayLabel = null

  return (
    <Overlay onClose={onClose}>
      <div className="floating-dialog floating-dialog-lg floating-surface glass-panel overflow-hidden" style={{ height: '80vh', maxHeight: 680 }} role="dialog" aria-modal="true" aria-label="历史记录">
        <div className="floating-titlebar">
          <History size={16} className="accent-txt shrink-0" />
          <span className="text-sm font-semibold txt truncate">历史记录</span>
          <span className="text-xs txt-dim truncate">· {title}</span>
          <button onClick={onClose} className="icon-btn ml-auto shrink-0"><X size={16} /></button>
        </div>

        <div className="px-4 py-2.5 flex items-center gap-2 border-b bd-soft shrink-0">
          <div className="field flex-1 min-w-0 rounded-full px-3 py-1.5 flex items-center gap-2">
            <Search size={13} className="txt-dim shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setLimit(100) }}
              placeholder="搜索历史记录"
              className="flex-1 min-w-0 bg-transparent outline-none text-xs txt"
              style={{ border: 'none', boxShadow: 'none' }}
            />
            {q && <button onClick={() => setQ('')} className="txt-dim hover:opacity-70 shrink-0"><X size={12} /></button>}
          </div>
          <div className="seg-tabs grid grid-cols-3 gap-1 text-xs shrink-0" style={{ width: 180 }}>
            <button onClick={() => { setTab('all'); setLimit(100) }} className={tab === 'all' ? 'seg-tab seg-tab-active' : 'seg-tab'}>全部</button>
            <button onClick={() => { setTab('img'); setLimit(100) }} className={tab === 'img' ? 'seg-tab seg-tab-active' : 'seg-tab'}>图片</button>
            <button onClick={() => { setTab('file'); setLimit(100) }} className={tab === 'file' ? 'seg-tab seg-tab-active' : 'seg-tab'}>文件</button>
          </div>
        </div>

        <div className="px-5 pt-2 text-[10.5px] txt-dim shrink-0">共 {filtered.length} 条记录，点击可定位到聊天记录。</div>

        <div className="flex-1 overflow-auto scroll px-3 py-2">
          {shown.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 select-none">
              <div className="text-3xl float-soft">空</div>
              <div className="text-xs txt-dim">{needle ? '没有匹配的记录' : '暂无聊天记录'}</div>
            </div>
          )}

          {shown.map((m) => {
            const day = dayLabel(m.ts)
            const showDay = day !== lastDayLabel
            lastDayLabel = day
            const isFile = m.type === 'file' || m.type === 'file-offer'
            const isImg = isFile && m.mime && m.mime.indexOf('image/') === 0
            const sender = m.self ? (selfName || '我') : (displayNameForId ? displayNameForId(m.from, m.name || '用户') : (m.name || '用户'))

            return (
              <div key={m.mid}>
                {showDay && <div className="px-2 pt-3 pb-1 text-[11px] font-semibold accent-txt">{day}</div>}
                <button onClick={() => onLocate(m.mid)} className="history-row w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left">
                  <Avatar name={sender} id={m.from || ''} avatar={m.self ? selfAvatar : m.avatar} size={28} />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-xs txt font-medium truncate">{sender}</span>
                      <span className="ml-auto text-[10px] txt-dim shrink-0">{fmtTime(m.ts).slice(0, 5)}</span>
                    </span>

                    {isImg && m.dataUrl ? (
                      <StaticImg src={m.dataUrl} alt={m.fname} className="mt-1 w-14 h-14 object-cover rounded-lg" style={{ border: '1px solid var(--border-soft)' }} />
                    ) : isFile ? (
                      <span className="mt-1 inline-flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--hover)', border: '1px solid var(--border-soft)' }}>
                        <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-tint)' }}>
                          <FileIcon size={12} className="accent-txt" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[11.5px] txt truncate max-w-[260px]">{m.fname}</span>
                          <span className="block text-[9.5px] txt-dim">{fmtSize(m.size)}</span>
                        </span>
                        {m.path && <span onClick={(e) => { e.stopPropagation(); onOpenFile(m.path) }} className="text-[10px] accent-txt hover:underline shrink-0 cursor-pointer">打开</span>}
                      </span>
                    ) : (
                      <span className="block mt-0.5 text-[12.5px] txt-dim leading-relaxed" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{localizeMentionsText(m.text, mentionNames)}</span>
                    )}
                  </span>
                </button>
              </div>
            )
          })}

          {filtered.length > limit && (
            <div className="flex justify-center py-2">
              <button onClick={() => setLimit((l) => l + 200)} className="btn-ghost text-xs rounded-lg px-4 py-1.5">
                加载更多（还有 {filtered.length - limit} 条）
              </button>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
// 截图编辑：选择区域、标注、复制 / 保存 / 发送，Esc 取消
const SHOT_COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#ffffff', '#111111']
function ShotScreen () {
  const [img, setImg] = useState('')
  const [rect, setRect] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState('select')
  const [annos, setAnnos] = useState([])
  const [draftRect, setDraftRect] = useState(null)
  const [textEdit, setTextEdit] = useState(null)
  const [color, setColor] = useState('#ff3b30')
  const [lineW, setLineW] = useState(3)
  const [fontSize, setFontSize] = useState(18)
  const startRef = useRef(null)
  const textEditRef = useRef(null)
  textEditRef.current = textEdit

  useEffect(() => {
    if (api && api.shot && api.shot.getImage) api.shot.getImage().then((d) => setImg(d || ''))
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (textEditRef.current) {
        setTextEdit(null)
        return
      }
      api.shot.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function commitTextEdit (te) {
    const t = te || textEditRef.current
    if (t && t.value.trim()) setAnnos((prev) => [...prev, { type: 'text', x: t.x, y: t.y, text: t.value.trim(), color, size: fontSize }])
    setTextEdit(null)
  }

  function onDown (e) {
    if (e.button !== 0) return
    if (mode === 'text') {
      if (textEdit) commitTextEdit()
      setTextEdit({ x: e.clientX, y: e.clientY, value: '' })
      return
    }
    startRef.current = { x: e.clientX, y: e.clientY }
    if (mode === 'select') setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
    else setDraftRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
    setDragging(true)
  }

  function onMove (e) {
    if (!dragging || !startRef.current) return
    const s = startRef.current
    const r = { x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) }
    if (mode === 'select') setRect(r)
    else setDraftRect(r)
  }

  function onUp () {
    if (mode === 'select') {
      // 选区完成后自动进入文字模式：在选区内单击即聚焦输入
      if (rect && rect.w > 3 && rect.h > 3) setMode('text')
    } else if (mode === 'rect' && draftRect && draftRect.w > 3 && draftRect.h > 3) {
      setAnnos((prev) => [...prev, { type: 'rect', ...draftRect, color, width: lineW }])
    }
    setDraftRect(null)
    setDragging(false)
  }

  function cropAndExport () {
    return new Promise((resolve) => {
      if (!rect || rect.w < 3 || rect.h < 3) return resolve(null)
      const image = new Image()
      image.onload = () => {
        try {
          const sx = image.naturalWidth / window.innerWidth
          const sy = image.naturalHeight / window.innerHeight
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round(rect.w * sx))
          c.height = Math.max(1, Math.round(rect.h * sy))
          const ctx = c.getContext('2d')
          ctx.drawImage(image, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, c.width, c.height)
          for (const a of annos) {
            if (a.type === 'rect') {
              ctx.strokeStyle = a.color
              ctx.lineWidth = Math.max(1, a.width * sx)
              ctx.strokeRect((a.x - rect.x) * sx, (a.y - rect.y) * sy, a.w * sx, a.h * sy)
            } else if (a.type === 'text') {
              ctx.fillStyle = a.color
              ctx.font = '600 ' + Math.round(a.size * sx) + 'px "Microsoft YaHei", sans-serif'
              ctx.textBaseline = 'top'
              ctx.fillText(a.text, (a.x - rect.x) * sx, (a.y - rect.y) * sy)
            }
          }
          resolve(c.toDataURL('image/png'))
        } catch (_) {
          resolve(null)
        }
      }
      image.onerror = () => resolve(null)
      image.src = img
    })
  }

  async function act (kind) {
    if (textEdit) commitTextEdit()
    const dataUrl = await cropAndExport()
    if (!dataUrl) { api.shot.cancel(); return }
    if (kind === 'save') api.shot.save(dataUrl)
    else api.shot.done(dataUrl) // 完成：写入发送框并复制到剪贴板（主进程处理）
  }

  const showToolbar = rect && !dragging && rect.w > 3 && rect.h > 3
  const toolbarStyle = showToolbar ? {
    left: Math.max(8, Math.min(rect.x, window.innerWidth - 420)),
    top: rect.y + rect.h + 8 > window.innerHeight - 86 ? Math.max(8, rect.y - 86) : rect.y + rect.h + 8,
  } : null
  const toolBtn = (active) => ({ fontSize: 12, padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', color: active ? '#fff' : '#ccc', background: active ? '#4f8cff' : 'rgba(255,255,255,0.1)' })
  const sizeOpts = mode === 'text'
    ? [{ v: 14, l: '小' }, { v: 18, l: '中' }, { v: 26, l: '大' }]
    : [{ v: 2, l: '细' }, { v: 3, l: '中' }, { v: 6, l: '粗' }]
  const sizeVal = mode === 'text' ? fontSize : lineW
  const setSizeVal = (v) => (mode === 'text' ? setFontSize(v) : setLineW(v))

  return (
    <div onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} style={{ position: 'fixed', inset: 0, cursor: mode === 'text' ? 'text' : 'crosshair', userSelect: 'none', background: '#000', overflow: 'hidden' }}>
      {img && <img src={img} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh' }} />}
      {/* 选区只保留框线：去除遮罩背景、尺寸标签与提示横幅 */}
      {rect && (
        <div style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, border: '1.5px solid #4f8cff', pointerEvents: 'none' }} />
      )}
      {annos.map((a, i) => a.type === 'rect'
        ? <div key={i} style={{ position: 'absolute', left: a.x, top: a.y, width: a.w, height: a.h, border: a.width + 'px solid ' + a.color, borderRadius: 2, pointerEvents: 'none' }} />
        : <div key={i} style={{ position: 'absolute', left: a.x, top: a.y, color: a.color, fontSize: a.size, fontWeight: 600, fontFamily: '"Microsoft YaHei", sans-serif', textShadow: '0 0 3px rgba(0,0,0,0.45)', pointerEvents: 'none', whiteSpace: 'pre' }}>{a.text}</div>)}
      {draftRect && <div style={{ position: 'absolute', left: draftRect.x, top: draftRect.y, width: draftRect.w, height: draftRect.h, border: lineW + 'px dashed ' + color, borderRadius: 2, pointerEvents: 'none' }} />}
      {textEdit && (
        <input
          autoFocus
          value={textEdit.value}
          onChange={(e) => setTextEdit((t) => ({ ...t, value: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTextEdit() } }}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="输入文字，回车确认"
          style={{ position: 'absolute', left: textEdit.x, top: textEdit.y, minWidth: 160, color, fontSize, fontWeight: 600, fontFamily: '"Microsoft YaHei", sans-serif', background: 'rgba(0,0,0,0.35)', border: '1px dashed ' + color, borderRadius: 4, outline: 'none', padding: '2px 6px' }}
        />
      )}
      {showToolbar && (
        <div onMouseDown={(e) => e.stopPropagation()} style={{ position: 'absolute', ...toolbarStyle, display: 'flex', flexDirection: 'column', gap: 6, background: 'rgba(28,28,32,0.95)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 10, padding: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => { if (textEdit) commitTextEdit(); setMode('rect') }} style={toolBtn(mode === 'rect')} title="绘制矩形标注">矩形</button>
            <button onClick={() => setMode('text')} style={toolBtn(mode === 'text')} title="输入文字标注">文本</button>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)' }} />
            {SHOT_COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} title={c} style={{ width: 16, height: 16, borderRadius: '50%', background: c, cursor: 'pointer', border: color === c ? '2px solid #4f8cff' : '1.5px solid rgba(255,255,255,0.4)', padding: 0 }} />
            ))}
            {(mode === 'rect' || mode === 'text') && <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)' }} />}
            {(mode === 'rect' || mode === 'text') && sizeOpts.map((o) => (
              <button key={o.v} onClick={() => setSizeVal(o.v)} style={toolBtn(sizeVal === o.v)}>{o.l}</button>
            ))}
            {annos.length > 0 && <button onClick={() => setAnnos((p) => p.slice(0, -1))} style={toolBtn(false)} title="撤销上一项">撤销</button>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[{ k: 'save', label: '保存' }, { k: 'cancel', label: '取消' }, { k: 'send', label: '发送' }].map((b) => (
              <button
                key={b.k}
                onClick={() => (b.k === 'cancel' ? api.shot.cancel() : act(b.k))}
                style={{ flex: 1, fontSize: 12, padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', color: b.k === 'send' ? '#fff' : '#ddd', background: b.k === 'send' ? '#4f8cff' : 'rgba(255,255,255,0.1)' }}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 群文件面板（极简展示，详情走悬浮提示）============
function fmtShareTime (ts) {
  if (!ts) return ''
  const d = new Date(ts); const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// Electron 渲染进程不支持 window.prompt，统一用应用内输入框
function ShareInputDialog ({ title, placeholder, initial, onOk, onClose }) {
  const [v, setV] = useState(initial || '')
  const submit = () => { if (v.trim()) { onOk(v.trim()); onClose() } }
  return (
    <Overlay onClose={onClose}>
      <div className="floating-dialog floating-dialog-sm floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label={title}>
        <div className="text-sm font-semibold txt mb-3 floating-long-text">{title}</div>
        <input autoFocus value={v} placeholder={placeholder || ''} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} className={FIELD} />
        <div className="floating-actions">
          <button onClick={onClose} className="btn-ghost text-xs rounded-lg px-3 py-1.5">取消</button>
          <button onClick={submit} className="btn-primary text-xs rounded-lg px-3 py-1.5">确定</button>
        </div>
      </div>
    </Overlay>
  )
}

function ShareSpacePanel ({ room, self, peers, nameById, onClose, requestConfirm, onForwardEntry, initialTarget }) {
  const [spaces, setSpaces] = useState([])
  const [space, setSpace] = useState(null)
  const [parentId, setParentId] = useState('root')
  const [dir, setDir] = useState(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDir, setNewDir] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [search, setSearch] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalResults, setGlobalResults] = useState([])
  const [globalSearching, setGlobalSearching] = useState(false)
  const [spaceResults, setSpaceResults] = useState([])
  const [spaceSearching, setSpaceSearching] = useState(false)
  const [conflict, setConflict] = useState(null)
  const [inputDlg, setInputDlg] = useState(null)
  const [progress, setProgress] = useState(null) // 上传/下载进度 { pct, dir }
  const [uploadBatch, setUploadBatch] = useState(null) // 多文件上传计数 { done, total }
  const [selected, setSelected] = useState({}) // 已选文件/文件夹 entryId -> true
  const queueRef = useRef([])
  const queueTargetRef = useRef('root') // 当前上传队列的目标目录
  const uploadTotalRef = useRef(0)
  const uploadDoneRef = useRef(0)
  const uploadFolderActiveRef = useRef(false)
  const targetKeyRef = useRef('')
  const locatingTargetRef = useRef(false)
  const spaceRef = useRef(null); spaceRef.current = space
  const parentRef = useRef('root'); parentRef.current = parentId
  const currentSpaceId = space ? space.spaceId : ''

  const nameOf = (id) => (id === (self && self.id) ? '我' : ((nameById && nameById[id]) || (peers.find((p) => p.id === id) || {}).name || String(id || '').slice(0, 6)))

  async function refreshSpaces () { const list = await api.share.list(room.id); setSpaces(list || []) }
  useEffect(() => { refreshSpaces() }, [room.id])
  useEffect(() => {
    const t = initialTarget
    if (!t || !t.spaceId || !spaces.length) return
    const key = [t.nonce || '', t.spaceId, t.entryId || '', t.parentId || ''].join(':')
    if (targetKeyRef.current === key) return
    targetKeyRef.current = key
    const sp = spaces.find((x) => x.spaceId === t.spaceId)
    if (!sp) { setMsg('群文件不存在或已删除'); return }
    ;(async () => {
      locatingTargetRef.current = true
      setSpace(sp)
      setSearch('')
      const targetDir = t.entryType === 'folder' ? (t.entryId || 'root') : (t.parentId || 'root')
      await loadDir(sp, targetDir, false)
      setSelected(t.entryType === 'folder' || !t.entryId ? {} : { [t.entryId]: true })
      if (t.name) setMsg('已定位：' + t.name)
      setTimeout(() => { locatingTargetRef.current = false }, 0)
    })()
  }, [initialTarget, spaces])
  useEffect(() => { if (!locatingTargetRef.current) setSelected({}) }, [parentId, space]) // 切换目录/空间时清空批量勾选（刷新不变 parentId 故保留）
  useEffect(() => {
    const un = api.share.onChanged(() => { refreshSpaces(); if (spaceRef.current) loadDir(spaceRef.current, parentRef.current, true) })
    const un2 = api.share.onDownloaded((d) => { setMsg('已下载：' + d.fname); setProgress(null) })
    const un3 = api.share.onDownloadFailed((d) => { setMsg('下载失败：' + (d.error || '')); setProgress(null) })
    const un4 = api.share.onProgress && api.share.onProgress((p) => {
      if (p && p.op === 'uploadFolder') {
        if (!uploadFolderActiveRef.current) return
        setUploadBatch({ done: p.done || 0, total: p.total || 0, failed: p.failed || 0 })
        setMsg('上传文件夹中… 已上传 ' + (p.done || 0) + '/' + (p.total || 0))
        return
      }
      const pct = p.size ? Math.min(100, Math.round((p.received / p.size) * 100)) : 0
      setProgress(pct >= 100 ? null : { pct, dir: p.dir })
    })
    return () => { un && un(); un2 && un2(); un3 && un3(); un4 && un4() }
  }, [])
  useEffect(() => {
    const q = globalSearch.trim()
    if (space || !q || !api.share.search) { setGlobalResults([]); setGlobalSearching(false); return undefined }
    let alive = true
    setGlobalSearching(true)
    const timer = setTimeout(async () => {
      const r = await api.share.search(room.id, q)
      if (!alive) return
      setGlobalResults((r && r.ok && r.results) || [])
      setGlobalSearching(false)
    }, 220)
    return () => { alive = false; clearTimeout(timer) }
  }, [globalSearch, room.id, space])
  useEffect(() => {
    const q = search.trim()
    if (!currentSpaceId || !q || !api.share.search) { setSpaceResults([]); setSpaceSearching(false); return undefined }
    let alive = true
    setSpaceSearching(true)
    const timer = setTimeout(async () => {
      const r = await api.share.search(room.id, q, currentSpaceId)
      if (!alive) return
      setSpaceResults((r && r.ok && r.results) || [])
      setSpaceSearching(false)
    }, 220)
    return () => { alive = false; clearTimeout(timer) }
  }, [search, room.id, currentSpaceId])

  async function loadDir (sp, pid, silent) {
    if (!silent) { setLoading(true); setMsg('') }
    const r = await api.share.dir(sp.spaceId, pid)
    setLoading(false)
    if (r && (r.ok || r.entries)) { setDir(r); setParentId(r.parentId || pid) }
    else { setDir({ entries: [], breadcrumb: [{ entryId: 'root', name: '根目录' }], offline: r && r.offline, error: r && r.error }); if (r && r.error && !silent) setMsg(r.error) }
    return r
  }
  function openSpace (sp) { setSpace(sp); setParentId('root'); setSearch(''); setGlobalSearch(''); loadDir(sp, 'root') }
  function back () { const bc = dir && dir.breadcrumb; if (bc && bc.length > 1) loadDir(space, bc[bc.length - 2].entryId) }
  function searchResultPath (r) {
    const crumbs = (r && Array.isArray(r.breadcrumb)) ? r.breadcrumb : []
    const base = r && r.pathText ? r.pathText : crumbs.map((c) => c.name).join(' / ')
    return base || (r && r.name) || ''
  }
  async function openSearchResult (r) {
    if (!r) return
    const sp = spaces.find((x) => x.spaceId === r.spaceId) || r.space
    if (!sp) { setMsg('群文件不存在或已删除'); return }
    locatingTargetRef.current = true
    setSpace(sp)
    setSearch('')
    setGlobalSearch('')
    const targetDir = r.type === 'folder' ? (r.entryId || 'root') : (r.parentId || 'root')
    await loadDir(sp, targetDir, false)
    setSelected(r.type === 'file' && r.entryId ? { [r.entryId]: true } : {})
    setMsg('已定位：' + (r.name || ''))
    setTimeout(() => { locatingTargetRef.current = false }, 0)
  }

  async function createSpace () {
    const n = newName.trim()
    if (!n) { setMsg('请输入空间名称'); return }
    const r = await api.share.create(room.id, n, newDir || undefined)
    if (r && r.ok) { setCreating(false); setNewName(''); setNewDir(''); refreshSpaces(); openSpace(r.space) }
    else setMsg((r && r.error) || '创建失败')
  }
  async function chooseHostDir () { const r = await api.share.chooseDir(); if (r && r.ok) setNewDir(r.dir) }

  function newFolder () {
    setInputDlg({ title: '新建文件夹', placeholder: '文件夹名称', value: '', onOk: async (name) => {
      const r = await api.share.createFolder(space.spaceId, parentId, name)
      if (r && r.ok) { setMsg('文件夹已创建'); loadDir(space, parentId, true) } else setMsg((r && r.error) || '创建失败')
    } })
  }
  async function processQueue () {
    const q = queueRef.current
    const target = queueTargetRef.current
    while (q.length) {
      const p = q[0]
      setUploadBatch({ done: uploadDoneRef.current, total: uploadTotalRef.current })
      setMsg('上传中… 已上传 ' + uploadDoneRef.current + '/' + uploadTotalRef.current)
      const r = await api.share.upload(space.spaceId, target, [p])
      const res = r && r.results && r.results[0]
      if (res && res.conflict) { setConflict({ path: p, entryId: res.entryId, name: res.name }); return }
      q.shift()
      if (res && res.ok) uploadDoneRef.current += 1
      setUploadBatch({ done: uploadDoneRef.current, total: uploadTotalRef.current })
      if (res && res.oversize) setMsg('「' + (res.name || '文件') + '」超过 5GB 上限，未上传')
      else if (res && !res.ok && !res.conflict) setMsg('上传失败：' + (res.error || res.offline && '主机离线' || ''))
    }
    setConflict(null); setProgress(null); loadDir(space, parentId, true); setMsg('上传完成：已上传 ' + uploadDoneRef.current + '/' + uploadTotalRef.current); setUploadBatch(null)
  }
  function startFileUpload (target, paths) {
    if (!paths || !paths.length) return
    queueTargetRef.current = target || parentId
    queueRef.current = paths.slice()
    uploadTotalRef.current = paths.length
    uploadDoneRef.current = 0
    setUploadBatch({ done: 0, total: paths.length })
    setMsg('上传中… 已上传 0/' + paths.length); processQueue()
  }
  async function uploadFiles () {
    const r = await api.share.pickFiles()
    if (!r || !r.ok) return
    startFileUpload(parentId, r.paths)
  }
  async function uploadFolderTo (target, dirPath) {
    uploadFolderActiveRef.current = true
    setUploadBatch({ done: 0, total: 0, failed: 0 })
    setMsg('上传文件夹中… 已上传 0/0')
    let res
    try {
      res = await api.share.uploadFolder(space.spaceId, target || parentId, dirPath)
    } finally {
      uploadFolderActiveRef.current = false
    }
    const ov = res && res.summary && res.summary.oversize ? '，' + res.summary.oversize + ' 个超 5GB 已跳过' : ''
    if (res && res.ok) setMsg('文件夹上传完成：总文件数 ' + (res.summary.total || res.summary.files || 0) + ' · 已上传 ' + res.summary.files + '（' + res.summary.folders + ' 目录）')
    else setMsg('文件夹上传：' + ((res && res.error) || (res && res.summary && ('总文件数 ' + (res.summary.total || 0) + ' · 已上传 ' + res.summary.files + '，失败/跳过 ' + res.summary.failed + ' 项' + ov)) || '失败'))
    setProgress(null); setUploadBatch(null); loadDir(space, parentId, true)
  }
  async function uploadFolder () {
    const r = await api.share.pickFolder()
    if (!r || !r.ok) return
    uploadFolderTo(parentId, r.path)
  }
  async function resolveConflictRename () {
    const c = conflict; setConflict(null)
    const target = queueTargetRef.current
    const r = await api.share.upload(space.spaceId, target, [c.path], true)
    const res = r && r.results && r.results[0]
    if (res && res.ok) uploadDoneRef.current += 1
    setUploadBatch({ done: uploadDoneRef.current, total: uploadTotalRef.current })
    queueRef.current.shift()
    processQueue()
  }
  // 批量选择
  function toggleSelect (id) { setSelected((s) => { const n = { ...s }; if (n[id]) delete n[id]; else n[id] = true; return n }) }
  const selectedEntries = () => (dir && dir.entries || []).filter((e) => selected[e.entryId])
  const selectedFolders = () => selectedEntries().filter((e) => e.type === 'folder')
  function clearSelection () { setSelected({}) }
  // 批量下载：选目标目录一次，逐个下载选中条目到该目录（文件夹保留目录结构）
  async function downloadSelected () {
    const entries = selectedEntries()
    if (!entries.length) { setMsg('请先勾选要下载的文件或文件夹'); return }
    const d = await api.share.chooseDir()
    if (!d || !d.ok) return
    let ok = 0; let fail = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      setMsg('下载中… ' + (i + 1) + '/' + entries.length + '：' + e.name)
      const r = await api.share.download(space.spaceId, e.entryId, e.name, d.dir)
      if (r && r.ok) ok++; else fail++
    }
    setProgress(null)
    setMsg('下载完成：成功 ' + ok + (fail ? '，失败 ' + fail : '') + ' 项 → ' + d.dir)
    clearSelection()
  }
  function rename (entry) {
    if (!entry || entry.type !== 'folder') { setMsg('仅文件夹支持重命名'); return }
    setInputDlg({ title: '重命名', placeholder: '新名称', value: entry.name, onOk: async (nn) => {
      const r = await api.share.rename(space.spaceId, entry.entryId, nn)
      if (r && r.ok) { setMsg('已重命名'); clearSelection(); loadDir(space, parentId, true) } else setMsg((r && r.error) || '重命名失败')
    } })
  }
  async function deleteSelected () {
    const entries = selectedEntries()
    if (!entries.length) { setMsg('请先勾选要删除的文件或文件夹'); return }
    const hasFolder = entries.some((e) => e.type === 'folder')
    const names = entries.slice(0, 3).map((e) => e.name).join('、') + (entries.length > 3 ? ' 等' : '')
    const tip = hasFolder ? '删除文件夹会同时删除其下所有内容。' : ''
    const run = async () => {
      let ok = 0; let fail = 0
      for (const e of entries) {
        const r = await api.share.remove(space.spaceId, e.entryId)
        if (r && r.ok) ok++; else fail++
      }
      setMsg('删除完成：成功 ' + ok + (fail ? '，失败 ' + fail : '') + ' 项')
      clearSelection()
      loadDir(space, parentId, true)
    }
    if (requestConfirm) {
      requestConfirm({
        title: '删除共享空间项目',
        text: '删除选中的 ' + entries.length + ' 项「' + names + '」？' + tip + '删除后不可恢复。',
        confirmText: '删除',
        run,
      })
    } else {
      await run()
    }
  }

  async function forwardEntry (entry) {
    if (!entry || !onForwardEntry) return
    const res = await onForwardEntry(space, entry, parentId, (dir && dir.breadcrumb) || [])
    if (res && res.ok) { setMsg('已转发到本群'); clearSelection() }
    else setMsg((res && res.error) || '转发失败')
  }

  const sorted = useMemo(() => {
    let list = (dir && dir.entries) || []
    const dirsFirst = (a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1)
    list = list.slice().sort((a, b) => dirsFirst(a, b) || (
      sortKey === 'size' ? (b.size || 0) - (a.size || 0)
        : sortKey === 'time' ? (b.updatedAt || 0) - (a.updatedAt || 0)
          : sortKey === 'type' ? String(a.ext).localeCompare(String(b.ext))
            : a.name.localeCompare(b.name, 'zh')))
    return list
  }, [dir, sortKey])
  const showingSpaceSearch = !!search.trim()

  // ---------- 列表页（未进入空间）----------
  if (!space) {
    return (
      <Overlay onClose={onClose}>
        <div className="floating-dialog floating-dialog-lg floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="群文件">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold txt flex items-center gap-2"><HardDrive size={16} className="accent-txt" /> 群文件 · {room.name}</div>
            <div className="flex items-center gap-1">
              <button onClick={() => setCreating((v) => !v)} className="icon-btn" title="新建群文件"><Plus size={16} /></button>
              <button onClick={onClose} className="icon-btn"><X size={15} /></button>
            </div>
          </div>
          {creating && (
            <div className="mb-3 p-3 rounded-xl bd-soft border space-y-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="群文件名称" className={FIELD} />
              <div className="flex items-center gap-2">
                <button onClick={chooseHostDir} className="btn-ghost text-xs rounded-lg px-2 py-1.5 shrink-0" title="可选：自定义本机存储目录，默认应用数据目录">选择存储目录</button>
                <span className="text-[11px] txt-dim truncate flex-1" title={newDir}>{newDir || '默认：应用数据目录 group_shares/'}</span>
              </div>
              <div className="text-[11px] txt-dim">创建后你的电脑将成为该空间的共享主机，数据存储在本机。</div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setCreating(false)} className="btn-ghost text-xs rounded-lg px-3 py-1.5">取消</button>
                <button onClick={createSpace} className="btn-primary text-xs rounded-lg px-3 py-1.5">创建</button>
              </div>
            </div>
          )}
          <div className="relative mb-3">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 txt-dim" />
            <input value={globalSearch} onChange={(e) => setGlobalSearch(e.target.value)} placeholder="全局搜索文件 / 文件夹" className="field w-full text-xs rounded-lg pl-8 pr-3 py-2" />
          </div>
          {msg && <div className="mb-2 text-[11px] accent-txt">{msg}</div>}
          {globalSearch.trim() ? (
            <div className="space-y-1.5 max-h-[60vh] overflow-auto scroll pr-1">
              {globalSearching ? <div className="text-xs txt-dim py-8 text-center">搜索中…</div>
                : !globalResults.length ? <div className="text-xs txt-dim py-8 text-center">没有匹配的文件或文件夹</div>
                  : globalResults.map((r) => (
                    <button key={(r.spaceId || '') + ':' + r.entryId} onClick={() => openSearchResult(r)} className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--hover)] bd-soft border text-left">
                      {r.type === 'folder' ? <Folder size={22} className="accent-txt shrink-0" /> : <FileIcon size={22} className="txt-dim shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{r.name}</div>
                        <div className="text-[11px] txt-dim truncate" title={(r.spaceName || '') + ' · ' + searchResultPath(r)}>{r.spaceName || '群文件'} · {searchResultPath(r)}{r.cached ? ' · 缓存' : ''}</div>
                      </div>
                      <span className="text-[11px] txt-dim shrink-0">{r.type === 'file' ? fmtSize(r.size) : '文件夹'}</span>
                    </button>
                  ))}
            </div>
          ) : !spaces.length ? <div className="text-xs txt-dim py-8 text-center">还没有群文件，点击右上角 + 创建</div>
            : (
              <div className="space-y-1.5 max-h-[60vh] overflow-auto scroll pr-1">
                {spaces.map((sp) => (
                  <div key={sp.spaceId} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--hover)] bd-soft border" title={'创建者: ' + nameOf(sp.createdBy) + '\n共享主机: ' + nameOf(sp.hostUserId) + '\n主机设备: ' + (sp.hostDeviceId || '-') + '\n创建时间: ' + fmtShareTime(sp.createdAt)}>
                    <Folder size={26} className={sp.online ? 'accent-txt' : 'txt-dim'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium truncate">{sp.name}
                        {sp.online ? <span className="text-[10px] px-1.5 rounded-full bg-green-500/15 text-green-600">在线</span>
                          : <span className="text-[10px] px-1.5 rounded-full bg-gray-400/15 txt-dim inline-flex items-center gap-0.5"><WifiOff size={9} />离线</span>}
                      </div>
                      <div className="text-[11px] txt-dim truncate">主机 {nameOf(sp.hostUserId)} · {sp.fileCount || 0} 文件 · {fmtShareTime(sp.updatedAt) || '—'}</div>
                    </div>
                    {sp.createdBy === (self && self.id) && <button onClick={() => {
                      const run = async () => {
                        const r = await api.share.deleteSpace(sp.spaceId)
                        if (r && !r.ok && r.error) setMsg(r.error)
                        refreshSpaces()
                      }
                      if (requestConfirm) requestConfirm({ title: '删除群文件', text: '删除群文件「' + sp.name + '」？删除后该共享空间将不可恢复。', confirmText: '删除', run })
                      else run()
                    }} className="icon-btn shrink-0" title="删除群文件（仅创建者）"><Trash2 size={14} /></button>}
                    <button onClick={() => openSpace(sp)} disabled={!sp.online} className="text-xs btn-primary rounded-lg px-3 py-1.5 shrink-0 disabled:opacity-40">进入</button>
                  </div>
                ))}
              </div>
            )}
        </div>
      </Overlay>
    )
  }

  // ---------- 目录页（已进入空间）----------
  const bc = (dir && dir.breadcrumb) || [{ entryId: 'root', name: '根目录' }]
  return (
    <Overlay onClose={onClose}>
      <div className="floating-dialog floating-dialog-xl floating-surface glass-panel floating-dialog-pad flex flex-col" style={{ height: '78vh' }} role="dialog" aria-modal="true" aria-label="群文件目录">
        <div className="flex items-center gap-2 mb-2">
          <button onClick={() => { setSpace(null); setDir(null) }} className="icon-btn" title="返回空间列表"><ArrowLeft size={16} /></button>
          <div className="text-sm font-semibold txt flex items-center gap-1.5 min-w-0"><Folder size={15} className="accent-txt shrink-0" /><span className="truncate">{space.name}</span></div>
          {dir && dir.offline && <span className="text-[10px] px-1.5 rounded-full bg-amber-500/15 text-amber-600 shrink-0" title="共享主机离线，展示的是本地缓存快照，可能不是最新">缓存数据，可能不是最新</span>}
          <div className="flex-1" />
          <button onClick={() => loadDir(space, parentId)} className="icon-btn" title="刷新"><RefreshCw size={15} /></button>
          <button onClick={onClose} className="icon-btn"><X size={15} /></button>
        </div>

        <div className="flex items-center gap-1 text-[12px] txt-dim mb-2 flex-wrap">
          {bc.map((c, i) => (
            <span key={c.entryId} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="opacity-50" />}
              <button onClick={() => loadDir(space, c.entryId)} className={'hover:underline ' + (i === bc.length - 1 ? 'accent-txt font-medium' : '')}>{c.name}</button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <button onClick={back} disabled={bc.length <= 1} className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><ArrowLeft size={13} />上级</button>
          <button onClick={newFolder} disabled={dir && dir.offline} className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><FolderPlus size={13} />新建文件夹</button>
          <button onClick={uploadFiles} disabled={dir && dir.offline} title="单文件上限 5GB" className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><Upload size={13} />上传文件</button>
          <button onClick={uploadFolder} disabled={dir && dir.offline} title="单文件上限 5GB，超出的文件会被跳过" className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><FolderOpen size={13} />上传文件夹</button>
          <div className="flex-1" />
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="field text-xs rounded-lg px-1.5 py-1.5" title="排序">
            <option value="name">名称</option><option value="type">类型</option><option value="size">大小</option><option value="time">修改时间</option>
          </select>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索当前群文件" className="field text-xs rounded-lg px-2 py-1.5 w-32" />
        </div>
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className="text-xs txt-dim shrink-0 ml-1">已选 {selectedEntries().length} 项</span>
          <button onClick={() => { const all = {}; sorted.forEach((e) => { all[e.entryId] = true }); setSelected(all) }} disabled={showingSpaceSearch || !sorted.length} className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40">全选</button>
          <button onClick={clearSelection} disabled={!selectedEntries().length} className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40">清空</button>
          <button onClick={downloadSelected} disabled={showingSpaceSearch || !selectedEntries().length || (dir && dir.offline)} className="btn-primary text-xs rounded-lg px-3 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><Download size={13} />下载</button>
          <button onClick={deleteSelected} disabled={showingSpaceSearch || !selectedEntries().length || (dir && dir.offline)} className="btn-ghost text-xs rounded-lg px-3 py-1.5 disabled:opacity-40 inline-flex items-center gap-1 text-red-500"><Trash2 size={13} />删除</button>
          <button onClick={() => rename(selectedFolders()[0])} disabled={showingSpaceSearch || selectedEntries().length !== 1 || selectedFolders().length !== 1 || (dir && dir.offline)} className="btn-ghost text-xs rounded-lg px-2 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"><Pencil size={13} />重命名</button>
        </div>

        {msg && <div className="mb-1.5 text-[11px] accent-txt truncate" title={msg}>{msg}</div>}
        {uploadBatch && <div className="mb-1.5 text-[11px] txt-dim">总文件数 {uploadBatch.total} · 已上传 {uploadBatch.done}{uploadBatch.failed ? ' · 失败/跳过 ' + uploadBatch.failed : ''}</div>}
        {progress && (
          <div className="mb-2">
            <div className="flex justify-between text-[10px] txt-dim mb-0.5"><span>{progress.dir === 'out' ? '上传中' : '下载中'}</span><span>{progress.pct}%</span></div>
            <div className="h-1.5 rounded-full bg-black/10 overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: progress.pct + '%', background: 'var(--accent)' }} /></div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto rounded-xl bd-soft border divide-y">
          {loading ? <div className="text-xs txt-dim py-10 text-center">加载中…</div>
            : showingSpaceSearch ? (
              spaceSearching ? <div className="text-xs txt-dim py-10 text-center">搜索中…</div>
                : !spaceResults.length ? <div className="text-xs txt-dim py-10 text-center">没有匹配的文件或文件夹</div>
                  : spaceResults.map((r) => (
                    <button key={(r.spaceId || '') + ':' + r.entryId} onClick={() => openSearchResult(r)} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-[var(--hover)] text-left">
                      {r.type === 'folder' ? <Folder size={18} className="accent-txt shrink-0" /> : <FileIcon size={18} className="txt-dim shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{r.name}</div>
                        <div className="text-[11px] txt-dim truncate" title={searchResultPath(r)}>{searchResultPath(r)}{r.cached ? ' · 缓存' : ''}</div>
                      </div>
                      <span className="txt-dim shrink-0 w-16 text-right">{r.type === 'file' ? fmtSize(r.size) : '文件夹'}</span>
                    </button>
                  ))
            ) : dir && dir.offline && !dir.entries.length ? <div className="text-xs txt-dim py-10 text-center"><WifiOff size={22} className="mx-auto mb-2 opacity-60" />共享主机离线，暂时不可访问</div>
              : !sorted.length ? <div className="text-xs txt-dim py-10 text-center">空目录</div>
                : sorted.map((e) => (
                  <div key={e.entryId} className={'flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-[var(--hover)]' + (selected[e.entryId] ? ' bg-[var(--accent-tint)]' : '')}
                    title={e.type === 'file' ? ('大小: ' + fmtSize(e.size) + '\n更新者: ' + nameOf(e.updatedBy) + '\n更新: ' + fmtShareTime(e.updatedAt)) : ('创建者: ' + nameOf(e.createdBy) + '\n创建: ' + fmtShareTime(e.createdAt))}>
                    <input type="checkbox" checked={!!selected[e.entryId]} onChange={() => toggleSelect(e.entryId)} className="shrink-0 accent-[var(--accent)]" />
                    {e.type === 'folder'
                      ? <button onClick={() => loadDir(space, e.entryId)} className="flex items-center gap-2.5 flex-1 min-w-0 text-left"><Folder size={18} className="accent-txt shrink-0" /><span className="truncate font-medium">{e.name}</span></button>
                      : <div onClick={() => toggleSelect(e.entryId)} className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer"><FileIcon size={18} className="txt-dim shrink-0" /><span className="truncate">{e.name}</span></div>}
                    <button onClick={(ev) => { ev.stopPropagation(); forwardEntry(e) }} className="icon-btn shrink-0" title="转发到本群"><Forward size={14} /></button>
                    <span className="txt-dim shrink-0 w-16 text-right">{e.type === 'file' ? fmtSize(e.size) : ''}</span>
                    <span className="txt-dim shrink-0 w-24 text-right hidden sm:block">{fmtShareTime(e.updatedAt)}</span>
                  </div>
                ))}
        </div>
      </div>
      {inputDlg && <ShareInputDialog title={inputDlg.title} placeholder={inputDlg.placeholder} initial={inputDlg.value} onOk={inputDlg.onOk} onClose={() => setInputDlg(null)} />}
      {conflict && (
        <Overlay onClose={() => { setConflict(null); queueRef.current.shift(); processQueue() }}>
          <div className="floating-dialog floating-dialog-sm floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="同名文件已存在">
            <div className="text-sm font-semibold txt">同名文件已存在</div>
            <div className="mt-2 floating-subtle floating-long-text">「{conflict.name}」已存在。请选择处理方式（不会覆盖原文件）：</div>
            <div className="mt-4 flex flex-col gap-2">
              <button onClick={resolveConflictRename} className="btn-primary text-xs rounded-lg px-3 py-2">改名为新文件</button>
              <button onClick={() => { setConflict(null); queueRef.current.shift(); processQueue() }} className="btn-ghost text-xs rounded-lg px-3 py-2">跳过此文件</button>
            </div>
          </div>
        </Overlay>
      )}
    </Overlay>
  )
}

function ChatScreen ({ onLock, onReset, setDisplay, standaloneConv }) {
  const standalone = !!standaloneConv
  const [self, setSelf] = useState(null)
  const [peers, setPeers] = useState([])
  const [active, setActive] = useState(standaloneConv === 'group' ? '' : (standaloneConv || ''))
  const [convos, setConvos] = useState({})
  const [reads, setReads] = useState({}) // 各会话已读位(ts)；未读数由 convos + reads 派生
  const [nameById, setNameById] = useState({})
  const [text, setText] = useState('')
  const [netError, setNetError] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [profilePeer, setProfilePeer] = useState(null)
  const [searchPane, setSearchPane] = useState(false)
  const [flashMid, setFlashMid] = useState(null)
  const [presenceOpen, setPresenceOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, m } 消息鍙抽敭鑿滃崟
  const [sideMenu, setSideMenu] = useState(null) // { x, y, item } 好友列表右键菜单
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiTab, setEmojiTab] = useState('emoji') // emoji | sticker，与 emoji 同层级的表情包标签
  const [emojiVisibleCount, setEmojiVisibleCount] = useState(EMOJI_BATCH)
  const [stickerVisibleCount, setStickerVisibleCount] = useState(STICKER_BATCH)
  const [stickers, setStickers] = useState([])
  const stickersLoadedRef = useRef(false)
  const [fontOpen, setFontOpen] = useState(false)
  const [fontDraft, setFontDraft] = useState(13.5)
  const [paneWidth, setPaneWidth] = useState(0)
  const [visibleCount, setVisibleCount] = useState(MSG_PAGE)
  const visibleCountRef = useRef(MSG_PAGE); visibleCountRef.current = visibleCount
  const loadingOlderRef = useRef(false)
  const prevScrollGapRef = useRef(0)
  const fontPanelRef = useRef(null)
  const fontBtnRef = useRef(null)
  useEffect(() => {
    if (!fontOpen) return undefined
    const onDown = (e) => {
      if (fontPanelRef.current && fontPanelRef.current.contains(e.target)) return
      if (fontBtnRef.current && fontBtnRef.current.contains(e.target)) return
      setFontOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fontOpen])
  const [typingPeers, setTypingPeers] = useState({})
  const [settings, setSettings] = useState({})
  const [burnOn, setBurnOn] = useState(false)
  const [burnTtl, setBurnTtl] = useState(10)
  const [now, setNow] = useState(Date.now())
  const [toasts, setToasts] = useState([])
  const [fileProgress, setFileProgress] = useState({})
  const [replyTo, setReplyTo] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState({})
  const [forwardOpen, setForwardOpen] = useState(false)
  const [forwardMode, setForwardMode] = useState('each') // each 逐条转发 / merge 合并转发
  const [nudgeHover, setNudgeHover] = useState(false) // 戳一戳悬浮自定义文字面板
  const [nudgeDraft, setNudgeDraft] = useState('')
  const [pendingAtts, setPendingAtts] = useState([]) // 发送框待发附件 [{ path, name, size, preview }]
  const [shotOpen, setShotOpen] = useState(false) // 截图选项面板
  const [historyOpen, setHistoryOpen] = useState(false) // 聊天历史记录面板
  const shotPanelRef = useRef(null)
  const shotBtnRef = useRef(null)
  useEffect(() => {
    if (!shotOpen) return undefined
    const onDown = (e) => {
      if (shotPanelRef.current && shotPanelRef.current.contains(e.target)) return
      if (shotBtnRef.current && shotBtnRef.current.contains(e.target)) return
      setShotOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [shotOpen])
  const emojiPanelRef = useRef(null)
  const emojiBtnRef = useRef(null)
  useEffect(() => {
    if (!emojiOpen) return undefined
    const onDown = (e) => {
      if (emojiPanelRef.current && emojiPanelRef.current.contains(e.target)) return
      if (emojiBtnRef.current && emojiBtnRef.current.contains(e.target)) return
      setEmojiOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [emojiOpen])
  useEffect(() => {
    if (!emojiOpen) return
    if (emojiTab === 'emoji') setEmojiVisibleCount(EMOJI_BATCH)
    else { setStickerVisibleCount(STICKER_BATCH); loadStickers() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emojiOpen, emojiTab])
  const [drafts, setDrafts] = useState({})
  const [shake, setShake] = useState(false)
  const [chatNotice, setChatNotice] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null)
  const [groups, setGroups] = useState([])
  const [pinnedByGroup, setPinnedByGroup] = useState({})
  const [pinnedListOpen, setPinnedListOpen] = useState(false)
  const [snapshotView, setSnapshotView] = useState(null)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMembers, setGroupMembers] = useState({})
  const [groupManage, setGroupManage] = useState(null)
  const [sharePanel, setSharePanel] = useState(false) // 群文件面板
  const [sharePanelTarget, setSharePanelTarget] = useState(null)
  const [sideTab, setSideTab] = useState('all')
  const [sideQuery, setSideQuery] = useState('') // 会话列表搜索，仅前端过滤展示
  const [atBottom, setAtBottom] = useState(true)
  const [newBelow, setNewBelow] = useState(0)
  const [dragOver, setDragOver] = useState(false) // 拖到聊天区：直接发送
  const [composerDragOver, setComposerDragOver] = useState(false) // 拖到发送框：暂存待发
  const atBottomRef = useRef(true)

  const scrollRef = useRef(null)
  const composerRef = useRef(null)
  const activeRef = useRef(active); activeRef.current = active
  const selfRef = useRef(null); selfRef.current = self
  const settingsRef = useRef(settings); settingsRef.current = settings
  const mutedRef = useRef([]); mutedRef.current = settings.muted || []
  const nameByIdRef = useRef({}); nameByIdRef.current = nameById
  const peersRef = useRef([]); peersRef.current = peers
  const convosRef = useRef({}); convosRef.current = convos
  const pinnedByGroupRef = useRef({}); pinnedByGroupRef.current = pinnedByGroup
  const statusBufRef = useRef({}) // mid -> status，消息尚未渲染时暂存其发送状态，pushMsg 时回填
  const lastActivityRef = useRef(Date.now())
  const lastTypingRef = useRef(0)
  const toastSeq = useRef(0)
  const noticeTimerRef = useRef(null)

  // 聊天框内的轻量提示，如文件发送错误，5 秒后自动消失
  function showChatNotice (msg) {
    setChatNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setChatNotice(null), 5000)
  }

  useEffect(() => {
    if (!api || !api.p2p) { setNetError('preload 未注入'); return }
    api.p2p.getSelf().then((s) => { if (s) setSelf(s) })
    api.p2p.getPeers().then((list) => setPeers(list || []))
    Promise.all([api.store.getHistory(), api.store.getReads ? api.store.getReads() : Promise.resolve({})]).then(([h, r]) => {
      setConvos(normalizeHistory(h || {}))
      setReads(r || {}) // 未读数由 convos + reads 派生（见 unread useMemo）
    })
    if (api.store.getGroups) api.store.getGroups().then((list) => setGroups(list || []))
    if (api.store.getPinnedMessages) api.store.getPinnedMessages().then((list) => setPinnedByGroup(list || {}))
    api.settings.get().then((s) => { if (s) { setSettings(s); setBurnOn(!!s.burnDefault); setBurnTtl(s.burnTtl || 10); setDisplay({ theme: s.theme, fontPx: s.fontPx, uiStyle: s.uiStyle, chatFont: s.chatFont, chatFontPx: s.chatFontPx }) } })
    if (api.store.getDrafts) api.store.getDrafts().then((d) => { const saved = d || {}; setDrafts(saved); if (saved[activeRef.current]) setText(saved[activeRef.current]) })
    const unsubs = [
      // 主进程侧改设置（托盘切换免打扰等）同步到渲染层
      api.settings.onChanged ? api.settings.onChanged((s) => { if (s) setSettings(s) }) : () => {},
      api.p2p.onReady((s) => { setSelf(s); setNetError(null) }), // 重连成功(重新 ready)即清除网络提示
      api.p2p.onPeers((list) => { setPeers(list || []); if ((list || []).some((p) => p.online)) setNetError(null) }),
      api.p2p.onMessage((m) => handleIncoming(m)),
      api.p2p.onTyping((t) => setTypingPeers((prev) => {
        const conv = t.room || t.from // 群聊按群 id 归类，私聊按对方 id
        return { ...prev, [conv]: { ...(prev[conv] || {}), [t.from]: Date.now() + 3500 } }
      })),
      api.p2p.onNetError((e) => setNetError(e)),
      api.file.onProgress((p) => setFileProgress((prev) => {
        // 按 ≥0.25s 的窗口测速并指数平滑，据此估算剩余时间
        const old = prev[p.mid] || {}
        const now = Date.now()
        let speed = old.speed || 0
        let baseTs = old._ts || now
        let baseRecv = old._received != null ? old._received : p.received
        const dt = (now - baseTs) / 1000
        if (dt >= 0.25 && p.received > baseRecv) {
          const inst = (p.received - baseRecv) / dt
          speed = old.speed ? old.speed * 0.5 + inst * 0.5 : inst
          baseTs = now; baseRecv = p.received
        }
        const eta = speed > 0 && p.size ? Math.max(0, (p.size - p.received) / speed) : null
        return { ...prev, [p.mid]: { mid: p.mid, received: p.received, size: p.size, dir: p.dir, speed, eta, _ts: baseTs, _received: baseRecv } }
      })),
      api.file.onReceived(({ conv, msg }) => { pushMsg(conv, msg); setFileProgress((prev) => { const n = { ...prev }; delete n[msg.mid]; return n }); if (conv === activeRef.current) bumpRead(conv, msg.ts || Date.now()) }),
      api.file.onOffer((info) => { if (info.scope === 'group') return; const conv = info.scope === 'room' ? info.to : info.from; pushMsg(conv, { ...info, type: 'file-offer', self: false, ts: Date.now() }); if (conv === activeRef.current) bumpRead(conv, Date.now()) }),
      api.file.onSent(({ mid }) => { setFileProgress((prev) => { const n = { ...prev }; delete n[mid]; return n }); setFileStatusByMid(mid, 'sent') }),
      api.file.onFailed(({ mid, canceled, queued }) => { setFileProgress((prev) => { const n = { ...prev }; delete n[mid]; return n }); setFileStatusByMid(mid, queued ? 'queued' : 'failed'); if (!canceled && !queued) showChatNotice('文件传输失败（对方不可达或已拒绝）') }),
      api.file.onRejected ? api.file.onRejected(({ files, limitMB }) => showChatNotice((files && files.length ? '「' + files.join('、') + '」' : '文件') + ' 超过 ' + limitMB + 'MB 上限，未发送')) : () => {},
      api.msg.onRecall(({ conv, mid }) => {
        // 撤回只在原消息位置展示文字，不额外弹通知。
        setConvos((prev) => ({ ...prev, [conv]: (prev[conv] || []).map((x) => x.mid === mid ? { ...x, recalled: true, text: '' } : x) }))
      }),
      api.msg.onReaction(({ conv, mid, emoji, from }) => applyReaction(conv, mid, emoji, from)),
      api.msg.onPinnedList ? api.msg.onPinnedList((list) => setPinnedByGroup(list || {})) : () => {},
      api.msg.onPinned ? api.msg.onPinned(() => {}) : () => {},
      api.msg.onUnpinned ? api.msg.onUnpinned(() => {}) : () => {},
      api.msg.onStatus ? api.msg.onStatus(({ mid, toId, status }) => updateMsgStatus(toId, mid, status)) : () => {},
      api.msg.onNudge(({ from, text }) => {
        if ((mutedRef.current || []).includes(from)) return
        setShake(true); setTimeout(() => setShake(false), 500)
        const who = displayNameForId(from, '有人')
        const body = (text && text.trim()) ? text : '戳了你一下 👋'
        pushMsg(from, { mid: 'nudge-' + Date.now() + '-' + String(from).slice(0, 4), system: true, text: who + ' ' + body, ts: Date.now() })
        addToast({ title: who, text: body, conv: from })
      }),
    ]
    if (api.store.onGroups) unsubs.push(api.store.onGroups((list) => {
      const next = list || []
      setGroups(next)
      const activeId = activeRef.current
      if (activeId && activeId.startsWith('room:') && !next.some((g) => g.id === activeId)) {
        setActive('')
        setSharePanel(false)
        setSharePanelTarget(null)
        setConvos((prev) => { const n = { ...prev }; delete n[activeId]; return n })
      }
      setGroupManage((cur) => (cur && !next.some((g) => g.id === cur.id) ? null : cur))
    }))
    if (api.shot && api.shot.onResult) unsubs.push(api.shot.onResult((info) => {
      if (!info || !info.path) return
      setPendingAtts((prev) => [...prev, { path: info.path, name: info.name || '截图.png', size: info.size || 0, preview: info.dataUrl || '' }])
      focusComposer()
    }))
    return () => unsubs.forEach((u) => u && u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now(); setNow(t)
      setConvos((prev) => {
        let changed = false; const next = {}
        for (const k of Object.keys(prev)) { const arr = prev[k].filter((m) => !(m.burn && t >= m.ts + (m.ttl || 10) * 1000)); if (arr.length !== prev[k].length) changed = true; next[k] = arr }
        return changed ? next : prev
      })
    }, 500)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now() }
    window.addEventListener('mousemove', bump); window.addEventListener('keydown', bump); window.addEventListener('mousedown', bump)
    const id = setInterval(() => { const mins = settings.autoLockMin || 0; if (mins > 0 && Date.now() - lastActivityRef.current > mins * 60000) api.auth.lock().then(() => onLock()) }, 5000)
    return () => { clearInterval(id); window.removeEventListener('mousemove', bump); window.removeEventListener('keydown', bump); window.removeEventListener('mousedown', bump) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.autoLockMin])

  // 快捷键：Ctrl+F 搜索，Esc 关闭浮层
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setSearchPane('global') }
      else if (e.key === 'Escape') { setSearchPane(false); setShowSettings(false); setShowProfile(false); setProfilePeer(null); setEmojiOpen(false); setFontOpen(false); setShotOpen(false); setHistoryOpen(false); setPinnedListOpen(false); setSnapshotView(null); setPresenceOpen(false); setCtxMenu(null); setSideMenu(null); setReplyTo(null); setSelectMode(false); setSelected({}) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 未读数派生自会话消息：他人发送、非系统/非撤回/非阅后即焚、且晚于已读位的条数
  // （撤回的消息自动不计，且每条只数一次，避免计数器漂移导致的双倍/不减）
  const unread = useMemo(() => {
    const u = {}
    for (const conv of Object.keys(convos)) {
      const cut = reads[conv] || 0
      let n = 0
      const arr = convos[conv] || []
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i]
        if (m && !m.self && !m.system && !m.recalled && !m.burn && (m.ts || 0) > cut) n++
      }
      if (n > 0) u[conv] = n
    }
    return u
  }, [convos, reads])

  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0)
    if (api && api.ui) api.ui.setUnread(total)
  }, [unread])

  useEffect(() => { setNameById((prev) => { const n = { ...prev }; for (const p of peers) n[p.id] = p.remark || p.name; return n }) }, [peers]) // 备注优先（仅本机）
  // 对方离线/无在线群成员 → 即焚不可用：自动关闭开关，避免发送时报错
  useEffect(() => {
    if (!burnOn) return
    const room = roomById(active)
    const ok = room ? hasOnlineRoomRecipient(room) : !!(peerById(active) && peerById(active).online)
    if (!ok) setBurnOn(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, peers, groups, burnOn])
  // 仅在末尾出现新消息或切换会话时滚到底部，表情回应/撤回等就地更新不滚动
  const lastBottomKeyRef = useRef('')
  useEffect(() => {
    if (loadingOlderRef.current) return
    const list = convos[active] || []
    const last = list[list.length - 1]
    const key = active + ':' + (last ? (last.mid || last.ts) : 'empty')
    if (key === lastBottomKeyRef.current) return
    const convChanged = !lastBottomKeyRef.current.startsWith(active + ':')
    lastBottomKeyRef.current = key
    const pinSystem = last && last.self && (last.system === 'message_pinned' || last.system === 'message_unpinned')
    if (convChanged || atBottomRef.current || (last && last.self && !pinSystem)) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      setNewBelow(0)
    } else if (last && !last.system) setNewBelow((n) => n + 1)
  }, [convos, active])

  // 加载更早消息后恢复滚动位置，避免跳动
  useLayoutEffect(() => {
    if (!loadingOlderRef.current || !scrollRef.current) return
    const el = scrollRef.current
    el.scrollTop = el.scrollHeight - prevScrollGapRef.current
    loadingOlderRef.current = false
  }, [visibleCount])

  useEffect(() => {
    if (!api.store || !api.store.setDraft) return undefined
    const conv = active
    const value = text
    const id = setTimeout(() => {
      api.store.setDraft(conv, value)
      setDrafts((prev) => {
        const next = { ...prev }
        if (value && value.trim()) next[conv] = value
        else delete next[conv]
        return next
      })
    }, 500)
    return () => clearTimeout(id)
  }, [active, text])

  function pushMsg (convId, msg) {
    // 状态事件可能先于消息渲染到达，这里回填缓存的发送状态
    const buffered = msg.mid ? statusBufRef.current[msg.mid] : null
    if (buffered) { msg = { ...msg, status: buffered }; delete statusBufRef.current[msg.mid] }
    setConvos((prev) => {
      const list = prev[convId] || []
      if (msg.mid && list.some((x) => x.mid === msg.mid)) return prev
      const ts = msg.ts || Date.now()
      // 常规追加到末尾；迟到/乱序消息按 ts 插入正确时间位置，保持时间序
      if (list.length === 0 || ts >= (list[list.length - 1].ts || 0)) return { ...prev, [convId]: [...list, msg] }
      const next = list.slice()
      let i = next.length - 1
      while (i >= 0 && (next[i].ts || 0) > ts) i--
      next.splice(i + 1, 0, msg)
      return { ...prev, [convId]: next }
    })
  }
  function upsertGroupLocal (group) {
    if (!group || !group.id) return
    setGroups((prev) => {
      const i = prev.findIndex((g) => g.id === group.id)
      if (i < 0) return [...prev, group]
      const next = prev.slice()
      next[i] = { ...next[i], ...group }
      return next
    })
  }
  // 后台失焦期间收到的通知先驻留，回到窗口后再错峰移除
  const pendingToastsRef = useRef([])
  // 柔和移除：先播放滑出动画，再从列表删除
  function removeToastSoft (id) {
    setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 320)
  }
  function scheduleToastExpiry (id, delay = 4200) {
    setTimeout(() => removeToastSoft(id), delay)
  }
  function addToast (t) {
    if ((settingsRef.current.presence || 'online') === 'dnd') return // 全局免打扰：不弹应用内消息通知
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, ...t }])
    if (document.hasFocus()) scheduleToastExpiry(id)
    else pendingToastsRef.current.push(id)
  }
  function messageMentionsMe (m) {
    if (!m || m.scope !== 'room' || !m.text) return false
    const me = selfRef.current
    return textMentionsNames(m.text, [me && me.name, '所有人', '全体成员', 'all', 'everyone'])
  }
  useEffect(() => {
    const flush = () => {
      const ids = pendingToastsRef.current
      pendingToastsRef.current = []
      // 驻留的提示逐条错峰消失，而不是一次性全部消失
      ids.forEach((id, i) => scheduleToastExpiry(id, 4200 + i * 800))
    }
    window.addEventListener('focus', flush)
    return () => window.removeEventListener('focus', flush)
  }, [])
  function handleIncoming (m) {
    if (m.scope === 'group') return
    const convId = m.scope === 'room' && m.room ? m.room.id : m.from
    if (m.room) upsertGroupLocal(m.room)
    if (m.name && !m.self) setNameById((prev) => {
      const hasRemark = ((peersRef.current || []).find((p) => p.id === m.from) || {}).remark
      return hasRemark ? prev : { ...prev, [m.from]: m.name } // 有备注时不被消息携带的昵称覆盖
    })
    pushMsg(convId, m)
    if (m.self) return // 自己操作产生的系统消息进入会话，但不计未读、不弹通知
    if (m.system === 'avatar-changed') return // 群头像更新只保留聊天框内文字，不计未读、不弹通知
    if (m.system === 'message_unpinned') return // 取消置顶只保留聊天框内文字，不计未读、不弹通知
    if (typeof m.system === 'string' && m.system.indexOf('share-') === 0) return // 群文件广播只在聊天框展示，不计未读、不弹通知
    const mutedMention = (mutedRef.current || []).includes(convId) && messageMentionsMe(m)
    if (mutedMention) {
      if (document.hasFocus()) {
        const title = (m.room && m.room.name) || '群聊'
        addToast({ title, text: ((displayNameForId(m.from, m.name || '有人')) + ': ' + (m.text || '')).slice(0, 120), conv: convId })
      }
      if (convId !== activeRef.current || !document.hasFocus()) {
        if (api.ui && api.ui.attention) api.ui.attention({ flash: true, trayFlash: true })
      }
    }
    if (convId === activeRef.current) bumpRead(convId, m.ts || Date.now()) // 活动会话即时已读；非活动会话未读由派生自动计数
    // 这里仅处理会话状态，系统通知由主进程负责
  }
  // 推进已读位（更新本地状态 + 持久化，单调前进）；未读数由 convos + reads 派生
  function bumpRead (convId, ts) {
    if (!convId) return
    const v = ts || Date.now()
    setReads((r) => (v > (r[convId] || 0) ? { ...r, [convId]: v } : r))
    if (api.store.setRead) api.store.setRead(convId, v)
  }
  // 标记会话已读：把已读位推进到最新消息（用户打开/正在查看会话时调用）
  function markRead (convId) {
    if (!convId) return
    const list = convosRef.current[convId] || []
    const lastTs = list.length ? (list[list.length - 1].ts || 0) : 0
    bumpRead(convId, Math.max(Date.now(), lastTs))
  }
  function selectConv (id) {
    const prev = activeRef.current
    if (prev !== id) {
      setDrafts((d) => {
        const next = { ...d }
        if (text && text.trim()) next[prev] = text
        else delete next[prev]
        return next
      })
      if (api.store.setDraft) api.store.setDraft(prev, text)
      setText(drafts[id] || '')
    }
    setActive(id); markRead(id)
    setVisibleCount(MSG_PAGE)
    atBottomRef.current = true
    setAtBottom(true)
    setNewBelow(0)
    setDragOver(false)
    setSelectMode(false)
    setSelected({})
    setPendingAtts([])
  }
  // 消息分页加载：接近顶部时加载更早记录
  function loadOlderMessages () {
    const el = scrollRef.current
    const total = (convosRef.current[activeRef.current] || []).length
    if (!el || loadingOlderRef.current || visibleCountRef.current >= total) return
    loadingOlderRef.current = true
    prevScrollGapRef.current = el.scrollHeight - el.scrollTop
    setVisibleCount((c) => Math.min(total, c + MSG_PAGE))
  }
  function onMessagesScroll () {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop < 40) loadOlderMessages()
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = near
    setAtBottom(near)
    if (near) setNewBelow(0)
  }
  function jumpToBottom () {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setNewBelow(0)
  }
  function roomById (id) { return (groups || []).find((g) => g.id === id) || null }
  function peerById (id) { return (peers || []).find((p) => p.id === id) || null }
  function displayNameForPeer (p, fallback) { return (p && (p.remark || p.name)) || fallback || '' }
  function displayNameForId (id, fallback) {
    if (!id) return fallback || ''
    if (selfRef.current && id === selfRef.current.id) return '我'
    const p = peerById(id)
    return displayNameForPeer(p, (nameByIdRef.current && nameByIdRef.current[id]) || fallback || String(id).slice(0, 6))
  }
  function publicNameForId (id, fallback) {
    if (!id) return fallback || ''
    if (selfRef.current && id === selfRef.current.id) return selfRef.current.name || fallback || '我'
    const p = peerById(id)
    return (p && p.name) || fallback || String(id).slice(0, 6)
  }
  function hasOnlineRoomRecipient (room) {
    if (!room || !Array.isArray(room.members)) return false
    const online = new Set((peers || []).filter((p) => p.online).map((p) => p.id))
    return room.members.some((id) => id !== (self && self.id) && online.has(id))
  }
  function hasRoomRecipient (room) {
    return !!(room && Array.isArray(room.members) && room.members.some((id) => id !== (self && self.id)))
  }
  function canSendToConv (id) {
    if (!id) return false
    const room = roomById(id)
    if (room) return hasRoomRecipient(room)
    return true // 私聊：离线也可发送（自动暂存，上线补发）
  }
  async function sendTextToConv (convId, value, opts) {
    const room = roomById(convId)
    if (room) {
      if (!hasRoomRecipient(room)) return { ok: false, error: '群聊没有可接收成员' }
      if (opts && opts.burn && !hasOnlineRoomRecipient(room)) return { ok: false, error: '群成员均离线，阅后即焚消息不支持暂存' }
      return api.p2p.sendRoom(room.id, value, opts)
    }
    return api.p2p.sendPrivate(convId, value, opts) // 私聊离线时后端自动暂存到发件箱，上线后补发
  }
  async function handleSend () {
    const t = text.trim()
    const atts = pendingAtts
    if ((!t && !atts.length) || !self) return
    const conv = activeRef.current
    if (!canSendToConv(conv)) { showChatNotice(conv ? '当前会话不可发送' : '请选择会话'); return }
    const batchId = ((t ? 1 : 0) + atts.length) > 1 ? ('b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)) : null
    if (t) {
      const opts = { burn: burnOn, ttl: burnTtl, batch: batchId }
      if (replyTo) opts.reply = { name: replyTo.publicName || replyTo.name, text: (replyTo.publicText || replyTo.text || '').slice(0, 80) }
      const res = await sendTextToConv(conv, t, opts)
      if (res && res.ok) {
        setText(''); setEmojiOpen(false); setReplyTo(null)
        setDrafts((prev) => { const n = { ...prev }; delete n[conv]; return n })
        if (api.store.setDraft) api.store.setDraft(conv, '')
        pushMsg(conv, res.msg)
        if (res.queued) showChatNotice(roomById(conv) ? '群消息已暂存，离线成员上线后自动发送' : '对方离线，消息已暂存，对方上线后自动发送')
      } else { showChatNotice((res && res.error) || '发送失败'); return }
    }
    if (atts.length) {
      const target = fileSendTarget()
      if (target.error) { showChatNotice(target.error); return }
      sendFiles(atts.map((a) => a.path), batchId)
      setPendingAtts([])
    }
  }
  function onKeyDown (e) {
    if (e.key !== 'Enter') return
    const k = settingsRef.current.sendKey || 'enter'
    if (k === 'ctrlEnter') { if (e.ctrlKey || e.metaKey) { e.preventDefault(); handleSend() } }
    else if (!e.shiftKey) { e.preventDefault(); handleSend() }
  }
  function onTextChange (e) {
    setText(e.target.value)
    const conv = activeRef.current
    if (!conv || settingsRef.current.showTyping === false) return
    const room = roomById(conv)
    const canType = room ? hasOnlineRoomRecipient(room) : peerById(conv)?.online
    if (canType) {
      const t = Date.now()
      if (t - lastTypingRef.current > 2000) { lastTypingRef.current = t; api.p2p.sendTyping(conv) }
    }
  }
  // 计算当前会话的文件发送参数，不可发送时返回提示文案
  function fileSendTarget () {
    const conv = activeRef.current
    const room = roomById(conv)
    if (room) {
      if (!hasRoomRecipient(room)) return { error: '群聊没有可接收成员' }
      return { scope: 'room', toId: conv }
    }
    return { scope: 'private', toId: conv } // 私聊：离线也可发送（自动暂存，上线补发）
  }
  function sendFiles (paths, batch, opts) {
    if (!paths || !paths.length) return
    const t = fileSendTarget()
    if (t.error) { showChatNotice(t.error); return }
    api.file.send(t.scope, t.toId, paths, batch || null, opts || null).then((out) => { (out || []).forEach((msg) => pushMsg(activeRef.current, msg)) })
  }
  function openSharedEntry (share) {
    if (!share || share.type !== 'share-entry' || !share.spaceId) return
    const groupId = share.groupId || activeRef.current
    if (!roomById(groupId)) { showChatNotice('群聊不存在，无法打开群空间'); return }
    if (activeRef.current !== groupId) selectConv(groupId)
    setSharePanelTarget({ ...share, nonce: Date.now() })
    setSharePanel(true)
  }
  async function forwardShareEntry (sp, entry, pid, breadcrumb) {
    const room = roomById(activeRef.current)
    if (!room || !sp || !entry) return { ok: false, error: '请选择群聊' }
    const isFolder = entry.type === 'folder'
    const text = '分享了群文件' + (isFolder ? '夹' : '') + '：' + (entry.name || '')
    const res = await sendTextToConv(room.id, text, {
      share: {
        type: 'share-entry',
        groupId: room.id,
        spaceId: sp.spaceId,
        spaceName: sp.name,
        entryId: entry.entryId,
        parentId: pid || 'root',
        entryType: entry.type,
        name: entry.name,
        size: entry.size || 0,
        updatedAt: entry.updatedAt || 0,
        breadcrumb: (breadcrumb || []).map((c) => ({ entryId: c.entryId, name: c.name })).slice(-6),
      },
    })
    if (res && res.ok) {
      pushMsg(room.id, res.msg)
      return { ok: true }
    }
    return { ok: false, error: (res && res.error) || '转发失败' }
  }
  async function attachFiles () {
    if (!api.file.choose) { showChatNotice('当前环境不支持选择文件'); return }
    const list = await api.file.choose()
    if (list && list.length) setPendingAtts((prev) => [...prev, ...list])
  }
  // ---------------- 表情包 ----------------
  async function loadStickers (force) {
    if (!api.stickers || !api.stickers.list) return
    if (stickersLoadedRef.current && !force) return
    stickersLoadedRef.current = true
    setStickers((await api.stickers.list()) || [])
  }
  async function importStickers () {
    if (!api.stickers || !api.stickers.add) { showChatNotice('当前环境不支持导入表情包，请重启应用'); return }
    const res = await api.stickers.add()
    if (res) {
      setStickers(res.stickers || [])
      if (res.skipped) showChatNotice(`${res.skipped} 张图片超过 2MB 或导入失败，已跳过`)
    }
  }
  async function removeSticker (id) {
    if (!api.stickers || !api.stickers.remove) return
    setStickers((await api.stickers.remove(id)) || [])
  }
  function sendSticker (s) {
    sendFiles([s.path], null, { sticker: true }) // 标记为表情包：气泡内不展示文件操作
    setEmojiOpen(false)
  }
  function onEmojiPickerScroll (e) {
    const el = e.currentTarget
    if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - 32) return
    if (emojiTab === 'emoji') setEmojiVisibleCount((n) => Math.min(EMOJIS.length, n + EMOJI_BATCH))
    else setStickerVisibleCount((n) => Math.min(stickers.length, n + STICKER_BATCH))
  }
  async function takeShot (mode) {
    setShotOpen(false)
    if (!api.shot || !api.shot.begin) { showChatNotice('当前环境不支持截图'); return }
    const res = await api.shot.begin(mode)
    if (res && res.error) showChatNotice(res.error)
  }
  function removePendingAtt (idx) {
    setPendingAtts((prev) => prev.filter((_, i) => i !== idx))
  }
  // 拖到发送框：暂存待发（图片显示缩略图），与原有功能一致
  function onDropFiles (e) {
    e.preventDefault()
    const items = Array.from(e.dataTransfer.files || [])
      .filter((f) => f.path)
      .map((f) => ({ path: f.path, name: f.name, size: f.size, preview: (f.type || '').startsWith('image/') ? URL.createObjectURL(f) : '' }))
    if (items.length) setPendingAtts((prev) => [...prev, ...items])
  }
  // 拖到聊天区：单/多个文件均立即发送
  function sendDroppedFilesDirect (e) {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files || []).filter((f) => f.path).map((f) => f.path)
    if (!paths.length) return
    const batch = paths.length > 1 ? ('b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)) : null
    sendFiles(paths, batch) // 内部已校验在线状态并提示
  }
  // 发送框粘贴图片：写入临时文件后加入待发附件（支持 Ctrl+V 截图）
  async function onComposerPaste (e) {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || [])
    const imgItem = items.find((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
    if (!imgItem) return
    const file = imgItem.getAsFile()
    if (!file) return
    e.preventDefault()
    if (!api.file || !api.file.saveImage) { showChatNotice('当前环境不支持粘贴图片'); return }
    const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(''); r.readAsDataURL(file) })
    if (!dataUrl) return
    const info = await api.file.saveImage(dataUrl)
    if (info && info.path) setPendingAtts((prev) => [...prev, { path: info.path, name: info.name || '粘贴图片.png', size: info.size || 0, preview: dataUrl }])
  }
  function removeOffer (mid) { setConvos((prev) => { const n = {}; for (const k of Object.keys(prev)) n[k] = prev[k].filter((x) => !(x.mid === mid && x.type === 'file-offer')); return n }) }
  function acceptFile (mid) { api.file.accept(mid); removeOffer(mid) }
  function rejectFile (mid) { api.file.reject(mid); removeOffer(mid) }
  function updateMsgStatus (conv, mid, status) {
    if (!conv || !mid) return
    const list = convosRef.current[conv] || []
    if (list.some((x) => x.mid === mid)) {
      setConvos((prev) => ({ ...prev, [conv]: (prev[conv] || []).map((x) => (x.mid === mid ? { ...x, status } : x)) }))
    } else {
      statusBufRef.current[mid] = status // 消息还没渲染，先缓存，pushMsg 时回填
    }
  }
  async function retryMessage (m) {
    if (!m || !m.self) return
    const conv = activeRef.current
    if (roomById(conv)) return // 群聊暂不支持送达确认/重试
    if (!api.p2p.resend) { showChatNotice('当前环境不支持重试，请重启应用'); return }
    updateMsgStatus(conv, m.mid, 'sending')
    const res = await api.p2p.resend(conv, m.mid, m.text || '', { burn: m.burn, ttl: m.ttl, reply: m.reply, fwd: m.fwd, batch: m.batch })
    if (!res || !res.ok) { updateMsgStatus(conv, m.mid, 'failed'); showChatNotice((res && res.error) || '重试失败') }
  }
  function setFileStatusByMid (mid, status) {
    setConvos((prev) => {
      let changed = false
      const next = {}
      for (const k of Object.keys(prev)) {
        const arr = prev[k]
        let hit = false
        const na = arr.map((x) => { if (x.mid === mid && x.self && (x.type === 'file' || x.type === 'file-offer')) { hit = true; return { ...x, status } } return x })
        if (hit) { changed = true; next[k] = na } else next[k] = arr
      }
      return changed ? next : prev
    })
  }
  function cancelFile (mid) { if (api.file.cancel) api.file.cancel(mid); setFileStatusByMid(mid, 'failed') }
  async function retryFile (m) {
    if (!m || !m.self || !m.path) return
    if (roomById(m.to)) { showChatNotice('群文件暂不支持重试'); return }
    if (!api.file.retry) { showChatNotice('当前环境不支持重试，请重启应用'); return }
    setFileStatusByMid(m.mid, 'sending')
    const res = await api.file.retry(m.to, m.mid, m.path, m.batch || null)
    if (!res || !res.ok) { setFileStatusByMid(m.mid, 'failed'); showChatNotice((res && res.error) || '重试失败') }
  }
  function applyReaction (conv, mid, emoji, from) {
    setConvos((prev) => ({
      ...prev,
      [conv]: (prev[conv] || []).map((x) => {
        if (x.mid !== mid) return x
        const reactions = { ...(x.reactions || {}) }
        const ids = reactions[emoji] ? reactions[emoji].slice() : []
        if (!ids.includes(from)) ids.push(from)
        reactions[emoji] = ids
        return { ...x, reactions }
      }),
    }))
  }
  function doReply (m) {
    const rawText = m.text || ''
    setReplyTo({
      name: m.self ? '我' : displayNameForId(m.from, m.name || '对方'),
      publicName: m.self ? (self ? self.name : '我') : publicNameForId(m.from, m.name || '对方'),
      text: m.recalled ? '[已撤回]' : (localizeMentionsText(rawText, mentionNameMap) || (m.type === 'file' ? ('[文件] ' + (m.fname || '')) : '')),
      publicText: m.recalled ? '[已撤回]' : (rawText || (m.type === 'file' ? ('[文件] ' + (m.fname || '')) : '')),
    })
  }
  // 撤回：先本地标记，再通知对方
  function markRecalledLocal (mid) {
    setConvos((prev) => ({ ...prev, [activeRef.current]: (prev[activeRef.current] || []).map((x) => x.mid === mid ? { ...x, recalled: true, recalledText: x.self ? (x.text || '') : '', text: '' } : x) }))
  }
  function doRecall (m) {
    const conv = activeRef.current
    const room = roomById(conv)
    const scope = room ? 'room' : 'private'
    const toId = room ? room.id : conv
    api.msg.recall(scope, toId, m.mid)
    markRecalledLocal(m.mid)
  }
  // 重新编辑撤回消息：原文回填到输入框
  function reEdit (m) {
    if (!m.recalledText) return
    setText(m.recalledText)
    focusComposer()
  }
  function doReact (m, emoji) {
    const conv = activeRef.current
    const room = roomById(conv)
    const scope = room ? 'room' : 'private'
    const toId = room ? room.id : conv
    api.msg.react(scope, toId, m.mid, emoji)
    applyReaction(conv, m.mid, emoji, self ? self.id : 'me')
  }
  function toggleSelect (mid) { setSelected((prev) => { const n = { ...prev }; if (n[mid]) delete n[mid]; else n[mid] = true; return n }) }
  function doForward (targetConv) {
    const srcConv = activeRef.current
    const msgs = (convos[srcConv] || []).filter((x) => selected[x.mid] && x.text && !x.recalled && !isShareEntryMessage(x))
    if (!msgs.length) { setSelectMode(false); setSelected({}); setForwardOpen(false); return }
    ;(async () => {
      if (forwardMode === 'merge' && msgs.length > 1) {
        const lines = msgs.map((x) => (x.self ? (self ? self.name : '我') : (x.name || '对方')) + ': ' + x.text)
        const srcRoom = roomById(srcConv)
        const publicTitle = srcRoom ? (srcRoom.name || '群聊') : publicNameForId(srcConv, '私聊')
        const res = await sendTextToConv(targetConv, lines.join('\n'), { fwd: { name: publicTitle + ' 的聊天记录', count: msgs.length } })
        if (res && res.ok) pushMsg(targetConv, res.msg)
      } else {
        for (const x of msgs) {
          const res = await sendTextToConv(targetConv, x.text, { fwd: { name: x.self ? (self ? self.name : '我') : publicNameForId(x.from, x.name || '对方') } })
          if (res && res.ok) pushMsg(targetConv, res.msg)
        }
      }
    })()
    setSelectMode(false); setSelected({}); setForwardOpen(false)
  }
  // 字体面板：聊天字号滑块跟随设置，仅作用于聊天框，不影响全局
  useEffect(() => { setFontDraft(settings.chatFontPx || 13.5) }, [settings.chatFontPx])

  useEffect(() => { setNudgeDraft(settings.nudgeText || '') }, [settings.nudgeText])
  const nudgeHoverTimerRef = useRef(null)
  function openNudgeHover () {
    if (nudgeHoverTimerRef.current) { clearTimeout(nudgeHoverTimerRef.current); nudgeHoverTimerRef.current = null }
    setNudgeHover(true)
  }
  function closeNudgeHover () {
    if (nudgeHoverTimerRef.current) clearTimeout(nudgeHoverTimerRef.current)
    nudgeHoverTimerRef.current = setTimeout(() => { setNudgeHover(false); commitNudgeText() }, 300)
  }
  useEffect(() => () => { if (nudgeHoverTimerRef.current) clearTimeout(nudgeHoverTimerRef.current) }, [])
  function commitNudgeText () {
    const next = nudgeDraft.slice(0, 20)
    if (next !== (settingsRef.current.nudgeText || '')) patchSettings({ nudgeText: next })
  }

  function startPaneDrag (e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = paneWidth || Math.round(window.innerWidth * 0.2)
    const clamp = (w) => Math.max(200, Math.min(560, w))
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (ev) => setPaneWidth(clamp(startW + (startX - ev.clientX)))
    const up = (ev) => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setPaneWidth(clamp(startW + (startX - ev.clientX)))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  // 定位到某条消息：必要时先切换会话，再滚动到消息并高亮
  const flashTimerRef = useRef(null)
  function locateMessage (conv, mid) {
    if (!mid) return
    if (activeRef.current !== conv) selectConv(conv)
    // 历史面板定位旧消息时，先扩展可见范围
    const list = convosRef.current[conv] || []
    const idx = list.findIndex((x) => x.mid === mid)
    if (idx >= 0) {
      const need = list.length - idx + 5
      if (need > visibleCountRef.current) setVisibleCount(Math.min(list.length, need))
    }
    setTimeout(() => {
      const sel = (window.CSS && CSS.escape) ? CSS.escape(mid) : String(mid).replace(/"/g, '\\"')
      const el = document.querySelector(`[data-mid="${sel}"]`)
      if (!el) { showChatNotice('没有找到这条消息'); return }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setFlashMid(mid)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setFlashMid(null), 1800)
    }, 120)
  }
  function sortPinnedList (list) {
    return (list || []).slice().sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0) || String(b.pinId).localeCompare(String(a.pinId)))
  }
  function pinnedRecordForMessage (groupId, mid) {
    return ((pinnedByGroupRef.current || {})[groupId] || []).find((p) => p && p.messageId === mid && p.status !== 'unpinned' && p.status !== 'deleted') || null
  }
  function localMessageForPin (pin) {
    if (!pin || !pin.groupId || !pin.messageId) return null
    return (convosRef.current[pin.groupId] || []).find((x) => x && x.mid === pin.messageId) || null
  }
  function pinnedSnapshotOf (pin) {
    return (pin && pin.messageSnapshot) || {}
  }
  function pinnedOpenPath (pin) {
    const m = localMessageForPin(pin)
    const snap = pinnedSnapshotOf(pin)
    return (m && m.path) || snap.localPath || ''
  }
  function pinnedTopPreview (pin) {
    const snap = pinnedSnapshotOf(pin)
    const type = snap.messageType || (pin && pin.messageType)
    if (type === 'file') return snap.fileName || String((pin && pin.contentPreview) || '').replace(/^\[文件\]\s*/, '') || '文件'
    return localizeMentionsText((pin && pin.contentPreview) || snap.contentPreview || '[消息]', mentionNameMap)
  }
  function openPinnedAttachment (pin) {
    const p = pinnedOpenPath(pin)
    if (!p) { showChatNotice('本地没有可打开的文件'); return }
    api.file.open(p)
  }
  async function pinChatMessage (m) {
    const groupId = activeRef.current
    if (!roomById(groupId)) { showChatNotice('仅群聊支持置顶消息'); return }
    if (!m || !m.mid) { showChatNotice('消息不存在'); return }
    if (m.recalled) { showChatNotice('该消息已撤回，不能置顶'); return }
    if (m.burn) { showChatNotice('阅后即焚消息不能置顶'); return }
    if (pinnedRecordForMessage(groupId, m.mid)) { showChatNotice('该消息已置顶'); return }
    if (!api.msg.pin) { showChatNotice('当前版本不支持置顶消息，请重启应用'); return }
    const res = await api.msg.pin(groupId, m)
    if (!res || !res.ok) { showChatNotice((res && res.error) || '置顶失败'); return }
    setPinnedByGroup((prev) => ({
      ...prev,
      [groupId]: sortPinnedList([res.pin, ...((prev[groupId] || []).filter((p) => p.pinId !== res.pin.pinId && p.messageId !== res.pin.messageId))]),
    }))
  }
  function viewPinnedOriginal (pin) {
    if (!pin || !pin.groupId || !pin.messageId) return
    const list = convosRef.current[pin.groupId] || []
    const m = list.find((x) => x && x.mid === pin.messageId)
    if (m && !m.recalled) {
      setPinnedListOpen(false)
      locateMessage(pin.groupId, pin.messageId)
      return
    }
    setSnapshotView({
      pin,
      text: m && m.recalled ? '原消息已撤回，以下为置顶时保存的内容快照。' : '原消息已不存在，以下为置顶时保存的内容快照。',
    })
  }
  function PinnedAttachmentPreview ({ pin, compact }) {
    const snap = pinnedSnapshotOf(pin)
    const type = snap.messageType || pin.messageType
    const path = pinnedOpenPath(pin)
    if (type === 'image') {
      const src = (localMessageForPin(pin) || {}).dataUrl || snap.thumbnailDataUrl
      if (!src) return <span className="pinned-file-chip"><ImageIcon size={14} /> 图片</span>
      if (compact) return <span className="pinned-thumb pinned-thumb-compact"><StaticImg src={src} alt={snap.fileName || '置顶图片'} /></span>
      return (
        <button onClick={() => path ? openPinnedAttachment(pin) : viewPinnedOriginal(pin)} className="pinned-thumb" title={path ? '打开图片' : '查看置顶快照'}>
          <StaticImg src={src} alt={snap.fileName || '置顶图片'} />
        </button>
      )
    }
    if (type === 'file') {
      if (compact) {
        return null
      }
      return (
        <button onClick={() => path ? openPinnedAttachment(pin) : viewPinnedOriginal(pin)} className="pinned-file-card" title={path ? '打开文件' : '查看置顶快照'}>
          <FileIcon size={18} className="accent-txt shrink-0" />
          <span className="min-w-0 text-left">
            <span className="block truncate">{snap.fileName || pin.contentPreview || '文件'}</span>
            {snap.fileSize ? <span className="block text-[10px] txt-dim">{fmtSize(snap.fileSize)}</span> : null}
          </span>
        </button>
      )
    }
    return null
  }
  function PinnedMetaPopover ({ pin }) {
    const snap = pinnedSnapshotOf(pin)
    const nameWithRemark = (id, fallback) => {
      if (id && self && id === self.id) return '我'
      const p = id ? (peersRef.current || []).find((x) => x.id === id) : null
      return (p && (p.remark || p.name)) || (id && nameByIdRef.current[id]) || fallback || '未知'
    }
    const senderName = nameWithRemark(snap.senderId || pin.senderId, snap.senderName || pin.senderName)
    const pinnedName = nameWithRemark(pin.pinnedBy, pin.pinnedByName)
    return (
      <span className="pinned-meta-wrap" tabIndex={0} title="查看置顶信息">
        <Info size={14} className="txt-dim" />
        <span className="pinned-meta-pop">
          <span>发送人：{senderName}</span>
          <span>原消息：{snap.sentAt ? `${dayLabel(snap.sentAt)} ${fmtTime(snap.sentAt)}` : '-'}</span>
          <span>置顶人：{pinnedName}</span>
          <span>置顶时间：{pin.pinnedAt ? `${dayLabel(pin.pinnedAt)} ${fmtTime(pin.pinnedAt)}` : '-'}</span>
        </span>
      </span>
    )
  }
  function confirmUnpinPinnedMessage (pin) {
    if (!pin || !api.msg.unpin) return
    setConfirmAction({
      title: '取消置顶',
      text: '取消后，群成员将不再在顶部看到该置顶消息。',
      confirmText: '取消置顶',
      run: async () => {
        const res = await api.msg.unpin(pin.groupId, pin.pinId)
        if (!res || !res.ok) { showChatNotice((res && res.error) || '取消置顶失败'); return }
        setPinnedByGroup((prev) => ({
          ...prev,
          [pin.groupId]: (prev[pin.groupId] || []).filter((p) => p.pinId !== pin.pinId),
        }))
      },
    })
  }
  function insertMention (person) {
    const name = typeof person === 'string' ? person : ((person && (person.publicName || person.name)) || '')
    if (!name) return
    setText((t) => t.replace(/@(\S*)$/, '@' + name + ' '))
  }
  function togglePin (id) { const cur = settings.pinned || []; patchSettings({ pinned: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }) }
  function toggleMute (id) { const cur = settings.muted || []; patchSettings({ muted: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }) }
  function openCreateGroup () {
    setGroupName('')
    setGroupMembers({})
    setShowCreateGroup(true)
  }
  function toggleGroupMember (id) {
    setGroupMembers((prev) => ({ ...prev, [id]: !prev[id] }))
  }
  async function createGroup () {
    const members = Object.keys(groupMembers).filter((id) => groupMembers[id])
    if (!groupName.trim()) { setNetError('\u8bf7\u8f93\u5165\u7fa4\u804a\u540d\u79f0'); return }
    if (!members.length) { setNetError('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u540d\u6210\u5458'); return }
    const group = await api.store.createGroup(groupName.trim(), members)
    if (!group) { setNetError('\u521b\u5efa\u7fa4\u804a\u5931\u8d25'); return }
    upsertGroupLocal(group)
    setShowCreateGroup(false)
    selectConv(group.id)
  }

  async function changeGroupAvatar (group) {
    if (!group || !api.avatar || !api.avatar.pickImage || !api.store.setGroupAvatar) return
    const res = await api.avatar.pickImage()
    if (res && res.ok) {
      let payload
      if (res.gif && res.dataUrl.length <= ANIMATED_GIF_MAX_CHARS) {
        // \u5c0f\u52a8\u56fe\uff1a\u4fdd\u7559\u52a8\u753b\uff0c\u9644\u9759\u6001\u9996\u5e27\u5907\u7528
        payload = { type: 'image', imageDataUrl: res.dataUrl, staticDataUrl: (await compressImageDataUrl(res.dataUrl, 96)) || '', zoom: 120, x: 50, y: 50 }
      } else {
        if (res.gif) showChatNotice('\u52a8\u56fe\u8d85\u8fc7 ' + ANIMATED_GIF_MAX_KB + 'KB\uff0c\u7fa4\u5934\u50cf\u5df2\u8f6c\u4e3a\u9759\u6001\u5c55\u793a')
        payload = { type: 'image', imageDataUrl: (await compressImageDataUrl(res.dataUrl, 96)) || res.dataUrl, zoom: 120, x: 50, y: 50 }
      }
      const next = await api.store.setGroupAvatar(group.id, payload)
      if (next) { upsertGroupLocal(next); setGroupManage(next) } else showChatNotice('\u4fee\u6539\u7fa4\u5934\u50cf\u5931\u8d25')
    } else if (res && res.error) showChatNotice(res.error)
  }

  async function resetGroupAvatar (group) {
    if (!group || !api.store.setGroupAvatar) return
    const next = await api.store.setGroupAvatar(group.id, null)
    if (next) { upsertGroupLocal(next); setGroupManage(next) }
  }

  function leaveGroup (group) {
    if (!group) return
    setConfirmAction({
      title: '\u9000\u51fa\u7fa4\u804a',
      text: '\u9000\u51fa“' + (group.name || '\u7fa4\u804a') + '”\u540e\uff0c\u4f60\u5c06\u4e0d\u518d\u63a5\u6536\u8be5\u7fa4\u7684\u6d88\u606f\u3002',
      confirmText: '\u9000\u51fa',
      run: async () => {
        const res = await api.store.leaveGroup(group.id)
        if (!res || !res.ok) { showChatNotice('\u9000\u51fa\u7fa4\u804a\u5931\u8d25'); return }
        setGroups((prev) => prev.filter((g) => g.id !== group.id))
        setConvos((prev) => { const n = { ...prev }; delete n[group.id]; return n })
        if (activeRef.current === group.id) setActive('')
        if (groupManage && groupManage.id === group.id) setGroupManage(null)
      },
    })
  }

  function dismissGroup (group) {
    if (!group || !api.store.dismissGroup) return
    setConfirmAction({
      title: '解散群聊',
      text: '解散“' + (group.name || '群聊') + '”后，所有成员都会移除该群，本地群文件入口也会关闭。此操作不可撤销。',
      confirmText: '解散',
      run: async () => {
        const res = await api.store.dismissGroup(group.id)
        if (!res || !res.ok) { showChatNotice((res && res.error) || '解散群聊失败'); return }
        setGroups((prev) => prev.filter((g) => g.id !== group.id))
        setConvos((prev) => { const n = { ...prev }; delete n[group.id]; return n })
        setDrafts((prev) => { const n = { ...prev }; delete n[group.id]; return n })
        if (activeRef.current === group.id) setActive('')
        if (groupManage && groupManage.id === group.id) setGroupManage(null)
        setSharePanel(false)
        setSharePanelTarget(null)
      },
    })
  }

  async function transferGroupOwner (group, ownerId) {
    if (!group || !ownerId || group.ownerId === ownerId) return
    const next = await api.store.transferGroupOwner(group.id, ownerId)
    if (next) {
      upsertGroupLocal(next)
      setGroupManage(next)
    } else setNetError('\u8f6c\u8ba9\u7fa4\u4e3b\u5931\u8d25')
  }

  function removeMember (group, member) {
    if (!group || !member || !api.store.removeGroupMember) return
    setConfirmAction({
      title: '\u79fb\u51fa\u6210\u5458',
      text: '\u5c06 ' + (member.name || member.id) + ' \u79fb\u51fa\u8be5\u7fa4\uff1f',
      confirmText: '\u79fb\u51fa',
      run: async () => {
        const res = await api.store.removeGroupMember(group.id, member.id)
        if (res && res.ok && res.group) {
          upsertGroupLocal(res.group)
          if (groupManage && groupManage.id === group.id) setGroupManage(res.group)
        } else showChatNotice((res && res.error) || '\u79fb\u51fa\u6210\u5458\u5931\u8d25')
      },
    })
  }

  async function addGroupMembers (group, ids) {
    if (!group || !ids || !ids.length || !api.store.addGroupMembers) return
    const res = await api.store.addGroupMembers(group.id, ids)
    if (res && res.ok && res.group) {
      upsertGroupLocal(res.group)
      if (groupManage && groupManage.id === group.id) setGroupManage(res.group)
      if (activeRef.current === group.id) setNetError(null)
    } else {
      showChatNotice((res && res.error) || '添加成员失败')
    }
  }

  function removeGroupMember (group, member) {
    removeMember(group, member)
  }

  function focusComposer () {
    if (api.win && api.win.focus) api.win.focus()
    ;[0, 60, 180].forEach((delay) => {
      setTimeout(() => {
        if (!composerRef.current) return
        composerRef.current.focus()
        try { composerRef.current.setSelectionRange(composerRef.current.value.length, composerRef.current.value.length) } catch (_) {}
      }, delay)
    })
  }

  function runClearConv (id) {
    api.store.clearConversation(id)
    if (api.store.setDraft) api.store.setDraft(id, '')
    setConvos((prev) => ({ ...prev, [id]: [] }))
    setDrafts((prev) => { const n = { ...prev }; delete n[id]; return n })
    if (activeRef.current === id) setText('')
    focusComposer()
  }

  function clearConv (id) {
    setConfirmAction({
      title: '\u6e05\u7a7a\u4f1a\u8bdd',
      text: '\u5c06\u6e05\u7a7a\u672c\u4f1a\u8bdd\u7684\u804a\u5929\u8bb0\u5f55\u548c\u8349\u7a3f\uff0c\u6b64\u64cd\u4f5c\u4e0d\u53ef\u6062\u590d\u3002',
      confirmText: '\u6e05\u7a7a',
      run: () => runClearConv(id),
    })
  }

  function clearAllHistory () {
    setShowSettings(false)
    setConfirmAction({
      title: '\u6e05\u7a7a\u5168\u90e8\u804a\u5929\u8bb0\u5f55',
      text: '\u5c06\u6e05\u7a7a\u6240\u6709\u4f1a\u8bdd\u7684\u804a\u5929\u8bb0\u5f55\uff0c\u6b64\u64cd\u4f5c\u4e0d\u53ef\u6062\u590d\u3002',
      confirmText: '\u6e05\u7a7a',
      run: () => {
        api.store.clearHistory()
        setConvos({})
        setReads({})
        focusComposer()
      },
    })
  }

  function clearAllDrafts () {
    setShowSettings(false)
    setConfirmAction({
      title: '\u6e05\u7a7a\u8349\u7a3f',
      text: '\u5c06\u6e05\u7a7a\u6240\u6709\u4f1a\u8bdd\u8349\u7a3f\u3002',
      confirmText: '\u6e05\u7a7a',
      run: () => {
        if (api.store.clearDrafts) api.store.clearDrafts()
        setDrafts({})
        setText('')
        focusComposer()
      },
    })
  }

  const nudgeTimesRef = useRef([])
  function nudgeActive () {
    const conv = activeRef.current
    if (!conv) return
    if (roomById(conv)) return
    if (!peerById(conv)?.online) { showChatNotice('\u5bf9\u65b9\u79bb\u7ebf\uff0c\u6682\u4e0d\u652f\u6301\u622a\u4e00\u622a'); return }
    const nowTs = Date.now()
    nudgeTimesRef.current = nudgeTimesRef.current.filter((t) => nowTs - t < 10000)
    if (nudgeTimesRef.current.length >= 5) { showChatNotice('\u622a\u5f97\u592a\u9891\u7e41\u4e86\uff0c10 \u79d2\u5185\u6700\u591a 5 \u6b21'); return }
    nudgeTimesRef.current.push(nowTs)
    api.p2p.nudge(conv)
    const t = (settingsRef.current.nudgeText || '').trim()
    const peerName = displayNameForId(conv, '\u5bf9\u65b9')
    pushMsg(conv, { mid: 'nudge-' + nowTs, system: true, text: '\u4f60\u622a\u4e86\u622a ' + peerName + (t ? ':' + t : ''), ts: nowTs })
    addToast({ title: '\u5df2\u53d1\u9001', text: t || '\u622a\u4e86\u5bf9\u65b9\u4e00\u4e0b \ud83d\udc4b', conv })
  }

  async function renameSelf (name) { const s = await api.p2p.setName(name); if (s) setSelf(s) }
  async function patchSettings (patch) {
    const s = await api.settings.set(patch); if (!s) return
    setSettings(s)
    if ('burnDefault' in patch) setBurnOn(!!s.burnDefault)
    if ('burnTtl' in patch) setBurnTtl(s.burnTtl || 10)
    if ('statusText' in patch) setSelf((prev) => (prev ? { ...prev, status: s.statusText || '' } : prev))
    if ('theme' in patch || 'fontPx' in patch || 'uiStyle' in patch || 'chatFont' in patch || 'chatFontPx' in patch) setDisplay({ theme: s.theme, fontPx: s.fontPx, uiStyle: s.uiStyle, chatFont: s.chatFont, chatFontPx: s.chatFontPx })
  }
  STATIC_GIF = !!settings.staticGif // 每次渲染同步动图静态展示开关，Avatar/StaticImg 读取
  const onlineCount = peers.filter((p) => p.online).length
  const presence = PRESENCE.find((p) => p.key === settings.presence) || PRESENCE[0]
  const activeRoom = roomById(active)
  const isRoom = !!activeRoom
  const activePinnedMessages = activeRoom ? sortPinnedList(pinnedByGroup[activeRoom.id] || []) : []
  const latestPinnedMessage = activePinnedMessages[0] || null
  const showDetail = isRoom || !!searchPane // 非群聊隐藏聊天详情栏，仅搜索时展示
  const activePeer = isRoom ? null : peers.find((p) => p.id === active)
  const mentionNameMap = {}
  for (const p of peers) {
    if (p && p.name && p.remark) mentionNameMap[p.name] = p.remark
  }
  const messages = convos[active] || []
  const visibleMessages = messages.length > visibleCount ? messages.slice(-visibleCount) : messages
  const hiddenCount = messages.length - visibleMessages.length
  // 备注映射：气泡内发送者名/撤回提示等优先显示本机备注
  const remarkById = {}
  for (const p of peers) { if (p.remark) remarkById[p.id] = p.remark }
  const renderUnits = []
  const batchUnits = new Map()
  for (const raw of visibleMessages) {
    const m = (!raw.self && raw.from && remarkById[raw.from]) ? { ...raw, name: remarkById[raw.from] } : raw
    const prev = renderUnits[renderUnits.length - 1]
    const groupable = !!m.batch && !m.system && !m.recalled && m.type !== 'file-offer' && !m.burn
    const batchKey = groupable ? [m.batch, !!m.self, m.from || ''].join('|') : ''
    if (groupable && batchUnits.has(batchKey)) {
      batchUnits.get(batchKey).items.push(m)
    } else if (groupable && prev && prev.groupable && prev.batch === m.batch && prev.self === !!m.self && prev.from === m.from) {
      prev.items.push(m)
      batchUnits.set(batchKey, prev)
    } else {
      const unit = { key: (m.mid || ('i' + renderUnits.length)), batch: m.batch || null, groupable, self: !!m.self, from: m.from, items: [m] }
      renderUnits.push(unit)
      if (groupable) batchUnits.set(batchKey, unit)
    }
  }
  // Telegram 式发送者分组：同一人 5 分钟内连续发送的消息共用头像、时间和表情回应
  const SENDER_GAP = 5 * 60000
  const senderGroups = []
  for (const u of renderUnits) {
    const m0 = u.items[0]
    const groupable = !m0.system && !m0.recalled && m0.type !== 'file-offer'
    const prev = senderGroups[senderGroups.length - 1]
    const prevUnit = prev ? prev.units[prev.units.length - 1] : null
    const prevLast = prevUnit ? prevUnit.items[prevUnit.items.length - 1] : null
    if (groupable && prev && prev.groupable && prev.self === u.self && prev.from === u.from && prevLast && (m0.ts - prevLast.ts) < SENDER_GAP && dayLabel(m0.ts) === dayLabel(prevLast.ts)) prev.units.push(u)
    else senderGroups.push({ key: u.key, self: u.self, from: u.from, groupable: groupable, units: [u] })
  }
  const messageAvatar = (m) => {
    if (!m || m.self) return settings.avatar
    const p = peerById(m.from)
    return (p && p.avatar) || m.avatar || null
  }
  const mMatch = text.match(/@(\S*)$/)
  const mentionQuery = mMatch ? mMatch[1].toLowerCase() : ''
  const roomMembers = activeRoom
    ? (activeRoom.members || []).map((id) => { if (id === (self && self.id)) return { id, name: self.name, publicName: self.name, online: true, self: true, presence: settings.presence || 'online', avatar: settings.avatar }; const p = peers.find((x) => x.id === id); return p ? { ...p, name: p.remark || p.name, publicName: p.name } : { id, name: nameById[id] || id.slice(0, 6), publicName: id.slice(0, 6), online: false } })
    : []
  const mentionBase = isRoom ? roomMembers.filter((p) => !p.self) : peers.filter((p) => p.online)
  const mentionAllOption = { id: '__mention_all__', name: '所有人', publicName: '所有人', mentionAll: true }
  const mentionAllAliases = ['所有人', '全体成员', 'all', 'everyone']
  const mentionAllVisible = isRoom && mMatch && mentionAllAliases.some((name) => name.toLowerCase().includes(mentionQuery))
  const mentionList = (isRoom && mMatch)
    ? [
        ...(mentionAllVisible ? [mentionAllOption] : []),
        ...mentionBase.filter((p) => ((p.name || '').toLowerCase().includes(mentionQuery) || (p.publicName || '').toLowerCase().includes(mentionQuery))).slice(0, mentionAllVisible ? 5 : 6),
      ]
    : []
  // 正在输入：取某会话内仍有效的输入者名称，多人时显示“a、b 等 n 人”
  const typingNamesOf = (convId) => {
    const m = typingPeers[convId] || {}
    return Object.keys(m).filter((id) => m[id] > now && id !== (self && self.id)).map((id) => nameById[id] || '有人')
  }
  const typingLabel = (names) => {
    if (!names.length) return ''
    const head = names.length <= 2 ? names.join('、') : (names.slice(0, 2).join('、') + ` 等 ${names.length} 人`)
    return head + ' 正在输入'
  }
  const peerTyping = activePeer && typingNamesOf(active).length > 0
  const roomTyping = typingLabel(activeRoom ? typingNamesOf(active) : [])
  const pinned = settings.pinned || []
  const muted = settings.muted || []
  const isPinned = (id) => pinned.includes(id)
  const isMuted = (id) => muted.includes(id)
  const sortedPeers = peers.slice().sort((a, b) => {
    const pa = isPinned(a.id) ? 0 : 1
    const pb = isPinned(b.id) ? 0 : 1
    if (pa !== pb) return pa - pb
    return displayNameForPeer(a).localeCompare(displayNameForPeer(b), 'zh-CN')
  })
  const activeDraft = drafts[active]
  const canSendActive = canSendToConv(active)
  const canAttachActive = !!activePeer || (isRoom && hasRoomRecipient(activeRoom)) // 私聊/群聊离线也可发（暂存补发）
  const canBurnActive = isRoom ? hasOnlineRoomRecipient(activeRoom) : !!(activePeer && activePeer.online) // 即焚需对端真在线（不暂存补发）
  const selectedMemberCount = Object.values(groupMembers).filter(Boolean).length
  const managedGroup = groupManage ? (groups.find((g) => g.id === groupManage.id) || groupManage) : null
  const managedMembers = managedGroup
    ? (managedGroup.members || []).map((id) => { if (id === (self && self.id)) return { id, name: self.name, online: true, self: true, presence: settings.presence || 'online', avatar: settings.avatar }; const p = peers.find((x) => x.id === id); return p ? { ...p, name: p.remark || p.name } : { id, name: nameById[id] || id.slice(0, 6), online: false } })
    : []
  const convTitle = (id) => {
    const room = roomById(id)
    if (room) return room.name || '群聊'
    return displayNameForId(id, '私聊')
  }
  const lastMsgOf = (id) => {
    const list = convos[id] || []
    return list.length ? list[list.length - 1] : null
  }
  const sideTime = (ts) => {
    if (!ts) return ''
    const d = dayLabel(ts)
    return d === '今天' ? fmtTime(ts).slice(0, 5) : d
  }
  const msgPreview = (id, fallback) => {
    const draft = drafts[id]
    if (draft && draft.trim()) return '草稿: ' + draft.trim()
    const m = lastMsgOf(id)
    if (!m) return fallback
    if (m.recalled) return (m.self ? '你' : displayNameForId(m.from, m.name || '对方')) + '撤回了一条消息'
    if (m.type === 'file' || m.type === 'file-offer') return (m.self ? '我: ' : '') + '[文件] ' + (m.fname || '')
    if (m.share && m.share.type === 'share-entry') return (m.self ? '我: ' : (roomById(id) && m.from ? displayNameForId(m.from, m.name || '') + ': ' : '')) + '[群文件] ' + (m.share.name || '')
    const body = localizeMentionsText((m.text || '').trim(), mentionNameMap) || (m.system ? '系统消息' : '')
    if (!body) return fallback
    if (m.self) return '我: ' + body
    if (roomById(id) && m.from) return displayNameForId(m.from, m.name || '') + ': ' + body
    return body
  }
  const onlineMemberCount = (group) => {
    const online = new Set(peers.filter((p) => p.online).map((p) => p.id))
    return (group.members || []).filter((id) => id !== (self && self.id) && online.has(id)).length
  }
  const conversationItems = [
    ...groups.map((g) => ({ id: g.id, kind: 'room', title: g.name || '群聊', group: g, subtitle: `${(g.members || []).length} 位成员 · ${onlineMemberCount(g)} 在线`, last: lastMsgOf(g.id) })),
    ...peers.map((p) => ({ id: p.id, kind: 'peer', title: displayNameForPeer(p), peer: p, subtitle: p.online ? (p.status || presenceOf(p).label) : '离线', last: lastMsgOf(p.id) })),
  ].map((item) => ({
    ...item,
    lastTs: item.last ? (item.last.ts || 0) : 0,
    preview: msgPreview(item.id, item.subtitle),
    timeLabel: sideTime(item.last ? item.last.ts : 0),
  }))
  const sideNeedle = sideQuery.trim().toLowerCase()
  const sideConversations = conversationItems
    .filter((item) => {
      // 只按群名/人名过滤；消息内容搜索走顶部全局搜索或会话内搜索
      if (sideNeedle && !(item.title || '').toLowerCase().includes(sideNeedle)) return false
      if (sideTab === 'groups') return item.kind === 'room'
      if (sideTab === 'online') return item.kind === 'peer' && item.peer && item.peer.online
      return true
    })
    .sort((a, b) => {
      const pa = isPinned(a.id) ? 0 : 1
      const pb = isPinned(b.id) ? 0 : 1
      if (pa !== pb) return pa - pb
      if (sideTab === 'all') return (b.lastTs || 0) - (a.lastTs || 0) || a.title.localeCompare(b.title)
      return a.title.localeCompare(b.title)
    })
  let lastDay = null

  return (
    <div className={'h-full flex flex-col ' + (shake ? 'shake' : '')}>
      <TopBar self={self} onGlobalSearch={() => setSearchPane((v) => (v === 'global' ? false : 'global'))} />
      {netError && (
        <div className="px-4 py-1 text-xs text-amber-400 shrink-0 flex items-center gap-2">
          <span>网络提示：{netError}</span>
          {api.p2p.reconnect && <button onClick={() => { setNetError('重连中…'); api.p2p.reconnect() }} className="underline hover:opacity-80 shrink-0">重连</button>}
        </div>
      )}

      <div className={'app-stage flex-1 min-h-0 ' + (standalone ? 'chat-only-shell flex' : (showDetail ? 'three-pane-layout' : 'two-pane-layout'))} style={!standalone && showDetail && paneWidth ? { gridTemplateColumns: `minmax(220px, 20%) minmax(480px, 1fr) 2px ${paneWidth}px` } : undefined}>
        {!standalone && <aside className="sidebar-surface flex flex-col overflow-hidden min-w-0 border-r bd-soft">
          <div className="p-4 border-b bd-soft">
            <div className="flex items-center gap-3">
              <button onClick={() => setShowProfile(true)} title="我的资料" className="shrink-0 rounded-full transition hover:opacity-90">
                <Avatar name={self ? self.name : '?'} id={self ? self.id : ''} avatar={settings.avatar} size={40} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold txt truncate flex items-center gap-1.5">
                  <span className="truncate">{self ? self.name : 'iLink'}</span>
                  {settings.anonymous && <span className="shrink-0 text-[10px] inline-flex items-center gap-0.5" style={{ color: '#ff9f0a' }}><EyeOff size={11} /> 匿名</span>}
                </div>
                {/* 状态选择 + 个性签名 */}
                <div className="mt-0.5 flex items-center gap-2">
                  <div className="relative shrink-0">
                    <button onClick={() => setPresenceOpen((v) => !v)} className="flex items-center gap-1.5 text-[11px] txt-dim hover:opacity-80">
                      <span className={'w-2 h-2 rounded-full shrink-0 ' + (presence.key === 'online' ? 'dot-pulse' : '')} style={{ background: presence.color }} />
                      {presence.label}
                      <ChevronDown size={10} className={'transition ' + (presenceOpen ? 'rotate-180' : '')} />
                    </button>
                    {presenceOpen && (
                      <div className="absolute left-0 top-full mt-1 floating-popover" style={{ '--popover-w': '150px' }}>
                        {PRESENCE.map((p) => (
                          <button key={p.key} onClick={() => { patchSettings({ presence: p.key }); setPresenceOpen(false) }} className="floating-menu-item">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                            <span className="flex-1">{p.label}</span>
                            {presence.key === p.key && <Check size={12} className="accent-txt shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 个性签名仅展示（未设置则不显示），编辑入口在点击头像的资料弹窗中 */}
                  {settings.statusText ? <span className="flex-1 min-w-0 text-[11px] txt-dim truncate" title={settings.statusText}>{settings.statusText}</span> : null}
                </div>
              </div>
            </div>
          </div>

          <div className="px-3 pt-3 pb-2 space-y-2">
            <div className="side-search">
              <Search size={13} className="txt-dim shrink-0" />
              <input value={sideQuery} onChange={(e) => setSideQuery(e.target.value)} placeholder="搜索会话" className="field flex-1 min-w-0 rounded-lg px-2 py-0.5 text-[11px]" />
              {sideQuery && <button onClick={() => setSideQuery('')} title="清除" className="txt-dim hover:opacity-70 shrink-0"><X size={12} /></button>}
            </div>
            <div className="seg-tabs grid grid-cols-3 gap-1">
              <button onClick={() => setSideTab('all')} className={sideTab === 'all' ? 'seg-tab seg-tab-active' : 'seg-tab'}>全部</button>
              <button onClick={() => setSideTab('groups')} className={sideTab === 'groups' ? 'seg-tab seg-tab-active' : 'seg-tab'}>群聊</button>
              <button onClick={() => setSideTab('online')} className={sideTab === 'online' ? 'seg-tab seg-tab-active' : 'seg-tab'}>在线({onlineCount})</button>
            </div>
          </div>

          <div className="flex-1 overflow-auto px-2 pb-2">
            {sideConversations.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-8 select-none">
                <div className="text-2xl float-soft">{sideNeedle ? '搜索' : '空'}</div>
                <div className="text-xs txt-dim text-center leading-relaxed">{sideNeedle ? `没有找到 "${sideQuery.trim()}"` : '暂无会话或联系人'}</div>
              </div>
            )}
            {sideConversations.map((item) => (
              <div key={item.id} onClick={() => selectConv(item.id)} onContextMenu={(e) => { e.preventDefault(); setSideMenu({ x: e.clientX, y: e.clientY, item }) }} className={'side-item w-full flex items-center gap-2.5 px-2.5 py-2 text-sm cursor-pointer ' + (active === item.id ? 'side-item-active' : '')}>
                {/* 头像 + 右上角未读角标；点击头像查看对应资料（不切换会话） */}
                <span
                  className="relative shrink-0 cursor-pointer"
                  title={item.kind === 'peer' ? '查看资料' : '查看群信息'}
                  onClick={(e) => { e.stopPropagation(); if (item.kind === 'peer') setProfilePeer(item.peer); else setGroupManage(item.group) }}
                >
                  {item.kind === 'peer' ? (
                    <Avatar name={item.title} id={item.id} size={30} dim={!item.peer.online} avatar={item.peer.avatar} />
                  ) : (
                    <GroupAvatar group={item.group} size={30} />
                  )}
                  <Badge n={unread[item.id]} corner muted={isMuted(item.id)} />
                </span>
                <span className="flex-1 min-w-0">
                  {/* 第一行：名称 + 身份标识 + 状态指示灯 + 置顶/免打扰 */}
                  <span className="flex items-end gap-1.5">
                    <span className="truncate font-medium leading-tight">{item.title}</span>
                    {item.kind === 'room' && item.group.ownerId === (self && self.id) && <Crown size={12} className="accent-txt shrink-0 mb-0.5" />}
                    {item.kind === 'peer' && (
                      <span
                        className={'w-2 h-2 rounded-full shrink-0 mb-1 ' + (presenceOf(item.peer).key === 'online' ? 'dot-pulse' : '')}
                        style={{ background: presenceOf(item.peer).color }}
                        title={presenceOf(item.peer).label}
                      />
                    )}
                    {/* 置顶/免打扰仅作状态标识，操作收入右键菜单 */}
                    <span className="ml-auto flex items-end gap-1 shrink-0 mb-0.5">
                      {isPinned(item.id) && <Pin size={11} className="accent-txt" title="已置顶" />}
                      {isMuted(item.id) && <BellOff size={11} className="txt-dim" title="已免打扰" />}
                    </span>
                  </span>
                  {/* 第二行：左侧预览/输入中，右侧时间 */}
                  <span className="flex items-center gap-2 mt-0.5">
                    {typingNamesOf(item.id).length > 0
                      ? <span className="flex-1 min-w-0 flex items-center text-[10px] truncate accent-txt">{typingLabel(typingNamesOf(item.id))}<span className="typing-dots"><i /><i /><i /></span></span>
                      : <span className={'flex-1 min-w-0 block text-[10px] truncate ' + (drafts[item.id] ? 'accent-txt' : 'txt-dim')}>{item.preview}</span>}
                    {item.timeLabel && <span className="text-[10px] txt-dim shrink-0">{item.timeLabel}</span>}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {/* 底部功能区 */}
          <div className="px-3 py-2.5 border-t bd-soft shrink-0 flex items-center gap-2">
            <button onClick={openCreateGroup} className="btn-primary flex-1 rounded-xl px-3 py-2 text-sm font-medium inline-flex items-center justify-center gap-2">
              <UserPlus size={15} /> 创建群聊
            </button>
            <button onClick={() => setShowSettings(true)} title="设置" className="icon-btn shrink-0"><Settings size={17} /></button>
          </div>
        </aside>}

        <main className="flex-1 chat-surface flex flex-col overflow-hidden min-w-0">
          <div className="chat-header flex items-center gap-3 px-4 border-b bd-soft shrink-0 text-sm txt">
            {activeRoom ? (
              <button onClick={() => setGroupManage(activeRoom)} title="查看群资料" className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-85 transition">
                <GroupAvatar group={activeRoom} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate font-semibold leading-tight">{activeRoom.name || '\u7fa4\u804a'}</span>
                    {activeRoom.ownerId === (self && self.id) && <Crown size={13} className="accent-txt shrink-0" />}
                    {isPinned(active) && <Pin size={12} className="accent-txt shrink-0" />}
                    {isMuted(active) && <BellOff size={12} className="txt-dim shrink-0" />}
                  </span>
                  <span className="block text-[11px] txt-dim leading-tight mt-0.5 truncate">
                    {roomTyping
                      ? <span className="accent-txt inline-flex items-center">{roomTyping}<span className="typing-dots"><i /><i /><i /></span></span>
                      : `${roomMembers.length} 位成员 · ${roomMembers.filter((p) => p.online).length} 在线`}
                  </span>
                </span>
              </button>
            ) : activePeer ? (
              <button onClick={() => setProfilePeer(activePeer)} title="查看资料" className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-85 transition">
                <span className="relative shrink-0">
                  <Avatar name={displayNameForPeer(activePeer)} id={activePeer.id} size={36} avatar={activePeer.avatar} dim={!activePeer.online} />
                  <span className={'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ' + (presenceOf(activePeer).key === 'online' ? 'dot-pulse' : '')} style={{ background: presenceOf(activePeer).color, border: '2px solid var(--bar-bg)' }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold leading-tight">{displayNameForPeer(activePeer, '\u79c1\u804a')}</span>
                  <span className="block text-[11px] leading-tight mt-0.5 truncate">
                    {peerTyping
                      ? <span className="accent-txt inline-flex items-center">正在输入...<span className="typing-dots"><i /><i /><i /></span></span>
                      : <>
                          <span style={{ color: presenceOf(activePeer).color }}>{presenceOf(activePeer).label}</span>
                          {activePeer.status && <span className="txt-dim"> · {activePeer.status}</span>}
                        </>}
                  </span>
                </span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-2 flex-1 min-w-0 txt-dim"><User size={15} /> <span className="truncate">选择左侧会话开始聊天</span></span>
            )}
            {activeRoom && <button onClick={() => setSharePanel(true)} title="群文件" className="icon-btn shrink-0"><HardDrive size={16} /></button>}
            {active && <button onClick={() => setHistoryOpen(true)} title="聊天记录" className={'icon-btn shrink-0 ' + (historyOpen ? 'accent-txt' : '')}><History size={16} /></button>}
            {active && <button onClick={() => setSearchPane((v) => (v ? false : 'chat'))} title="搜索聊天" className={'icon-btn shrink-0 ' + (searchPane ? 'accent-txt' : '')}><Search size={16} /></button>}
          </div>
          {activeRoom && latestPinnedMessage && (
            <button onClick={() => setPinnedListOpen(true)} className="pinned-bar shrink-0 flex items-center gap-2 px-4 py-2 text-left border-b bd-soft">
              <Pin size={14} className="accent-txt shrink-0" />
              <PinnedAttachmentPreview pin={latestPinnedMessage} compact />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] accent-txt font-medium">{activePinnedMessages.length > 1 ? `当前有 ${activePinnedMessages.length} 条置顶消息` : '置顶消息'}</span>
                <span className="block text-xs txt truncate">{pinnedTopPreview(latestPinnedMessage)}</span>
              </span>
              <ChevronRight size={14} className="txt-dim shrink-0" />
            </button>
          )}
          <div
            className="relative flex-1 min-h-0"
            onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) setDragOver(true) }}
            onDragLeave={(e) => { if (!(e.relatedTarget && e.currentTarget.contains(e.relatedTarget))) setDragOver(false) }}
            onDrop={(e) => { setDragOver(false); sendDroppedFilesDirect(e) }}
          >
          <div ref={scrollRef} onScroll={onMessagesScroll} className="messages-scroll h-full overflow-auto">
            {hiddenCount > 0 && (
              <div className="flex justify-center shrink-0">
                <button onClick={loadOlderMessages} className="system-msg hover:opacity-80">↑ 上滑加载更早消息（还有 {hiddenCount} 条）</button>
              </div>
            )}
            {messages.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center gap-2.5 select-none">
                <div className="text-4xl float-soft">{active ? '💬' : '👋'}</div>
                <div className="text-xs txt-dim">{active ? '还没有消息，开始聊天吧' : '选择左侧会话开始聊天'}</div>
              </div>
            )}
            {senderGroups.map((sg) => {
              const firstMsg = sg.units[0].items[0]
              const day = dayLabel(firstMsg.ts); const sep = day !== lastDay; lastDay = day
              const multi = sg.units.length > 1
              const mergedR = multi ? mergeMessageReactions(sg.units) : undefined
              const onCtx = (mm, e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, m: mm, canRecall: mm.self && !mm.recalled && (Date.now() - mm.ts < 120000) }) }
              return (
                <div key={sg.key} className={multi ? 'msg-group' : undefined}>
                  {sep && <div className="flex justify-center"><span className="day-sep">{day}</span></div>}
                  {sg.units.map((u, ui) => {
                    const isLastU = ui === sg.units.length - 1
                    const m = u.items[0]
                    const shared = {
                      avatarSpacer: multi && !isLastU,
                      hideMeta: multi && !isLastU,
                      metaReactions: multi && isLastU ? mergedR : undefined,
                    }
                    // 同批次文字和多附件单元
                    if (u.items.length > 1) {
                      return (
                        <div key={u.key}>
                          <BatchMsg
                            items={u.items}
                            markdown={!!settings.markdown}
                            showName={isRoom && !sg.self && ui === 0}
                            selfAvatar={settings.avatar}
                            peerAvatar={messageAvatar(m)}
                            progressMap={fileProgress}
                            flashMid={flashMid}
                            onCtx={onCtx}
                            mentionNames={mentionNameMap}
                            {...shared}
                          />
                        </div>
                      )
                    }
                    const canRecallM = m.self && !m.recalled && (Date.now() - m.ts < 120000)
                    return (
                      <div
                        key={m.mid || u.key}
                        data-mid={m.mid || undefined}
                        className={flashMid && flashMid === m.mid ? 'msg-flash' : ''}
                        onContextMenu={(!m.system && !m.recalled && m.mid) ? (e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, m, canRecall: canRecallM }) } : undefined}
                      >
                        {m.system
                          ? <div className="flex justify-center"><span className="system-msg">{localizeKnownNamesText(m.text, mentionNameMap)}</span></div>
                          : m.recalled
                            ? (
                              <div className="flex justify-center">
                                <span className="system-msg">
                                  {m.self ? '你撤回了一条消息' : `${m.name || '对方'} 撤回了一条消息`}
                                  {m.self && m.recalledText && <button onClick={() => reEdit(m)} className="accent-txt ml-1.5 hover:underline">重新编辑</button>}
                                </span>
                              </div>
                              )
                            : (m.share && m.share.type === 'share-entry'
                                ? <ShareEntryMsg m={m} showName={isRoom && !m.self && ui === 0} onOpen={openSharedEntry} selfAvatar={settings.avatar} peerAvatar={messageAvatar(m)} onRetry={retryMessage} {...shared} />
                                : ((m.type === 'file' || m.type === 'file-offer')
                                    ? <FileMsg m={m} progress={fileProgress[m.mid]} onAccept={acceptFile} onReject={rejectFile} onCancel={cancelFile} onRetry={retryFile} selfAvatar={settings.avatar} peerAvatar={messageAvatar(m)} {...shared} />
                                    : <Bubble m={m} now={now} showName={isRoom && !m.self && ui === 0} markdown={!!settings.markdown} selectMode={selectMode} selected={!!selected[m.mid]} onToggleSelect={toggleSelect} selfAvatar={settings.avatar} peerAvatar={messageAvatar(m)} onRetry={retryMessage} mentionNames={mentionNameMap} {...shared} />))}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
          {dragOver && (
            <div className="drop-overlay">
              <Send size={22} />
              <span>松开鼠标，立即发送文件</span>
            </div>
          )}
          {!atBottom && (
            <button onClick={jumpToBottom} className="jump-bottom" title="回到底部">
              {newBelow > 0 ? `${newBelow} 条新消息` : '回到底部'} <ChevronDown size={14} />
            </button>
          )}
          </div>

          {chatNotice && (
            <div className="flex justify-center px-4 pb-1 shrink-0">
              <span className="text-[11.5px] px-3 py-1.5 rounded-full" style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}>{chatNotice}</span>
            </div>
          )}

          <div
            className="composer-surface composer-box border-t bd-soft shrink-0 relative"
            onDragOver={(e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); setComposerDragOver(true) } }}
            onDragLeave={(e) => { if (!(e.relatedTarget && e.currentTarget.contains(e.relatedTarget))) setComposerDragOver(false) }}
            onDrop={(e) => { e.preventDefault(); setComposerDragOver(false); onDropFiles(e) }}
          >
            {composerDragOver && (
              <div className="drop-overlay">
                <Paperclip size={22} />
                <span>松开鼠标，添加到发送栏</span>
              </div>
            )}
            {mentionList.length > 0 && (
              <div className="absolute left-3 bottom-[60px] floating-popover" style={{ '--popover-w': '192px' }}>
                {mentionList.map((p) => (
                  <button key={p.id} onClick={() => insertMention(p)} title={p.mentionAll ? '通知所有群成员' : undefined} className="floating-menu-item">
                    {p.mentionAll
                      ? <span className="w-[18px] h-[18px] rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}><Users size={12} /></span>
                      : <Avatar name={p.name} id={p.id} size={18} avatar={p.avatar} />}
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
            {replyTo && (
              <div className="flex items-center gap-2 mb-2 text-xs px-2 py-1 rounded-lg" style={{ background: 'var(--hover)' }}>
                <span className="accent-txt shrink-0">回复</span>
                <span className="txt-dim truncate flex-1">{replyTo.name}: {replyTo.text}</span>
                <button onClick={() => setReplyTo(null)} className="txt-dim"><X size={12} /></button>
              </div>
            )}
            {/* 待发送附件预览 */}
            {pendingAtts.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pendingAtts.map((a, i) => (
                  <div key={a.path + i} className="flex items-center gap-1.5 rounded-lg px-1.5 py-1" style={{ background: 'var(--hover)', border: '1px solid var(--border-soft)' }}>
                    {a.preview
                      ? <img src={a.preview} alt="" className="w-10 h-10 object-cover rounded-md" />
                      : <span className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-tint)' }}><FileIcon size={13} className="accent-txt" /></span>}
                    <span className="min-w-0">
                      <span className="block text-[11px] txt max-w-[120px] truncate">{a.name}</span>
                      {a.size > 0 && <span className="block text-[9.5px] txt-dim">{fmtSize(a.size)}</span>}
                    </span>
                    <button onClick={() => removePendingAtt(i)} title="移除" className="txt-dim hover:opacity-70 shrink-0"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-tools flex items-center gap-2 mb-2 text-xs">
              {/* 字体按钮与面板：面板展示在图标正上方 */}
              <span className="relative">
                <button ref={fontBtnRef} onClick={() => { setFontOpen((v) => !v); setEmojiOpen(false); setShotOpen(false) }} title="字体设置" className={'btn-ghost inline-flex items-center justify-center px-2.5 py-1 rounded-md text-[13.5px] font-semibold leading-none ' + (fontOpen ? 'accent-txt' : '')}>A</button>
                {fontOpen && (
                  <div ref={fontPanelRef} className="absolute bottom-full left-0 mb-1.5 floating-popover" style={{ '--popover-w': '184px' }}>
                    <div className="space-y-0.5">
                      {CHAT_FONTS.map((f) => (
                        <button key={f.label} onClick={() => patchSettings({ chatFont: f.family })} style={{ fontFamily: f.family, background: settings.chatFont === f.family ? 'var(--accent-tint)' : 'transparent' }} className="floating-menu-item">
                          <span className="flex-1 truncate">{f.label}</span>
                          {settings.chatFont === f.family && <Check size={13} className="accent-txt shrink-0" />}
                        </button>
                      ))}
                    </div>
                    <div className="mt-1.5 pt-2 px-1 border-t bd-soft">
                      <input
                        type="range" min={12} max={22} step={0.5} value={fontDraft} title="聊天字号"
                        onChange={(e) => { const v = parseFloat(e.target.value); setFontDraft(v); setDisplay({ theme: settings.theme, fontPx: settings.fontPx, uiStyle: settings.uiStyle, chatFont: settings.chatFont, chatFontPx: v }) }}
                        onMouseUp={(e) => patchSettings({ chatFontPx: parseFloat(e.currentTarget.value) })}
                        onTouchEnd={(e) => patchSettings({ chatFontPx: parseFloat(e.currentTarget.value) })}
                        className="w-full accent-indigo-500"
                      />
                    </div>
                  </div>
                )}
              </span>
              {/* 截图按钮与选项 */}
              <span className="relative">
                <button ref={shotBtnRef} onClick={() => { setShotOpen((v) => !v); setEmojiOpen(false); setFontOpen(false) }} disabled={!canAttachActive} title="截图" className={'btn-ghost inline-flex items-center gap-1 px-2 py-1 rounded-md disabled:opacity-40 ' + (shotOpen ? 'accent-txt' : '')}><Camera size={14} /></button>
                {shotOpen && (
                  <div ref={shotPanelRef} className="absolute bottom-full left-0 mb-1.5 floating-popover" style={{ '--popover-w': '184px' }}>
                    <button onClick={() => takeShot('full')} className="floating-menu-item"><Monitor size={13} /> 截取屏幕</button>
                    <button onClick={() => takeShot('hide')} className="floating-menu-item"><EyeOff size={13} /> 隐藏窗口截图</button>
                  </div>
                )}
              </span>
              {/* 表情按钮与面板：固定尺寸，内容区滚动懒加载；Emoji/表情包切换放在底部 */}
              <span className="relative">
                <button ref={emojiBtnRef} onClick={() => { setEmojiOpen((v) => !v); setFontOpen(false); setShotOpen(false) }} className={'btn-ghost inline-flex items-center gap-1 px-2 py-1 rounded-md ' + (emojiOpen ? 'accent-txt' : '')}><Smile size={14} /></button>
                {emojiOpen && (
                  <div ref={emojiPanelRef} className="absolute bottom-full left-0 mb-1.5 floating-popover flex flex-col" style={{ '--popover-w': '328px', height: 326 }}>
                    <div onScroll={onEmojiPickerScroll} className="flex-1 min-h-0 overflow-auto scroll pr-1">
                      {emojiTab === 'emoji' ? (
                        <div className="grid grid-cols-8 gap-1">
                          {/* key 带索引：EMOJIS 中存在重复表情，纯字符 key 重复会导致切换标签时渲染错位 */}
                          {EMOJIS.slice(0, emojiVisibleCount).map((e, i) => <button key={i + e} onClick={() => { setText((t) => t + e); setEmojiOpen(false) }} className="text-lg rounded-lg hover:bg-[var(--hover)] min-h-8">{e}</button>)}
                        </div>
                      ) : (
                        <div className="grid grid-cols-4 gap-1.5">
                          {stickers.slice(0, stickerVisibleCount).map((s) => (
                            <button
                              key={s.id}
                              onClick={() => sendSticker(s)}
                              onContextMenu={(e) => { e.preventDefault(); removeSticker(s.id) }}
                              title="点击发送 · 右键删除"
                              className="rounded-lg hover:bg-[var(--hover)] p-1"
                            >
                              <StaticImg src={s.dataUrl} alt="" className="w-full h-14 object-contain" />
                            </button>
                          ))}
                          {stickers.length === 0 && <div className="col-span-4 text-[11px] txt-dim text-center py-16">还没有表情包，点击下方“导入”添加图片（支持 GIF）</div>}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 pt-2 border-t bd-soft flex items-center gap-1 shrink-0">
                      <button onClick={() => setEmojiTab('emoji')} className={'text-[11px] rounded-lg px-2.5 py-1.5 ' + (emojiTab === 'emoji' ? 'btn-primary' : 'btn-ghost')}>Emoji</button>
                      <button onClick={() => { setEmojiTab('sticker'); loadStickers() }} className={'text-[11px] rounded-lg px-2.5 py-1.5 ' + (emojiTab === 'sticker' ? 'btn-primary' : 'btn-ghost')}>表情包</button>
                      {emojiTab === 'sticker' && <button onClick={importStickers} className="ml-auto btn-ghost text-[11px] rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1"><Upload size={11} /> 导入</button>}
                    </div>
                  </div>
                )}
              </span>
              <button onClick={attachFiles} disabled={!canAttachActive} title="发送文件" className="btn-ghost inline-flex items-center gap-1 px-2 py-1 rounded-md disabled:opacity-40"><Paperclip size={14} /></button>
              <button onClick={() => { setSelectMode((v) => !v); setSelected({}) }} title="多选转发" className={'inline-flex items-center gap-1 px-2 py-1 rounded-md border transition ' + (selectMode ? 'border-emerald-500/50 accent-txt' : 'btn-ghost')}><Forward size={13} /></button>
              {selectMode && <button onClick={() => setForwardOpen(true)} disabled={!Object.keys(selected).length} className="btn-primary text-xs rounded px-2 py-1 disabled:opacity-40">转发 {Object.keys(selected).length || ''}</button>}
              {activePeer && (
                <span className="relative" onMouseEnter={openNudgeHover} onMouseLeave={closeNudgeHover}>
                  <button onClick={nudgeActive} disabled={!activePeer.online} title={activePeer.online ? '' : '对方离线'} className="btn-ghost inline-flex items-center gap-1 px-2 py-1 rounded-md disabled:opacity-40"><Hand size={14} /> 戳一戳</button>
                  {/* 戳一戳自定义文字面板 */}
                  {nudgeHover && (
                    <div className="absolute bottom-full left-0 pb-1.5" onMouseEnter={openNudgeHover}>
                      <div className="floating-popover" style={{ '--popover-w': '224px' }}>
                        <div className="text-[10px] txt-dim mb-1">自定义戳一戳附带文字</div>
                        <input
                          value={nudgeDraft}
                          maxLength={20}
                          onChange={(e) => setNudgeDraft(e.target.value.slice(0, 20))}
                          onBlur={commitNudgeText}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNudgeText() } }}
                          placeholder="最多 20 个字符"
                          className="field w-full rounded-lg px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </span>
              )}
              <button onClick={() => setBurnOn((v) => !v)} disabled={!canBurnActive} title={canBurnActive ? ('阅后即焚，' + burnTtl + ' 秒后删除') : '对方离线，阅后即焚不可用'} className={'inline-flex items-center gap-1 px-2 py-1 rounded-full border transition disabled:opacity-40 ' + (burnOn && canBurnActive ? 'burn-on' : 'btn-ghost')}><Flame size={13} /> 即焚 {burnOn && canBurnActive ? '开' : '关'}</button>
              <span className="ml-auto shrink-0 inline-flex items-center gap-2.5">
                {activeDraft && <span className="txt-dim text-[10.5px]">草稿已保存</span>}
                <span className="composer-hint">
                  <kbd>{(settings.sendKey || 'enter') === 'ctrlEnter' ? 'Ctrl+Enter' : 'Enter'}</kbd> 发送
                  <span className="opacity-50">·</span>
                  <kbd>{(settings.sendKey || 'enter') === 'ctrlEnter' ? 'Enter' : 'Shift+Enter'}</kbd> 换行
                </span>
              </span>
            </div>
            <div className="composer-input-wrap flex items-end gap-2">
              <textarea ref={composerRef} value={text} onChange={onTextChange} onKeyDown={onKeyDown} onPaste={onComposerPaste} rows={1} placeholder={!active ? '请选择会话' : (!canSendActive ? (isRoom ? '群聊没有可接收成员' : '请选择会话') : `发送给 ${convTitle(active)}...`)} className="field composer-input flex-1 resize-none rounded-lg px-3 py-2 text-sm max-h-32" />
              <button onClick={handleSend} disabled={(!text.trim() && !pendingAtts.length) || !canSendActive} className="btn-primary composer-send inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40"><Send size={15} />{pendingAtts.length > 0 ? ` 发送 ${pendingAtts.length} 个文件` : ' 发送'}</button>
            </div>
          </div>        </main>

        {!standalone && showDetail && <>
          <div className="pane-resizer shrink-0" onMouseDown={startPaneDrag} title="拖拽调整宽度" />
          <div className="detail-pane min-w-0 overflow-hidden flex" style={paneWidth ? { width: paneWidth } : undefined}>
            <DetailPane
              active={active}
              activePeer={activePeer}
              activeRoom={activeRoom}
              roomMembers={roomMembers}
              peers={peers}
              self={self}
              searchPane={searchPane}
              convos={convos}
              convTitle={convTitle}
              locateMessage={locateMessage}
              onOpenFile={(p) => api.file.open(p)}
              onCloseSearch={() => setSearchPane(false)}
              onMemberClick={(p) => { if (p.self) setShowProfile(true); else setProfilePeer(peerById(p.id) || p) }}
              onAddMember={(ids) => addGroupMembers(activeRoom, ids)}
              onKickMember={(p) => removeGroupMember(activeRoom, p)}
              onOpenProfile={(p) => setProfilePeer(p)}
              displayNameForId={displayNameForId}
              mentionNames={mentionNameMap}
            />
          </div>
        </>}
      </div>

      {historyOpen && active && (
        <HistoryPanel
          title={convTitle(active)}
          messages={convos[active] || []}
          selfName={self ? self.name : '?'}
          selfAvatar={settings.avatar}
          onLocate={(mid) => { setHistoryOpen(false); locateMessage(active, mid) }}
          onOpenFile={(p) => api.file.open(p)}
          onClose={() => setHistoryOpen(false)}
          displayNameForId={displayNameForId}
          mentionNames={mentionNameMap}
        />
      )}
      {showSettings && <SettingsPanel settings={settings} onPatch={patchSettings} onClose={() => setShowSettings(false)} onLock={onLock} onReset={onReset} onClearHistory={clearAllHistory} onClearDrafts={clearAllDrafts} />}
      {showProfile && self && <ProfileDialog person={{ ...self, avatar: settings.avatar }} editable settings={settings} onPatchSettings={patchSettings} onRename={renameSelf} onClose={() => setShowProfile(false)} />}
      {profilePeer && <ProfileDialog person={profilePeer} onSetRemark={(v) => api.store.setRemark(profilePeer.id, v)} onClose={() => setProfilePeer(null)} />}
      {sharePanel && activeRoom && <ShareSpacePanel room={activeRoom} self={self} peers={peers} nameById={nameById} onClose={() => setSharePanel(false)} requestConfirm={setConfirmAction} onForwardEntry={forwardShareEntry} initialTarget={sharePanelTarget} />}
      {pinnedListOpen && activeRoom && (
        <Overlay onClose={() => setPinnedListOpen(false)}>
          <div className="floating-dialog floating-dialog-md floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="置顶消息">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold txt inline-flex items-center gap-2"><Pin size={15} /> 置顶消息</div>
                <div className="text-xs txt-dim mt-0.5 truncate">{activeRoom.name || '群聊'} · {activePinnedMessages.length} 条</div>
              </div>
              <button onClick={() => setPinnedListOpen(false)} className="txt-dim hover:opacity-70 shrink-0"><X size={16} /></button>
            </div>
            <div className="mt-4 max-h-[62vh] overflow-auto scroll space-y-2 pr-1">
              {activePinnedMessages.length === 0 && <div className="text-xs txt-dim px-3 py-8 text-center">暂无置顶消息</div>}
              {activePinnedMessages.map((pin) => {
                const snap = pin.messageSnapshot || {}
                return (
                  <div key={pin.pinId} className="pinned-list-item rounded-xl p-3">
                    <div className="flex items-start gap-2">
                      <PinnedAttachmentPreview pin={pin} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 text-sm txt whitespace-pre-wrap break-words">{localizeMentionsText(pin.contentPreview || snap.contentPreview || '[消息]', mentionNameMap)}</div>
                          <PinnedMetaPopover pin={pin} />
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <button onClick={() => viewPinnedOriginal(pin)} className="btn-ghost text-xs rounded-lg px-2.5 py-1.5">查看原消息</button>
                      <button onClick={() => confirmUnpinPinnedMessage(pin)} className="btn-ghost text-xs rounded-lg px-2.5 py-1.5 text-red-400">取消置顶</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </Overlay>
      )}
      {snapshotView && (
        <Overlay onClose={() => setSnapshotView(null)}>
          <div className="floating-dialog floating-dialog-md floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="置顶快照">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold txt inline-flex items-center gap-2"><Pin size={15} /> 置顶快照</div>
              <button onClick={() => setSnapshotView(null)} className="txt-dim hover:opacity-70 shrink-0"><X size={16} /></button>
            </div>
            <div className="mt-2 text-xs txt-dim leading-relaxed">{snapshotView.text}</div>
            {(() => {
              const pin = snapshotView.pin || {}
              const snap = pin.messageSnapshot || {}
              const original = snap.originalContent
              const body = typeof original === 'string'
                ? original
                : (snap.contentPreview || pin.contentPreview || '[消息]')
              return (
                <div className="mt-4 rounded-xl p-3" style={{ background: 'var(--hover)', border: '1px solid var(--border-soft)' }}>
                  <div className="flex items-start gap-3">
                    <PinnedAttachmentPreview pin={pin} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 text-sm txt whitespace-pre-wrap break-words">{localizeMentionsText(body, mentionNameMap)}</div>
                        <PinnedMetaPopover pin={pin} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        </Overlay>
      )}
      {confirmAction && <ConfirmDialog title={confirmAction.title} text={confirmAction.text} confirmText={confirmAction.confirmText} onClose={() => { setConfirmAction(null); focusComposer() }} onConfirm={() => { const action = confirmAction; setConfirmAction(null); setTimeout(() => action.run(), 0) }} />}
      {showCreateGroup && (
        <Overlay onClose={() => setShowCreateGroup(false)}>
          <div className="floating-dialog floating-dialog-md floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="创建群聊">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold txt inline-flex items-center gap-2"><UserPlus size={16} /> 创建群聊</div>
              <button onClick={() => setShowCreateGroup(false)} className="txt-dim hover:opacity-70"><X size={16} /></button>
            </div>
            <input autoFocus value={groupName} onChange={(e) => setGroupName(e.target.value.slice(0, 40))} placeholder="群聊名称" className="field mt-4 w-full rounded-lg px-3 py-2 text-sm" />
            <div className="mt-4 text-xs txt-dim">选择成员（包含离线联系人）</div>
            <div className="mt-2 max-h-72 overflow-auto scroll space-y-1">
              {sortedPeers.length === 0 && <div className="text-xs txt-dim rounded-lg px-3 py-4" style={{ background: 'var(--hover)' }}>暂无可选联系人</div>}
              {sortedPeers.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-[var(--hover)] cursor-pointer">
                  <input type="checkbox" checked={!!groupMembers[p.id]} onChange={() => toggleGroupMember(p.id)} className="accent-emerald-500" />
                  <Avatar name={displayNameForPeer(p)} id={p.id} size={24} dim={!p.online} avatar={p.avatar} />
                  <span className="text-sm txt flex-1 min-w-0 truncate">{displayNameForPeer(p)}</span>
                  <span className={'text-[11px] ' + (p.online ? 'accent-txt' : 'txt-dim')}>{p.online ? '在线' : '离线'}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs txt-dim">已选 {selectedMemberCount} 人</span>
              <div className="flex gap-2">
                <button onClick={() => setShowCreateGroup(false)} className="btn-ghost text-sm rounded-lg px-3 py-1.5">取消</button>
                <button onClick={createGroup} disabled={!groupName.trim() || !selectedMemberCount} className="btn-primary text-sm rounded-lg px-3 py-1.5 disabled:opacity-40">创建</button>
              </div>
            </div>
          </div>
        </Overlay>
      )}
      {managedGroup && (
        <Overlay onClose={() => setGroupManage(null)}>
          <div className="floating-dialog floating-dialog-md floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="群资料">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex items-center gap-3">
                <GroupAvatar group={managedGroup} size={44} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold txt truncate">{managedGroup.name}</div>
                  <div className="text-xs txt-dim mt-0.5">{managedMembers.length} 位成员 · 群主 {((managedMembers.find((p) => p.id === managedGroup.ownerId) || {}).self ? '我' : ((managedMembers.find((p) => p.id === managedGroup.ownerId) || {}).name || convTitle(managedGroup.ownerId)))}</div>
                  {managedGroup.ownerId === (self && self.id) && (
                    <div className="mt-1.5 flex gap-2">
                      <button onClick={() => changeGroupAvatar(managedGroup)} className="btn-ghost text-[11px] rounded-lg px-2 py-1 inline-flex items-center gap-1"><ImageIcon size={12} /> 更换群头像</button>
                      {managedGroup.avatar && <button onClick={() => resetGroupAvatar(managedGroup)} className="btn-ghost text-[11px] rounded-lg px-2 py-1">恢复默认</button>}
                      <button onClick={() => dismissGroup(managedGroup)} className="btn-ghost text-[11px] rounded-lg px-2 py-1 inline-flex items-center gap-1 text-red-500"><Trash2 size={12} /> 解散群聊</button>
                    </div>
                  )}
                </div>
              </div>
              <button onClick={() => setGroupManage(null)} className="txt-dim hover:opacity-70 shrink-0"><X size={16} /></button>
            </div>
            <div className="mt-4 max-h-80 overflow-auto scroll space-y-1">
              {managedMembers.map((p) => {
                const isOwner = managedGroup.ownerId === p.id
                const canTransfer = managedGroup.ownerId === (self && self.id) && !isOwner
                return (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-2" style={{ background: isOwner ? 'var(--hover)' : 'transparent' }}>
                    <Avatar name={p.name} id={p.id} size={26} dim={!p.online} avatar={p.avatar} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm txt truncate">{p.self ? '我' : p.name}{isOwner && <Crown size={12} className="inline ml-1 accent-txt" />}</div>
                      <div className="text-[11px]" style={{ color: presenceOf(p).color }}>{presenceOf(p).label}</div>
                    </div>
                    {canTransfer && <button onClick={() => transferGroupOwner(managedGroup, p.id)} className="btn-ghost text-xs rounded-lg px-2 py-1">转让群主</button>}
                    {managedGroup.ownerId === (self && self.id) && !isOwner && !p.self && <button onClick={() => removeGroupMember(managedGroup, p)} className="btn-ghost text-xs rounded-lg px-2 py-1 text-red-400">移出</button>}
                  </div>
                )
              })}
            </div>
          </div>
        </Overlay>
      )}
      {forwardOpen && (
        <Overlay onClose={() => setForwardOpen(false)}>
          <div className="floating-dialog floating-dialog-sm floating-surface glass-panel floating-dialog-pad" role="dialog" aria-modal="true" aria-label="转发消息">
            <div className="text-sm font-semibold txt mb-2">转发 {Object.keys(selected).length} 条消息</div>
            <div className="seg-tabs grid grid-cols-2 gap-1 mb-1.5 text-xs">
              <button onClick={() => setForwardMode('each')} className={forwardMode === 'each' ? 'seg-tab seg-tab-active' : 'seg-tab'}>逐条转发</button>
              <button onClick={() => setForwardMode('merge')} className={forwardMode === 'merge' ? 'seg-tab seg-tab-active' : 'seg-tab'}>合并转发</button>
            </div>
            <div className="text-[10.5px] txt-dim mb-2">{forwardMode === 'each' ? '逐条发送到目标会话' : '合并为一条聊天记录发送'}</div>
            {groups.length === 0 && peers.length === 0 && <div className="text-xs txt-dim px-2 py-3">暂无可转发会话</div>}
            {groups.map((g) => <button key={g.id} onClick={() => doForward(g.id)} className="floating-menu-item"><GroupAvatar group={g} size={20} /> <span className="truncate">{g.name}</span></button>)}
            {peers.map((p) => <button key={p.id} onClick={() => doForward(p.id)} className="floating-menu-item"><Avatar name={displayNameForPeer(p)} id={p.id} size={20} avatar={p.avatar} /> <span className="truncate">{displayNameForPeer(p)}</span></button>)}
          </div>
        </Overlay>
      )}

      {/* 会话右键菜单 */}
      {sideMenu && (
        <div className="floating-context-layer" onClick={() => setSideMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSideMenu(null) }}>
          <div
            className="absolute floating-menu"
            style={{ '--menu-w': '184px', left: Math.max(8, Math.min(sideMenu.x, window.innerWidth - 204)), top: Math.max(8, Math.min(sideMenu.y, window.innerHeight - 190)) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => { togglePin(sideMenu.item.id); setSideMenu(null) }} className="floating-menu-item"><Pin size={14} /> {isPinned(sideMenu.item.id) ? '取消置顶' : '置顶'}</button>
            <button onClick={() => { toggleMute(sideMenu.item.id); setSideMenu(null) }} className="floating-menu-item">{isMuted(sideMenu.item.id) ? <Bell size={14} /> : <BellOff size={14} />} {isMuted(sideMenu.item.id) ? '取消免打扰' : '免打扰'}</button>
            <button onClick={() => { setSideMenu(null); clearConv(sideMenu.item.id) }} className="floating-menu-item"><Trash2 size={14} /> 清空会话</button>
            {sideMenu.item.kind === 'room' && (
              <button onClick={() => { setSideMenu(null); sideMenu.item.group && sideMenu.item.group.ownerId === (self && self.id) ? dismissGroup(sideMenu.item.group) : leaveGroup(sideMenu.item.group) }} className="floating-menu-item danger"><X size={14} /> {sideMenu.item.group && sideMenu.item.group.ownerId === (self && self.id) ? '解散群聊' : '退出群聊'}</button>
            )}
          </div>
        </div>
      )}

      {/* 消息右键菜单 */}
      {ctxMenu && (
        <div className="floating-context-layer" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div
            className="absolute floating-menu"
            style={{ '--menu-w': '204px', left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 224)), top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 270)) }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between px-1.5 pb-1.5">
              {REACTIONS.slice(0, 6).map((e) => (
                <button key={e} onClick={() => { doReact(ctxMenu.m, e); setCtxMenu(null) }} className="text-base leading-none hover:scale-125 transition">{e}</button>
              ))}
            </div>
            <div className="floating-menu-sep" />
            <button onClick={() => { doReply(ctxMenu.m); setCtxMenu(null) }} className="floating-menu-item"><Reply size={14} /> 回复</button>
            {ctxMenu.m.text && !isShareEntryMessage(ctxMenu.m) && (
              <button onClick={() => { copyText(ctxMenu.m.text); setCtxMenu(null) }} className="floating-menu-item"><Copy size={14} /> 复制</button>
            )}
            {ctxMenu.m.text && !isShareEntryMessage(ctxMenu.m) && (
              <button onClick={() => { setSelected({ [ctxMenu.m.mid]: true }); setSelectMode(true); setForwardOpen(true); setCtxMenu(null) }} className="floating-menu-item"><Forward size={14} /> 转发</button>
            )}
            {(ctxMenu.m.type === 'file') && ctxMenu.m.path && (
              <button onClick={() => { api.file.open(ctxMenu.m.path); setCtxMenu(null) }} className="floating-menu-item"><FileIcon size={14} /> 打开文件</button>
            )}
            {isRoom && !ctxMenu.m.burn && ctxMenu.m.type !== 'file-offer' && (
              pinnedRecordForMessage(active, ctxMenu.m.mid)
                ? <button disabled className="floating-menu-item"><Pin size={14} /> 已置顶</button>
                : <button onClick={() => { pinChatMessage(ctxMenu.m); setCtxMenu(null) }} className="floating-menu-item"><Pin size={14} /> 置顶此消息</button>
            )}
            {ctxMenu.canRecall && (
              <button onClick={() => { doRecall(ctxMenu.m); setCtxMenu(null) }} className="floating-menu-item danger"><Undo2 size={14} /> 撤回</button>
            )}
          </div>
        </div>
      )}

      <div className="fixed bottom-4 right-4 flex flex-col gap-2 items-end" style={{ zIndex: 'var(--z-toast)' }}>
        {toasts.map((t) => (
          <button key={t.id} aria-live="polite" aria-label={(t.title || '') + ' ' + (t.text || '')} onClick={() => { selectConv(t.conv); setToasts((p) => p.filter((x) => x.id !== t.id)) }} className={'glass-panel floating-toast text-left ' + (t.leaving ? 'toast-out' : 'toast-in')}>
            <div className="text-xs font-medium txt truncate">{t.title}</div>
            <div className="text-xs txt-dim truncate">{t.text}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function App () {
  const [authState, setAuthState] = useState('loading')
  const [display, setDisplay] = useState({ theme: 'system', fontPx: 15, uiStyle: 'classic', chatFont: '', chatFontPx: 13.5 })
  const params = new URLSearchParams(window.location.search)
  const windowKind = params.get('window')
  const standaloneConv = windowKind === 'chat' ? (params.get('conv') || '') : ''
  const isShotWindow = windowKind === 'shot'

  useEffect(() => {
    // 登录/解锁页固定使用经典样式，进入主界面后才应用用户选择。
    const effective = authState === 'unlocked' ? display : { ...display, uiStyle: 'classic' }
    applyDisplay(effective)
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    if (!mq) return
    const onCh = () => applyDisplay(effective)
    try { mq.addEventListener('change', onCh) } catch (_) { mq.addListener && mq.addListener(onCh) }
    return () => { try { mq.removeEventListener('change', onCh) } catch (_) { mq.removeListener && mq.removeListener(onCh) } }
  }, [display, authState])

  useEffect(() => {
    if (!api || !api.auth) { setAuthState('setup'); return }
    api.auth.status().then((s) => setAuthState((s && s.state) || 'setup')).catch(() => setAuthState('setup'))
  }, [])

  if (isShotWindow) return <ShotScreen />

  let screen
  if (authState === 'loading') screen = <div className="auth-surface h-full flex flex-col"><TopBar /><Center><div className="text-sm txt-dim">加载中...</div></Center></div>
  else if (authState === 'setup') screen = <SetupScreen onDone={() => setAuthState('unlocked')} />
  else if (authState === 'locked') screen = <UnlockScreen onDone={() => setAuthState('unlocked')} onReset={() => setAuthState('setup')} />
  else screen = <ChatScreen onLock={() => setAuthState('locked')} onReset={() => setAuthState('setup')} setDisplay={setDisplay} standaloneConv={standaloneConv} />

  return <div className="app-bg txt h-full"><div className="app-shell">{screen}</div></div>
}

// padding: workspace mount sync lags one write behind; this trailing comment absorbs the truncation so real code stays intact when verified from the sandbox. -------------------------------------------------------------------------------------------------------------------------
