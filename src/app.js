// 浅蓝微聊 - 前端逻辑（真P2P，对讲机模式，无服务器）
const { invoke } = window.__TAURI__?.core || {};
const { listen } = window.__TAURI__?.event || {};

// ============ 本地身份（无账户，自由昵称 + 设备指纹）============
function loadIdentity() {
    const saved = localStorage.getItem('lightblue_identity');
    if (saved) {
        try { return JSON.parse(saved); } catch { /* 损坏则重新创建 */ }
    }
    return null;
}

function saveIdentity(identity) {
    localStorage.setItem('lightblue_identity', JSON.stringify(identity));
}

function generateDeviceId() {
    let id = localStorage.getItem('lightblue_device_id');
    if (!id) {
        id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('lightblue_device_id', id);
    }
    return id;
}

// ============ 数据模型 ============
const state = {
    currentTab: 'chat',
    currentChat: null,
    identity: loadIdentity(),
    deviceId: generateDeviceId(),
    p2pStarted: false,
    contacts: [],        // 动态发现的对端设备
    conversations: {},   // 动态消息记录
    unread: {}
};

// ============ 首次启动：昵称设置引导 ============
function showNicknameSetup() {
    const overlay = document.createElement('div');
    overlay.className = 'nickname-setup-overlay';
    overlay.innerHTML = `
        <div class="nickname-setup-card">
            <div class="setup-icon">📻</div>
            <h2>浅蓝微聊</h2>
            <p class="setup-desc">对讲机模式 · 无需服务器 · 局域网直连</p>
            <input type="text" id="setup-nickname" class="setup-input"
                   placeholder="想叫什么就叫什么" maxlength="20" autocomplete="off">
            <button class="setup-btn" id="setup-confirm">开始聊天</button>
            <p class="setup-hint">名字随时可以改，不绑定任何账户</p>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#setup-nickname');
    const btn = overlay.querySelector('#setup-confirm');
    input.focus();

    function confirm() {
        const name = input.value.trim();
        if (!name) {
            input.classList.add('shake');
            setTimeout(() => input.classList.remove('shake'), 500);
            return;
        }
        state.identity = {
            nickname: name,
            avatar: name.charAt(0),
            createdAt: new Date().toISOString()
        };
        saveIdentity(state.identity);
        overlay.remove();
        applyIdentity();
        startP2P();
    }

    btn.addEventListener('click', confirm);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm();
    });
}

function applyIdentity() {
    if (!state.identity) return;
    const nicknameEl = document.getElementById('my-nickname');
    const avatarEl = document.getElementById('my-avatar');
    const deviceIdEl = document.getElementById('my-device-id');

    if (nicknameEl) nicknameEl.textContent = state.identity.nickname;
    if (avatarEl) avatarEl.textContent = state.identity.avatar;
    if (deviceIdEl) deviceIdEl.textContent = `设备: ${state.deviceId.slice(0, 16)}...`;
}

// ============ P2P 服务启动（对讲机开机）============
async function startP2P() {
    if (state.p2pStarted || !invoke) return;

    try {
        const nickname = state.identity?.nickname || '匿名';
        const result = await invoke('start_p2p_service', { nickname });
        const data = JSON.parse(result);
        state.p2pStarted = true;

        console.log(`P2P 服务已启动，设备ID: ${data.device_id}`);

        // 监听新设备发现事件
        await listen('peer-discovered', (event) => {
            const peer = JSON.parse(event.payload);
            addPeer(peer);
        });

        // 监听新消息事件
        await listen('message-received', (event) => {
            const msg = JSON.parse(event.payload);
            receiveMessage(msg);
        });

        // 定期刷新对端列表
        setInterval(refreshPeers, 3000);
    } catch (e) {
        console.error('P2P 启动失败:', e);
    }
}

// ============ 设备发现与联系人管理 ============
async function refreshPeers() {
    if (!invoke || !state.p2pStarted) return;

    try {
        const result = await invoke('discover_peers');
        const peers = JSON.parse(result);

        peers.forEach(peer => {
            if (!state.contacts.find(c => c.id === peer.id)) {
                addPeer(peer);
            }
        });
    } catch (e) {
        // 静默处理
    }
}

function addPeer(peer) {
    // 避免重复添加
    if (state.contacts.find(c => c.id === peer.id)) return;

    const contact = {
        id: peer.id,
        name: peer.nickname,
        avatar: peer.nickname.charAt(0),
        status: 'online',
        ip: peer.ip,
        port: peer.port
    };

    state.contacts.push(contact);
    if (!state.conversations[peer.id]) {
        state.conversations[peer.id] = [];
    }
    state.unread[peer.id] = state.unread[peer.id] || 0;

    renderChatList();
    renderContactList();
}

// ============ 消息接收 ============
function receiveMessage(msg) {
    const peerId = msg.from_id;

    // 确保联系人存在
    if (!state.contacts.find(c => c.id === peerId)) {
        addPeer({
            id: peerId,
            nickname: msg.from_name,
            ip: 'unknown',
            port: 0
        });
    }

    if (!state.conversations[peerId]) {
        state.conversations[peerId] = [];
    }

    const now = new Date(msg.timestamp || Date.now());
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    state.conversations[peerId].push({
        from: 'other',
        text: msg.text,
        time: time,
        fromName: msg.from_name
    });

    // 如果不在当前会话，增加未读数
    if (state.currentChat !== peerId) {
        state.unread[peerId] = (state.unread[peerId] || 0) + 1;
        renderChatList();
    } else {
        renderMessages();
    }
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    renderChatList();
    renderContactList();
    initDeviceInfo();
    initMessaging();

    if (!state.identity) {
        showNicknameSetup();
    } else {
        applyIdentity();
        startP2P();
    }

    // 昵称编辑（点击即可修改）
    document.getElementById('my-nickname')?.addEventListener('click', () => {
        const el = document.getElementById('my-nickname');
        const current = state.identity?.nickname || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current;
        input.className = 'nickname-edit-input';
        input.maxLength = 20;

        async function save() {
            const newName = input.value.trim();
            if (newName && state.identity) {
                state.identity.nickname = newName;
                state.identity.avatar = newName.charAt(0);
                saveIdentity(state.identity);
                // 同步到 P2P 网络
                if (invoke) {
                    await invoke('set_nickname', { nickname: newName }).catch(() => {});
                }
            }
            applyIdentity();
            input.replaceWith(el);
        }

        el.replaceWith(input);
        input.focus();
        input.select();
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
        });
    });
});

// ============ Tauri 桥接 ============
async function initDeviceInfo() {
    try {
        if (invoke) {
            const info = await invoke('get_device_info');
            const data = JSON.parse(info);
            const el = document.getElementById('my-device-id');
            if (el) {
                el.textContent = `设备: ${data.hostname} (${data.ip})`;
            }
        }
    } catch (e) {
        const el = document.getElementById('my-device-id');
        if (el) el.textContent = '设备: 本地模式';
    }
}

// ============ 标签切换 ============
function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            if (target === state.currentTab) return;

            document.getElementById('page-conversation').classList.remove('active');
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(`page-${target}`).classList.add('active');

            const titles = { chat: '浅蓝微聊', contacts: '通讯录', discover: '发现', profile: '我' };
            document.getElementById('current-title').textContent = titles[target];
            state.currentTab = target;
        });
    });
}

// ============ 聊天列表 ============
function renderChatList() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    list.innerHTML = '';

    const chatIds = Object.keys(state.conversations);
    if (chatIds.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <span class="icon">📻</span>
                <span class="text">${state.p2pStarted ? '正在扫描局域网设备...' : '正在启动P2P服务...'}</span>
            </div>`;
        return;
    }

    // 按最近消息排序
    chatIds.sort((a, b) => {
        const msgsA = state.conversations[a] || [];
        const msgsB = state.conversations[b] || [];
        return (msgsB.length > 0 ? 1 : 0) - (msgsA.length > 0 ? 1 : 0);
    });

    chatIds.forEach(id => {
        const contact = state.contacts.find(c => c.id === id);
        if (!contact) return;

        const msgs = state.conversations[id] || [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        const unread = state.unread[id] || 0;

        const item = document.createElement('div');
        item.className = 'chat-item';
        item.innerHTML = `
            <div class="avatar">${contact.avatar}</div>
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(contact.name)}</div>
                <div class="chat-last">${lastMsg ? escapeHtml(lastMsg.text) : '等待连接...'}</div>
            </div>
            ${lastMsg ? `<span class="chat-time">${lastMsg.time}</span>` : ''}
            ${unread > 0 ? `<span class="chat-badge">${unread}</span>` : ''}
        `;
        item.addEventListener('click', () => openConversation(id));
        list.appendChild(item);
    });
}

// ============ 联系人列表 ============
function renderContactList() {
    const list = document.getElementById('contact-list');
    if (!list) return;
    list.innerHTML = '';

    if (state.contacts.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <span class="icon">📡</span>
                <span class="text">正在发现附近的设备...</span>
            </div>`;
        return;
    }

    state.contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'chat-item';
        item.innerHTML = `
            <div class="avatar">${contact.avatar}</div>
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(contact.name)}</div>
                <div class="chat-last" style="color: ${contact.status === 'online' ? '#07c160' : '#999'}">
                    ${contact.status === 'online' ? '在线 · 直连' : '离线'}
                </div>
            </div>
        `;
        item.addEventListener('click', () => openConversation(contact.id));
        list.appendChild(item);
    });
}

// ============ 打开会话 ============
function openConversation(contactId) {
    const contact = state.contacts.find(c => c.id === contactId);
    if (!contact) return;

    state.currentChat = contactId;
    document.getElementById('conv-title').textContent = contact.name;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-conversation').classList.add('active');

    // 加载历史消息
    loadMessages(contactId);
    clearUnread(contactId);
}

async function loadMessages(peerId) {
    if (invoke && state.p2pStarted) {
        try {
            const result = await invoke('get_messages', { peerId });
            const msgs = JSON.parse(result);
            if (msgs.length > 0 && (!state.conversations[peerId] || state.conversations[peerId].length === 0)) {
                state.conversations[peerId] = msgs.map(m => ({
                    from: m.from_id === state.deviceId ? 'self' : 'other',
                    text: m.text,
                    time: new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                    fromName: m.from_name
                }));
            }
        } catch (e) {
            // 静默处理
        }
    }
    renderMessages();
}

// ============ 渲染消息 ============
function renderMessages() {
    const container = document.getElementById('messages');
    if (!container) return;
    container.innerHTML = '';

    const msgs = state.conversations[state.currentChat] || [];
    let lastTime = '';

    msgs.forEach(msg => {
        if (msg.time !== lastTime) {
            const timeEl = document.createElement('div');
            timeEl.className = 'msg-time';
            timeEl.textContent = msg.time;
            container.appendChild(timeEl);
            lastTime = msg.time;
        }

        const row = document.createElement('div');
        row.className = `msg-row ${msg.from}`;

        if (msg.from === 'other' && msg.fromName) {
            row.innerHTML = `<div class="msg-bubble"><div class="msg-sender">${escapeHtml(msg.fromName)}</div>${escapeHtml(msg.text)}</div>`;
        } else {
            row.innerHTML = `<div class="msg-bubble">${escapeHtml(msg.text)}</div>`;
        }
        container.appendChild(row);
    });

    container.scrollTop = container.scrollHeight;
}

// ============ 发送消息（TCP直连，无服务器）============
function initMessaging() {
    const input = document.getElementById('msg-input');
    const sendBtn = document.getElementById('btn-send');
    const backBtn = document.getElementById('btn-back');

    sendBtn.addEventListener('click', () => sendMessage());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    backBtn.addEventListener('click', () => {
        document.getElementById('page-conversation').classList.remove('active');
        document.getElementById(`page-${state.currentTab}`).classList.add('active');
        state.currentChat = null;
        renderChatList();
    });
}

async function sendMessage() {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text || !state.currentChat) return;

    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // 本地显示
    if (!state.conversations[state.currentChat]) {
        state.conversations[state.currentChat] = [];
    }
    state.conversations[state.currentChat].push({ from: 'self', text, time });
    input.value = '';
    renderMessages();

    // P2P 直连发送
    if (invoke && state.p2pStarted) {
        try {
            const result = await invoke('send_p2p_message', {
                targetId: state.currentChat,
                text: text
            });
            const data = JSON.parse(result);
            if (data.error) {
                // 发送失败，显示错误提示
                state.conversations[state.currentChat].push({
                    from: 'system',
                    text: `⚠️ ${data.error}`,
                    time
                });
                renderMessages();
            }
        } catch (e) {
            state.conversations[state.currentChat].push({
                from: 'system',
                text: `⚠️ 发送失败: P2P服务未就绪`,
                time
            });
            renderMessages();
        }
    }
}

// ============ 工具函数 ============
function clearUnread(contactId) {
    state.unread[contactId] = 0;
    renderChatList();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
