use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use uuid::Uuid;

// ============ P2P 核心数据结构 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Peer {
    id: String,
    nickname: String,
    ip: String,
    port: u16,
    last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct P2PMessage {
    from_id: String,
    from_name: String,
    text: String,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiscoveryPacket {
    kind: String, // "announce" | "response"
    id: String,
    nickname: String,
    tcp_port: u16,
}

struct P2PState {
    my_id: String,
    my_nickname: String,
    tcp_port: u16,
    peers: HashMap<String, Peer>,
    messages: HashMap<String, Vec<P2PMessage>>,
    running: bool,
}

type SharedState = Arc<Mutex<P2PState>>;

const DISCOVERY_PORT: u16 = 37020;
const TCP_PORT_RANGE_START: u16 = 37021;
const TCP_PORT_RANGE_END: u16 = 37099;
const BROADCAST_INTERVAL_SECS: u64 = 5;

// ============ UDP 广播发现（对讲机核心）============
// 原理：像对讲机一样，每个设备在局域网内广播自己的存在，
// 其他设备收到后直接建立 TCP 直连，无需任何服务器。

fn start_udp_discovery(state: SharedState, app: tauri::AppHandle) {
    let state_clone = state.clone();
    let app_clone = app.clone();

    // UDP 广播发送线程
    std::thread::spawn(move || {
        let socket = UdpSocket::bind("0.0.0.0:0").expect("无法绑定 UDP 发送端口");
        socket.set_broadcast(true).expect("无法启用广播");
        socket
            .set_read_timeout(Some(Duration::from_secs(1)))
            .ok();

        loop {
            let (my_id, nickname, tcp_port, running) = {
                let s = state_clone.lock().unwrap();
                if !s.running {
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
                (s.my_id.clone(), s.my_nickname.clone(), s.tcp_port, s.running)
            };

            if !running {
                break;
            }

            // 广播自己的存在
            let packet = DiscoveryPacket {
                kind: "announce".to_string(),
                id: my_id.clone(),
                nickname: nickname.clone(),
                tcp_port,
            };
            if let Ok(data) = serde_json::to_vec(&packet) {
                socket
                    .send_to(&data, format!("255.255.255.255:{}", DISCOVERY_PORT))
                    .ok();
            }

            std::thread::sleep(Duration::from_secs(BROADCAST_INTERVAL_SECS));
        }
    });

    // UDP 广播接收线程
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(format!("0.0.0.0:{}", DISCOVERY_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("UDP 发现端口绑定失败: {} (可能已有实例运行)", e);
                return;
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .ok();

        let mut buf = [0u8; 1024];
        loop {
            match socket.recv_from(&mut buf) {
                Ok((size, addr)) => {
                    if let Ok(packet) = serde_json::from_slice::<DiscoveryPacket>(&buf[..size]) {
                        let (my_id, running) = {
                            let s = state.lock().unwrap();
                            (s.my_id.clone(), s.running)
                        };

                        if !running {
                            break;
                        }

                        // 忽略自己的广播
                        if packet.id == my_id {
                            continue;
                        }

                        let peer = Peer {
                            id: packet.id.clone(),
                            nickname: packet.nickname.clone(),
                            ip: addr.ip().to_string(),
                            port: packet.tcp_port,
                            last_seen: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_secs(),
                        };

                        // 更新对端列表
                        let is_new = {
                            let mut s = state.lock().unwrap();
                            let is_new = !s.peers.contains_key(&packet.id);
                            s.peers.insert(packet.id.clone(), peer.clone());
                            is_new
                        };

                        // 通知前端有新设备发现
                        if is_new {
                            app_clone
                                .emit("peer-discovered", serde_json::to_string(&peer).unwrap())
                                .ok();
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            }
        }
    });
}

// ============ TCP 直连通信（无服务器）============

fn start_tcp_listener(state: SharedState, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let tcp_port = {
            let s = state.lock().unwrap();
            s.tcp_port
        };

        let listener = match TcpListener::bind(format!("0.0.0.0:{}", tcp_port)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("TCP 监听端口 {} 绑定失败: {}", tcp_port, e);
                return;
            }
        };
        listener.set_nonblocking(false).ok();

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let state = state.clone();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        handle_incoming_connection(stream, state, app);
                    });
                }
                Err(e) => {
                    eprintln!("TCP 连接错误: {}", e);
                }
            }
        }
    });
}

fn handle_incoming_connection(stream: TcpStream, state: SharedState, app: tauri::AppHandle) {
    let peer_addr = match stream.peer_addr() {
        Ok(addr) => addr.to_string(),
        Err(_) => return,
    };

    let reader = BufReader::new(
        stream
            .try_clone()
            .expect("无法克隆 TCP 流"),
    );

    for line in reader.lines() {
        match line {
            Ok(msg_str) => {
                if let Ok(msg) = serde_json::from_str::<P2PMessage>(&msg_str) {
                    // 存储消息
                    {
                        let mut s = state.lock().unwrap();
                        s.messages
                            .entry(msg.from_id.clone())
                            .or_insert_with(Vec::new)
                            .push(msg.clone());
                    }

                    // 通知前端
                    app.emit("message-received", serde_json::to_string(&msg).unwrap())
                        .ok();
                }
            }
            Err(_) => break,
        }
    }
}

// ============ Tauri 命令 ============

#[tauri::command]
fn get_device_info() -> String {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    // 获取本地 IP
    let local_ip = get_local_ip();

    format!(
        "{{\"hostname\": \"{}\", \"platform\": \"linux\", \"ip\": \"{}\"}}",
        hostname, local_ip
    )
}

#[tauri::command]
fn get_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    ts.to_string()
}

#[tauri::command]
fn start_p2p_service(state: tauri::State<'_, SharedState>, app: tauri::AppHandle, nickname: String) -> String {
    let (my_id, tcp_port) = {
        let mut s = state.lock().unwrap();
        s.my_nickname = nickname.clone();
        s.running = true;
        (s.my_id.clone(), s.tcp_port)
    };

    // 启动 TCP 监听（接收消息）
    start_tcp_listener(state.inner().clone(), app.clone());

    // 启动 UDP 广播发现（发现局域网内的其他设备）
    start_udp_discovery(state.inner().clone(), app.clone());

    format!(
        "{{\"status\": \"started\", \"device_id\": \"{}\", \"tcp_port\": {}}}",
        my_id, tcp_port
    )
}

#[tauri::command]
fn discover_peers(state: tauri::State<'_, SharedState>) -> String {
    let s = state.lock().unwrap();
    let peers: Vec<&Peer> = s.peers.values().collect();
    serde_json::to_string(&peers).unwrap_or_else(|_| "[]".to_string())
}

#[tauri::command]
fn send_p2p_message(state: tauri::State<'_, SharedState>, target_id: String, text: String) -> String {
    let (target_ip, target_port, my_id, my_nickname) = {
        let s = state.lock().unwrap();
        match s.peers.get(&target_id) {
            Some(peer) => (
                peer.ip.clone(),
                peer.port,
                s.my_id.clone(),
                s.my_nickname.clone(),
            ),
            None => return "{\"error\": \"设备未找到，请确认对方在线\"}".to_string(),
        }
    };

    let msg = P2PMessage {
        from_id: my_id.clone(),
        from_name: my_nickname.clone(),
        text: text.clone(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
    };

    // 存储本地消息
    {
        let mut s = state.lock().unwrap();
        s.messages
            .entry(target_id.clone())
            .or_insert_with(Vec::new)
            .push(msg.clone());
    }

    // TCP 直连发送（无服务器中转）
    let addr = format!("{}:{}", target_ip, target_port);
    match TcpStream::connect_timeout(
        &addr.parse().unwrap(),
        Duration::from_secs(5),
    ) {
        Ok(mut stream) => {
            if let Ok(data) = serde_json::to_string(&msg) {
                if stream.write_all(format!("{}\n", data).as_bytes()).is_ok() {
                    "{\"status\": \"sent\"}".to_string()
                } else {
                    "{\"error\": \"发送失败\"}".to_string()
                }
            } else {
                "{\"error\": \"消息序列化失败\"}".to_string()
            }
        }
        Err(e) => {
            format!("{{\"error\": \"无法连接对方设备: {}\"}}", e)
        }
    }
}

#[tauri::command]
fn get_messages(state: tauri::State<'_, SharedState>, peer_id: String) -> String {
    let s = state.lock().unwrap();
    match s.messages.get(&peer_id) {
        Some(msgs) => serde_json::to_string(msgs).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    }
}

#[tauri::command]
fn set_nickname(state: tauri::State<'_, SharedState>, nickname: String) -> String {
    let mut s = state.lock().unwrap();
    s.my_nickname = nickname.clone();
    format!("{{\"nickname\": \"{}\"}}", nickname)
}

// ============ 天地图瓦片代理（解决服务端Key权限问题）============
// 服务端类型的Key在浏览器/WebView中会被403拒绝（因为浏览器自动发送Referer/Origin头）
// 通过后端代理请求，不发送Referer/Origin头，绕过这个限制

#[tauri::command]
fn fetch_tile(layer: String, x: u32, y: u32, z: u32) -> String {
    let tianditu_key = std::env::var("TIANDITU_KEY").unwrap_or_default();
    let server = x % 8; // t0-t7 轮询
    
    let url = format!(
        "http://t{}.tianditu.gov.cn/DataServer?T={}&X={}&Y={}&L={}&tk={}",
        server, layer, x, y, z, tianditu_key
    );
    
    // 使用 reqwest blocking client，不设置 Referer/Origin 头
    // User-Agent 不能包含 "Mozilla"，否则天地图会返回 403（服务端Key限制）
    let client = reqwest::blocking::Client::builder()
        .user_agent("TiandituClient/1.0")
        .build();
    
    match client {
        Ok(client) => {
            match client.get(&url).send() {
                Ok(response) => {
                    let status = response.status().as_u16();
                    match response.bytes() {
                        Ok(bytes) => {
                            let b64 = base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                &bytes
                            );
                            format!(
                                "{{\"status\":{},\"size\":{},\"data\":\"{}\"}}",
                                status,
                                bytes.len(),
                                b64
                            )
                        }
                        Err(e) => format!("{{\"error\":\"读取响应失败: {}\"}}", e),
                    }
                }
                Err(e) => format!("{{\"error\":\"请求失败: {}\"}}", e),
            }
        }
        Err(e) => format!("{{\"error\":\"创建HTTP客户端失败: {}\"}}", e),
    }
}

// ============ 动态端口分配 ============

fn find_available_tcp_port() -> u16 {
    for port in TCP_PORT_RANGE_START..=TCP_PORT_RANGE_END {
        if TcpListener::bind(format!("0.0.0.0:{}", port)).is_ok() {
            return port;
        }
    }
    // 如果范围内都占用了，让系统分配
    TcpListener::bind("0.0.0.0:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(TCP_PORT_RANGE_START)
}

// ============ 工具函数 ============

fn get_local_ip() -> String {
    // 通过 UDP 连接获取本地出口 IP（不实际发送数据）
    match UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    return addr.ip().to_string();
                }
            }
        }
        Err(_) => {}
    }
    "127.0.0.1".to_string()
}

// ============ 应用入口 ============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let my_id = Uuid::new_v4().to_string();

    let state = Arc::new(Mutex::new(P2PState {
        my_id,
        my_nickname: String::new(),
        tcp_port: find_available_tcp_port(),
        peers: HashMap::new(),
        messages: HashMap::new(),
        running: false,
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_device_info,
            get_timestamp,
            start_p2p_service,
            discover_peers,
            send_p2p_message,
            get_messages,
            set_nickname,
            fetch_tile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
