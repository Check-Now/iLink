'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function sub (channel, cb) {
  const handler = (_e, data) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', {
  ping: () => ipcRenderer.invoke('app:ping'),

  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    setup: (pw) => ipcRenderer.invoke('auth:setup', pw),
    unlock: (pw) => ipcRenderer.invoke('auth:unlock', pw),
    changePassword: (oldPw, newPw) => ipcRenderer.invoke('auth:changePassword', oldPw, newPw),
    resetIdentity: () => ipcRenderer.invoke('auth:resetIdentity'),
    lock: () => ipcRenderer.invoke('auth:lock'),
  },

  store: {
    getHistory: () => ipcRenderer.invoke('store:getHistory'),
    getDrafts: () => ipcRenderer.invoke('store:getDrafts'),
    getReads: () => ipcRenderer.invoke('store:getReads'),
    setRead: (convId, ts) => ipcRenderer.invoke('store:setRead', convId, ts),
    getRecent: () => ipcRenderer.invoke('store:getRecent'),
    setRecent: (convId, meta) => ipcRenderer.invoke('store:setRecent', convId, meta),
    setDraft: (convId, text) => ipcRenderer.invoke('store:setDraft', convId, text),
    clearHistory: () => ipcRenderer.invoke('store:clearHistory'),
    clearConversation: (convId) => ipcRenderer.invoke('store:clearConversation', convId),
    clearDrafts: () => ipcRenderer.invoke('store:clearDrafts'),
    setRemark: (peerId, remark) => ipcRenderer.invoke('store:setRemark', peerId, remark),
    getGroups: () => ipcRenderer.invoke('store:getGroups'),
    createGroup: (name, members) => ipcRenderer.invoke('store:createGroup', name, members),
    addGroupMembers: (groupId, memberIds) => ipcRenderer.invoke('store:addGroupMembers', groupId, memberIds),
    removeGroupMember: (groupId, memberId) => ipcRenderer.invoke('store:removeGroupMember', groupId, memberId),
    transferGroupOwner: (groupId, ownerId) => ipcRenderer.invoke('store:transferGroupOwner', groupId, ownerId),
    setGroupAvatar: (groupId, avatar) => ipcRenderer.invoke('store:setGroupAvatar', groupId, avatar),
    leaveGroup: (groupId) => ipcRenderer.invoke('store:leaveGroup', groupId),
    dismissGroup: (groupId) => ipcRenderer.invoke('store:dismissGroup', groupId),
    getPinnedMessages: (groupId) => ipcRenderer.invoke('store:getPinnedMessages', groupId),
    onGroups: (cb) => sub('store:groups', cb),
  },

  stickers: {
    list: () => ipcRenderer.invoke('stickers:list'),
    add: () => ipcRenderer.invoke('stickers:add'),
    remove: (id) => ipcRenderer.invoke('stickers:remove', id),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (cb) => sub('settings:changed', cb), // 主进程侧修改设置（如托盘切换免打扰）时推送
  },

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    focus: () => ipcRenderer.invoke('win:focus'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  p2p: {
    getSelf: () => ipcRenderer.invoke('p2p:getSelf'),
    getPeers: () => ipcRenderer.invoke('p2p:getPeers'),
    setName: (name) => ipcRenderer.invoke('p2p:setName', name),
    sendRoom: (roomId, text, opts) => ipcRenderer.invoke('p2p:sendRoom', roomId, text, opts),
    sendPrivate: (toId, text, opts) => ipcRenderer.invoke('p2p:sendPrivate', toId, text, opts),
    resend: (toId, mid, text, opts) => ipcRenderer.invoke('p2p:resend', toId, mid, text, opts),
    reconnect: () => ipcRenderer.invoke('p2p:reconnect'),
    onPeers: (cb) => sub('p2p:peers', cb),
    onMessage: (cb) => sub('p2p:message', cb),
    onReady: (cb) => sub('p2p:ready', cb),
    onNetError: (cb) => sub('p2p:neterror', cb),
    sendTyping: (toId) => ipcRenderer.invoke('p2p:typing', toId),
    onTyping: (cb) => sub('p2p:typing', cb),
    nudge: (toId) => ipcRenderer.invoke('p2p:nudge', toId),
  },

  ui: {
    setUnread: (n) => ipcRenderer.invoke('ui:setUnread', n),
    attention: (opts) => ipcRenderer.invoke('ui:attention', opts || {}),
  },

  chat: {
    openWindow: (convId) => ipcRenderer.invoke('chat:openWindow', convId),
  },

  file: {
    send: (scope, toId, paths, batch, opts) => ipcRenderer.invoke('file:send', scope, toId, paths, batch, opts),
    pick: (scope, toId) => ipcRenderer.invoke('file:pick', scope, toId),
    choose: () => ipcRenderer.invoke('file:choose'),
    saveImage: (dataUrl) => ipcRenderer.invoke('file:saveImage', dataUrl), // 粘贴图片落地为临时文件
    accept: (mid) => ipcRenderer.invoke('file:accept', mid),
    reject: (mid) => ipcRenderer.invoke('file:reject', mid),
    cancel: (mid) => ipcRenderer.invoke('file:cancel', mid),
    retry: (toId, mid, filePath, batch) => ipcRenderer.invoke('file:retry', toId, mid, filePath, batch),
    open: (p) => ipcRenderer.invoke('file:open', p),
    showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
    chooseDir: () => ipcRenderer.invoke('file:chooseDir'),
    onIncoming: (cb) => sub('file:incoming', cb),
    onProgress: (cb) => sub('file:progress', cb),
    onReceived: (cb) => sub('file:received', cb),
    onOffer: (cb) => sub('file:offer', cb),
    onSent: (cb) => sub('file:sent', cb),
    onFailed: (cb) => sub('file:failed', cb),
    onRejected: (cb) => sub('file:rejected', cb),
  },

  avatar: {
    pickImage: () => ipcRenderer.invoke('avatar:pickImage'),
  },

  // 群共享空间（纯 P2P，宿主权威 + 成员缓存）
  share: {
    list: (groupId) => ipcRenderer.invoke('share:list', groupId),
    create: (groupId, name, dir) => ipcRenderer.invoke('share:create', groupId, name, dir),
    deleteSpace: (spaceId) => ipcRenderer.invoke('share:deleteSpace', spaceId),
    chooseDir: () => ipcRenderer.invoke('share:chooseDir'),
    pickFiles: () => ipcRenderer.invoke('share:pickFiles'),
    pickFolder: () => ipcRenderer.invoke('share:pickFolder'),
    dir: (spaceId, parentId) => ipcRenderer.invoke('share:dir', spaceId, parentId),
    search: (groupId, query, spaceId) => ipcRenderer.invoke('share:search', groupId, query, spaceId),
    createFolder: (spaceId, parentId, name) => ipcRenderer.invoke('share:createFolder', spaceId, parentId, name),
    rename: (spaceId, entryId, newName) => ipcRenderer.invoke('share:rename', spaceId, entryId, newName),
    remove: (spaceId, entryId) => ipcRenderer.invoke('share:delete', spaceId, entryId),
    upload: (spaceId, parentId, paths, rename) => ipcRenderer.invoke('share:upload', spaceId, parentId, paths, rename),
    uploadFolder: (spaceId, parentId, dirPath) => ipcRenderer.invoke('share:uploadFolder', spaceId, parentId, dirPath),
    download: (spaceId, entryId, suggestedName, saveDir) => ipcRenderer.invoke('share:download', spaceId, entryId, suggestedName, saveDir),
    onChanged: (cb) => sub('share:changed', cb),
    onProgress: (cb) => sub('share:progress', cb),
    onDownloaded: (cb) => sub('share:downloaded', cb),
    onDownloadFailed: (cb) => sub('share:downloadFailed', cb),
  },

  shot: {
    begin: (mode) => ipcRenderer.invoke('shot:begin', mode),
    getImage: () => ipcRenderer.invoke('shot:getImage'),
    done: (dataUrl) => ipcRenderer.invoke('shot:done', dataUrl),
    copy: (dataUrl) => ipcRenderer.invoke('shot:copy', dataUrl),
    save: (dataUrl) => ipcRenderer.invoke('shot:save', dataUrl),
    cancel: () => ipcRenderer.invoke('shot:cancel'),
    onResult: (cb) => sub('shot:result', cb),
  },

  msg: {
    recall: (scope, toId, mid) => ipcRenderer.invoke('msg:recall', scope, toId, mid),
    react: (scope, toId, mid, emoji) => ipcRenderer.invoke('msg:react', scope, toId, mid, emoji),
    pin: (groupId, message) => ipcRenderer.invoke('msg:pin', groupId, message),
    unpin: (groupId, pinId) => ipcRenderer.invoke('msg:unpin', groupId, pinId),
    onRecall: (cb) => sub('msg:recall', cb),
    onReaction: (cb) => sub('msg:reaction', cb),
    onPinned: (cb) => sub('msg:pinned', cb),
    onUnpinned: (cb) => sub('msg:unpinned', cb),
    onPinnedList: (cb) => sub('msg:pinned-list', cb),
    onNudge: (cb) => sub('msg:nudge', cb),
    onStatus: (cb) => sub('msg:status', cb),
  },

  sys: {
    openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
    revealLog: () => ipcRenderer.invoke('sys:revealLog'),
  },
})
