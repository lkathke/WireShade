#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;
extern crate log;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::str::FromStr;
use tokio::sync::{mpsc, oneshot};
use tokio::net::UdpSocket;
use smoltcp::iface::{Interface, SocketSet, Config, SocketStorage, Route};
use smoltcp::socket::tcp;
use smoltcp::wire::{IpAddress, Ipv4Address, IpCidr, IpProtocol, Ipv4Packet};
use smoltcp::time::Instant;
use smoltcp::phy::{Device, Medium, RxToken, TxToken};
use boringtun::noise::{Tunn, TunnResult};
use base64::{Engine as _, engine::general_purpose};
use std::io::Write;

// --- Command Enum ---
enum NetworkCommand {
    Connect {
        dest_ip: Ipv4Address,
        dest_port: u16,
        on_data: ThreadsafeFunction<Buffer>,
        on_close: ThreadsafeFunction<()>,
        resp: oneshot::Sender<Result<u32>>,
    },
    SendData {
        connection_id: u32,
        data: Vec<u8>,
    },
    Close {
        connection_id: u32,
    },
    Listen {
        port: u16,
        on_connection: ThreadsafeFunction<(u32, String, u16)>, // Returns (conn_id, remote_ip, remote_port)
        // We reuse the same on_data/on_close logic, but we need to store these callbacks for the listener
        // so we can attach them to new server connections.
        on_data: ThreadsafeFunction<(u32, Buffer)>, // (conn_id, data) - Note we need conn_id here to mux!
        on_close: ThreadsafeFunction<u32>, // (conn_id)
        resp: oneshot::Sender<Result<()>>,
    },
}

// Struct to store listener callback info
struct ListenerInfo {
    port: u16,
    on_connection: ThreadsafeFunction<(u32, String, u16)>,
    on_data: ThreadsafeFunction<(u32, Buffer)>,
    on_close: ThreadsafeFunction<u32>,
}

enum ConnectionContext {
    Client {
        on_data: ThreadsafeFunction<Buffer>,
        on_close: ThreadsafeFunction<()>,
    },
    Server {
        on_data: ThreadsafeFunction<(u32, Buffer)>,
        on_close: ThreadsafeFunction<u32>,
    }
}

// --- Virtual Device (IP) ---
struct VirtualDevice {
    rx_queue: std::collections::VecDeque<Vec<u8>>,
    tx_queue: std::collections::VecDeque<Vec<u8>>,
    mtu: usize,
}

impl VirtualDevice {
    fn new(mtu: usize) -> Self {
        Self {
            rx_queue: std::collections::VecDeque::new(),
            tx_queue: std::collections::VecDeque::new(),
            mtu,
        }
    }
}

impl Device for VirtualDevice {
    type RxToken<'a> = RxTokenVec;
    type TxToken<'a> = TxTokenVec<'a>;

    fn receive(&mut self, _timestamp: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if let Some(buffer) = self.rx_queue.pop_front() {
            let rx = RxTokenVec { buffer };
            let tx = TxTokenVec { queue: &mut self.tx_queue };
            Some((rx, tx))
        } else {
            None
        }
    }

    fn transmit(&mut self, _timestamp: Instant) -> Option<Self::TxToken<'_>> {
        Some(TxTokenVec { queue: &mut self.tx_queue })
    }

    fn capabilities(&self) -> smoltcp::phy::DeviceCapabilities {
        let mut caps = smoltcp::phy::DeviceCapabilities::default();
        caps.medium = Medium::Ip; 
        caps.max_transmission_unit = self.mtu; 
        
        // Revert to Both: This worked for Handshake!
        // It seems the server accepts our packets even without calculated checksums (or 0),
        // but rejects them if we try to calculate them (maybe incorrectly?).
        // Or maybe Checksum::Rx capability logic in smoltcp is different than assumed.
        caps.checksum.ipv4 = smoltcp::phy::Checksum::Both;
        caps.checksum.tcp = smoltcp::phy::Checksum::Both;
        
        caps
    }
}

struct RxTokenVec {
    buffer: Vec<u8>,
}

impl RxToken for RxTokenVec {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        // Simple IP packet passthrough
        f(&self.buffer)
    }
}

struct TxTokenVec<'a> {
    queue: &'a mut std::collections::VecDeque<Vec<u8>>,
}

impl<'a> TxToken for TxTokenVec<'a> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut buffer = vec![0u8; len];
        let result = f(&mut buffer);
        // Simple IP packet passthrough
        self.queue.push_back(buffer);
        result
    }
}

// --- WireShade ---

#[napi]
pub struct WireShade {
    cmd_tx: mpsc::Sender<NetworkCommand>,
}

#[napi]
impl WireShade {
    #[napi(constructor)]
    pub fn new(
        private_key: String,
        peer_public_key: String,
        preshared_key: Option<String>,
        endpoint: String,
        source_ip: String,
    ) -> Result<Self> {
        let (cmd_tx, mut cmd_rx) = mpsc::channel(32);

        let private_key_bytes = decode_key(&private_key).map_err(|e| Error::from_reason(format!("Invalid private key: {}", e)))?;
        let peer_key_bytes = decode_key(&peer_public_key).map_err(|e| Error::from_reason(format!("Invalid peer key: {}", e)))?;
        let psk_bytes = if let Some(psk) = preshared_key {
            Some(decode_key(&psk).map_err(|e| Error::from_reason(format!("Invalid psk: {}", e)))?)
        } else {
            None
        };

        let source_ip_addr = Ipv4Address::from_str(&source_ip).map_err(|_| Error::from_reason("Invalid source IP"))?;
        
        eprintln!("Resolving endpoint: {}", endpoint);
        let endpoint_addr = endpoint.to_socket_addrs().map_err(|e| Error::from_reason(format!("Invalid endpoint: {}", e)))?
            .next().ok_or_else(|| Error::from_reason("Endpoint did not resolve"))?;
        eprintln!("Resolved to: {}", endpoint_addr);

        tokio::spawn(async move {
            let mut tunn = Tunn::new(
                private_key_bytes.into(),
                peer_key_bytes.into(),
                psk_bytes,
                None, 
                0, 
                None 
            ).expect("Failed to create Tunn");

            let udp_socket = UdpSocket::bind("0.0.0.0:0").await.expect("Failed to bind UDP");
            let local_addr = udp_socket.local_addr().expect("Failed to get local addr");
            udp_socket.connect(endpoint_addr).await.expect("Failed to connect UDP");
            eprintln!("UDP bound to {} and connected to {}", local_addr, endpoint_addr);

            let mut device = VirtualDevice::new(1420); 
            
            let mut socket_set_entries: [SocketStorage; 32] = Default::default();
            let mut socket_set = SocketSet::new(&mut socket_set_entries[..]);
            
            // Configure interface for IP medium - exactly like river
            let mut config = Config::new(smoltcp::wire::HardwareAddress::Ip);
            // Randomize seed for ISN generation
            use std::time::{SystemTime, UNIX_EPOCH};
            config.random_seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64;
            
            // Use /32 with .into() exactly like river does
            let mut iface = Interface::new(config, &mut device, Instant::now());
            iface.update_ip_addrs(|ip_addrs| {
                ip_addrs.push(smoltcp::wire::Ipv4Cidr::new(source_ip_addr, 32).into()).ok();
            });

            // NO routes - exactly like river
            eprintln!("Interface configured: {}/32 (exactly like river)", source_ip_addr);
            let _ = std::io::stderr().flush();

            let mut connections: HashMap<u32, (smoltcp::iface::SocketHandle, ConnectionContext)> = HashMap::new();
            let mut listeners: HashMap<u16, ListenerInfo> = HashMap::new();
            let mut listening_sockets: HashMap<u16, smoltcp::iface::SocketHandle> = HashMap::new();
            // Buffer for pending data when socket can't send yet (e.g., during TCP handshake)
            let mut pending_data: HashMap<u32, Vec<Vec<u8>>> = HashMap::new();
            let mut next_conn_id = 1u32;
            
            // Randomize start port
            let start = SystemTime::now();
            let since_the_epoch = start.duration_since(UNIX_EPOCH).unwrap();
            let mut next_local_port = ((since_the_epoch.as_millis() % 16383) + 49152) as u16; 
            eprintln!("[INIT] Starting with ephemeral port: {}", next_local_port);

            let mut buf = [0u8; 65535]; 
            let mut dst_buf = [0u8; 65535]; 
            
            // CRITICAL: Initiate WireGuard handshake IMMEDIATELY
            eprintln!("[WG] Initiating handshake...");
            let _ = std::io::stderr().flush();
            match tunn.format_handshake_initiation(&mut dst_buf, false) {
                TunnResult::WriteToNetwork(b) => {
                    let res = udp_socket.send(b).await;
                    eprintln!("[WG] Handshake initiation sent ({} bytes). Result: {:?}", b.len(), res);
                }
                other => {
                    eprintln!("[WG] Unexpected handshake init result: {:?}", other);
                }
            }
            let _ = std::io::stderr().flush();
            
            // Wait for handshake response and complete the handshake
            let mut handshake_complete = false;
            let handshake_timeout = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
            
            while !handshake_complete && tokio::time::Instant::now() < handshake_timeout {
                tokio::select! {
                    res = udp_socket.recv(&mut buf) => {
                        if let Ok(len) = res {
                            eprintln!("[WG] Handshake: Received {} bytes", len);
                            match tunn.decapsulate(None, &buf[..len], &mut dst_buf) {
                                TunnResult::WriteToNetwork(b) => {
                                    let res = udp_socket.send(b).await;
                                    eprintln!("[WG] Handshake: Sent reply ({} bytes). Result: {:?}", b.len(), res);
                                    
                                    // After sending, check if more packets need to go out
                                    loop {
                                        let mut extra_buf = [0u8; 65535];
                                        match tunn.decapsulate(None, &[], &mut extra_buf) {
                                            TunnResult::WriteToNetwork(b2) => {
                                                let res2 = udp_socket.send(b2).await;
                                                eprintln!("[WG] Handshake: Follow-up ({} bytes). Result: {:?}", b2.len(), res2);
                                            }
                                            TunnResult::Done => {
                                                eprintln!("[WG] *** HANDSHAKE COMPLETE! ***");
                                                handshake_complete = true;
                                                break;
                                            }
                                            _ => break,
                                        }
                                    }
                                }
                                TunnResult::Done => {
                                    // Check if we can now send data
                                    eprintln!("[WG] Handshake: Done received, testing if session active...");
                                    // Try to encapsulate a small packet to see if session is active
                                    let test_packet = [0u8; 20]; // minimal IP header
                                    match tunn.encapsulate(&test_packet, &mut dst_buf) {
                                        TunnResult::WriteToNetwork(_) => {
                                            eprintln!("[WG] *** SESSION ACTIVE! ***");
                                            handshake_complete = true;
                                        }
                                        _ => {
                                            eprintln!("[WG] Session not yet active, continuing handshake...");
                                        }
                                    }
                                }
                                other => {
                                    eprintln!("[WG] Handshake: Other result: {:?}", other);
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                        // Check timers
                        match tunn.update_timers(&mut dst_buf) {
                            TunnResult::WriteToNetwork(b) => {
                                let res = udp_socket.send(b).await;
                                eprintln!("[WG] Handshake: Timer packet ({} bytes). Result: {:?}", b.len(), res);
                            }
                            _ => {}
                        }
                    }
                }
            }
            
            if !handshake_complete {
                eprintln!("[WG] WARNING: Handshake may not be complete after timeout!");
            }

            let mut heartbeat_timer = tokio::time::interval(tokio::time::Duration::from_secs(5));

            loop {
                let timestamp = Instant::now();
                iface.poll(timestamp, &mut device, &mut socket_set);

                tokio::select! {
                    _ = heartbeat_timer.tick() => {
                        // FORCE HANDSHAKE by sending a dummy packet if no activity
                        // We send a dummy UDP packet to 10.245.1.1:9 (Discard)
                        let mut ip_bytes = vec![0u8; 20 + 8 + 4];
                        let mut ip_packet = Ipv4Packet::new_unchecked(&mut ip_bytes);
                        ip_packet.set_version(4);
                        ip_packet.set_header_len(20);
                        ip_packet.set_total_len(32);
                        ip_packet.set_next_header(IpProtocol::Udp);
                        ip_packet.set_src_addr(source_ip_addr);
                        ip_packet.set_dst_addr(Ipv4Address::new(10, 245, 1, 1));
                        ip_packet.set_hop_limit(64);
                        ip_packet.fill_checksum();

                        match tunn.encapsulate(ip_packet.into_inner(), &mut dst_buf) {
                            TunnResult::WriteToNetwork(b) => {
                                let res = udp_socket.send(b).await;
                                eprintln!("[WG] Periodic heartbeat/handshake trigger sent ({} bytes). UDP Send result: {:?}", b.len(), res);
                                let _ = std::io::stderr().flush();
                            }
                            _ => {}
                        }
                    }
                    cmd_res = cmd_rx.recv() => {
                        if let Some(cmd) = cmd_res {
                             match cmd {
                                NetworkCommand::Connect { dest_ip, dest_port, on_data, on_close, resp } => {
                                    eprintln!("Command Connect to {}:{}", dest_ip, dest_port);

                                    // Debug Routing
                                    eprintln!(" -- Routing Info --");
                                    for c in iface.ip_addrs() {
                                        eprintln!("  IF IP: {:?}", c);
                                    }
                                    let _ = std::io::stderr().flush();

                                    let rx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                    let tx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                    let mut socket = tcp::Socket::new(rx_buffer, tx_buffer);

                                    eprintln!("[CONNECT] Attempting {}:{}", dest_ip, dest_port);
                                    let remote_endpoint = (IpAddress::Ipv4(dest_ip), dest_port);

                                    // Use a real ephemeral port - smoltcp REQUIRES non-zero port!
                                    let local_port = next_local_port;
                                    next_local_port = next_local_port.wrapping_add(1);
                                    if next_local_port < 49152 { next_local_port = 49152; }

                                    let local_endpoint = (IpAddress::Ipv4(source_ip_addr), local_port);

                                    eprintln!("[CONNECT] remote={:?}, local={:?}", remote_endpoint, local_endpoint);
                                    let _ = std::io::stderr().flush();

                                    match socket.connect(iface.context(), remote_endpoint, local_endpoint) {
                                        Ok(_) => {
                                            eprintln!("Connect initiated! Socket state: {:?}", socket.state());

                                            // Add the connected socket to the socket_set
                                            let handle = socket_set.add(socket);

                                            let id = next_conn_id;
                                            next_conn_id += 1;
                                            connections.insert(id, (handle, ConnectionContext::Client { on_data, on_close }));

                                            // CRITICAL: Resolve immediately! 
                                            // JavaScript can start queueing data, and we'll send it when socket is ready
                                            eprintln!("[CONNECT] Resolving promise immediately for connection {}", id);
                                            let _ = resp.send(Ok(id));

                                            iface.poll(Instant::now(), &mut device, &mut socket_set);
                                        }
                                        Err(e) => {
                                            eprintln!("Connect failed: {:?}", e);
                                            // Socket is not in socket_set yet, so no need to remove
                                            let _ = resp.send(Err(Error::from_reason(format!("Connect error: {:?}", e))));
                                        }
                                    }
                                },
                                NetworkCommand::SendData { connection_id, data } => {
                                    eprintln!("[SEND] Sending {} bytes to connection {}", data.len(), connection_id);
                                    if let Some((handle, _)) = connections.get(&connection_id) {
                                        let socket = socket_set.get_mut::<tcp::Socket>(*handle);
                                        eprintln!("[SEND] Socket state: {:?}, can_send: {}", socket.state(), socket.can_send());
                                        if socket.can_send() {
                                            match socket.send_slice(&data) {
                                                Ok(sent) => {
                                                    eprintln!("[SEND] Queued {} bytes in TCP socket", sent);
                                                }
                                                Err(e) => {
                                                    eprintln!("[SEND] Error: {:?}", e);
                                                }
                                            }
                                            // CRITICAL: Poll to generate the TCP packet
                                            iface.poll(Instant::now(), &mut device, &mut socket_set);

                                            // Send any generated packets through WireGuard
                                            while let Some(packet) = device.tx_queue.pop_front() {
                                                match tunn.encapsulate(&packet, &mut dst_buf) {
                                                    TunnResult::WriteToNetwork(b) => {
                                                        let _ = udp_socket.try_send(b);
                                                        eprintln!("[SEND] Sent {} bytes through WireGuard", b.len());
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        } else {
                                            eprintln!("[SEND] Socket cannot send right now - state: {:?}. Buffering data.", socket.state());
                                            // Buffer the data for later
                                            pending_data.entry(connection_id).or_default().push(data);
                                        }
                                    } else {
                                        eprintln!("[SEND] Connection {} not found", connection_id);
                                    }
                                },
                                NetworkCommand::Close { connection_id } => {
                                     if let Some((handle, _)) = connections.get(&connection_id) {
                                        let socket = socket_set.get_mut::<tcp::Socket>(*handle);
                                        socket.close();
                                     }
                                }
                                NetworkCommand::Listen { port, on_connection, on_data, on_close, resp } => {
                                    eprintln!("[LISTEN] Request on port {}", port);
                                    
                                    // Store listener info for spawning future sockets
                                    listeners.insert(port, ListenerInfo { 
                                        port, 
                                        on_connection, 
                                        on_data: on_data, // clone needed? TF is cloneable
                                        on_close: on_close 
                                    });

                                    // Create first listening socket
                                    let rx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                    let tx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                    let mut socket = tcp::Socket::new(rx_buffer, tx_buffer);

                                    let local_endpoint = (IpAddress::Ipv4(source_ip_addr), port);
                                    match socket.listen(local_endpoint) {
                                        Ok(_) => {
                                            let handle = socket_set.add(socket);
                                            listening_sockets.insert(port, handle);
                                            let _ = resp.send(Ok(()));
                                            eprintln!("[LISTEN] Socket listening on port {}", port);
                                        },
                                        Err(e) => {
                                            eprintln!("[LISTEN] Failed to listen: {:?}", e);
                                            let _ = resp.send(Err(Error::from_reason(format!("Listen failed: {:?}", e))));
                                        }
                                    }
                                }
                             }
                        }
                    }
                    res = udp_socket.recv(&mut buf) => {
                         match res {
                            Ok(len) => {
                                 // WireGuard packet types: 1=Initiation, 2=Response, 3=CookieReply, 4=Data
                                 let pkt_type = if len >= 4 { buf[0] } else { 0 };
                                 let type_name = match pkt_type {
                                     1 => "Initiation",
                                     2 => "Response",
                                     3 => "CookieReply",
                                     4 => "Data",
                                     _ => "Unknown"
                                 };
                                 // eprintln!("[WG] Received {} bytes from UDP (type={} {})", len, pkt_type, type_name);
                                 let _ = std::io::stderr().flush();

                                 // First decapsulate with the received data
                                 match tunn.decapsulate(None, &buf[..len], &mut dst_buf) {
                                    TunnResult::WriteToNetwork(b) => {
                                         let res = udp_socket.send(b).await;
                                         eprintln!("[WG] Decap triggered reply ({} bytes). Send result: {:?}", b.len(), res);
                                         let _ = std::io::stderr().flush();

                                         // CRITICAL: After WriteToNetwork, boringtun may have more packets!
                                         // We need to loop with empty input to drain pending handshake packets.
                                         loop {
                                             let mut extra_buf = [0u8; 65535];
                                             match tunn.decapsulate(None, &[], &mut extra_buf) {
                                                 TunnResult::WriteToNetwork(b2) => {
                                                     let res2 = udp_socket.send(b2).await;
                                                     eprintln!("[WG] Decap follow-up packet ({} bytes). Send result: {:?}", b2.len(), res2);
                                                 }
                                                 TunnResult::Done => {
                                                     eprintln!("[WG] Handshake sequence complete!");
                                                     break;
                                                 }
                                                 _ => break,
                                             }
                                         }
                                    }
                                    TunnResult::WriteToTunnelV4(b, _) => {
                                        // Simple manual inspection of TCP flags to debug handshake
                                        if b.len() > 20 && b[9] == 6 { // IPv4 & TCP
                                            let ihl = (b[0] & 0x0F) * 4;
                                            if b.len() >= (ihl as usize + 14) {
                                                let tcp_flags = b[ihl as usize + 13];
                                                let is_syn = tcp_flags & 0x02 != 0;
                                                let is_ack = tcp_flags & 0x10 != 0;
                                                let is_rst = tcp_flags & 0x04 != 0;
                                                let is_fin = tcp_flags & 0x01 != 0;
                                                let is_psh = tcp_flags & 0x08 != 0;
                                                /*
                                                eprintln!("[WG] Decapped IPv4 TCP ({} bytes). Flags: [{} {} {} {} {}]",
                                                    b.len(),
                                                    if is_syn { "SYN" } else { "-" },
                                                    if is_ack { "ACK" } else { "-" },
                                                    if is_rst { "RST" } else { "-" },
                                                    if is_fin { "FIN" } else { "-" },
                                                    if is_psh { "PSH" } else { "-" }
                                                );
                                                */
                                            }
                                        } else {
                                            // eprintln!("[WG] Decapped IPv4 DATA ({} bytes)", b.len());
                                        }

                                        device.rx_queue.push_back(b.to_vec());

                                        // CRITICAL: Immediately poll so smoltcp processes the packet
                                        iface.poll(Instant::now(), &mut device, &mut socket_set);

                                        // Check if any connections can now send buffered data
                                        for (id, (handle, _)) in connections.iter() {
                                            let socket = socket_set.get_mut::<tcp::Socket>(*handle);
                                            // eprintln!("[DEBUG] Socket {} state after poll: {:?}, can_send: {}", id, socket.state(), socket.can_send());
                                            
                                            if socket.can_send() {
                                                if let Some(buffers) = pending_data.get_mut(id) {
                                                    if !buffers.is_empty() {
                                                        // eprintln!("[SEND] Flushing {} buffered chunks for connection {}", buffers.len(), id);
                                                        for data in buffers.drain(..) {
                                                            match socket.send_slice(&data) {
                                                                Ok(sent) => {
                                                                    // eprintln!("[SEND] Flushed {} bytes to TCP socket", sent);
                                                                }
                                                                Err(e) => {
                                                                    eprintln!("[SEND] Flush error: {:?}", e);
                                                                }
                                                            }
                                                        }
                                                        // Poll again to generate packets
                                                        iface.poll(Instant::now(), &mut device, &mut socket_set);
                                                        
                                                        // Send generated packets through WireGuard
                                                        while let Some(packet) = device.tx_queue.pop_front() {
                                                            match tunn.encapsulate(&packet, &mut dst_buf) {
                                                                TunnResult::WriteToNetwork(b2) => {
                                                                    let _ = udp_socket.try_send(b2);
                                                                    // eprintln!("[SEND] Flushed {} bytes through WireGuard", b2.len());
                                                                }
                                                                _ => {}
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    TunnResult::Done => {
                                         eprintln!("[WG] Decap: Done (no action needed)");
                                    }
                                    TunnResult::Err(e) => {
                                         eprintln!("[WG] Decap error: {:?}", e);
                                    }
                                    _ => {
                                         eprintln!("[WG] Decap result: Other (WriteToTunnelV6?)");
                                    }
                                 }
                            }
                             Err(e) => {
                                 eprintln!("UDP Recv Error: {:?}", e);
                             }
                         }
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {}
                }
                // Process Device Tx -> WireGuard
                while let Some(packet) = device.tx_queue.pop_front() {
                     match tunn.encapsulate(&packet, &mut dst_buf) {
                        TunnResult::WriteToNetwork(b) => {
                             let res = udp_socket.send(b).await;
                             // eprintln!("[WG] Encap sent packet ({} bytes). Send result: {:?}", b.len(), res);
                        }
                        _ => {}
                     }
                }
                
                match tunn.update_timers(&mut dst_buf) {
                     TunnResult::WriteToNetwork(b) => {
                          let res = udp_socket.send(b).await;
                          eprintln!("[WG] Timer handshake/keepalive ({} bytes). Send result: {:?}", b.len(), res);
                     }
                     _ => {}
                }

                let mut to_remove = Vec::new();
                for (id, (handle, ctx)) in connections.iter() {
                     let socket = socket_set.get_mut::<tcp::Socket>(*handle);
                     if socket.can_recv() {
                         let recv_len = socket.recv_queue(); // Avoid potential issues with empty queue alloc
                         if recv_len > 0 {
                             let mut data = vec![0; recv_len];
                             if let Ok(len) = socket.recv_slice(&mut data) {
                                 if len > 0 {
                                     let buffer = Buffer::from(data[..len].to_vec());
                                     match ctx {
                                         ConnectionContext::Client { on_data, .. } => {
                                             on_data.call(Ok(buffer), ThreadsafeFunctionCallMode::NonBlocking);
                                         },
                                         ConnectionContext::Server { on_data, .. } => {
                                             on_data.call(Ok((*id, buffer)), ThreadsafeFunctionCallMode::NonBlocking);
                                         }
                                     }
                                 }
                             }
                        }
                     }
                     if socket.state() == tcp::State::Closed {
                         match ctx {
                             ConnectionContext::Client { on_close, .. } => {
                                 on_close.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking); 
                             },
                             ConnectionContext::Server { on_close, .. } => {
                                 on_close.call(Ok(*id), ThreadsafeFunctionCallMode::NonBlocking);
                             }
                         }
                         to_remove.push(*id);
                     }
                }
                for id in to_remove {
                    if let Some((handle, _)) = connections.remove(&id) {
                         socket_set.remove(handle);
                         pending_data.remove(&id); // Clean up pending data for closed connections
                    }
                }

                // Check if any connections can now send pending buffered data
                for (id, (handle, _)) in connections.iter() {
                    let socket = socket_set.get_mut::<tcp::Socket>(*handle);
                    if socket.can_send() {
                        if let Some(buffers) = pending_data.get_mut(id) {
                            if !buffers.is_empty() {
                                eprintln!("[FLUSH] Flushing {} buffered chunks for connection {}", buffers.len(), id);
                                for data in buffers.drain(..) {
                                    match socket.send_slice(&data) {
                                        Ok(sent) => {
                                            eprintln!("[FLUSH] Sent {} bytes to TCP socket", sent);
                                        }
                                        Err(e) => {
                                            eprintln!("[FLUSH] Error: {:?}", e);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                                        // --- Server: Check for incoming connections ---
                                        let mut new_connections = Vec::new(); 
                                        for (&port, &handle) in listening_sockets.iter() {
                                            let socket = socket_set.get::<tcp::Socket>(handle);
                                            // Actively established means we accepted a handshake
                                            if socket.state() == tcp::State::Established {
                                                if let Some(remote) = socket.remote_endpoint() {
                                                    new_connections.push((port, handle, remote));
                                                }
                                            }
                                        }

                                        for (port, handle, remote) in new_connections {
                                            if let Some(info) = listeners.get(&port) {
                                                let id = next_conn_id;
                                                next_conn_id += 1;
                                                
                                                let remote_ip = match remote.addr { IpAddress::Ipv4(ip) => ip.to_string(), _ => "unknown".to_string() };
                                                let remote_port = remote.port;
                                                
                                                connections.insert(id, (handle, ConnectionContext::Server {
                                                    on_data: info.on_data.clone(),
                                                    on_close: info.on_close.clone()
                                                }));

                                                info.on_connection.call(Ok((id, remote_ip.clone(), remote_port)), ThreadsafeFunctionCallMode::NonBlocking);
                                                
                                                eprintln!("[SERVER] Accepted conn {} from {}:{}", id, remote_ip, remote_port);

                                                // Create Replacement Listener Socket for this port
                                                let rx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                                let tx_buffer = tcp::SocketBuffer::new(vec![0; 65535]);
                                                let mut socket = tcp::Socket::new(rx_buffer, tx_buffer);

                                                let local_endpoint = (IpAddress::Ipv4(source_ip_addr), port);
                                                if let Ok(_) = socket.listen(local_endpoint) {
                                                    let new_handle = socket_set.add(socket);
                                                    listening_sockets.insert(port, new_handle); // Replace occupied handle
                                                }
                                            }
                                        }

                                // Poll to generate packets
                                iface.poll(Instant::now(), &mut device, &mut socket_set);
                                
                                // Send packets through WireGuard
                                while let Some(packet) = device.tx_queue.pop_front() {
                                    match tunn.encapsulate(&packet, &mut dst_buf) {
                                        TunnResult::WriteToNetwork(b) => {
                                            let _ = udp_socket.try_send(b);
                                            eprintln!("[FLUSH] Sent {} bytes through WireGuard", b.len());
                                        }
                                        _ => {}
                                    }
                                }
            } // end loop
        }); // end spawn

        Ok(Self { cmd_tx })
    }

    #[napi]
    pub async fn connect(&self, dest_ip: String, dest_port: u16, on_data: ThreadsafeFunction<Buffer>, on_close: ThreadsafeFunction<()>) -> Result<Connection> {
        let dest_ip_addr = Ipv4Address::from_str(&dest_ip).map_err(|_| Error::from_reason("Invalid dest IP"))?;
        
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(NetworkCommand::Connect { 
            dest_ip: dest_ip_addr, 
            dest_port, 
            on_data,
            on_close,
            resp: tx 
        }).await.map_err(|_| Error::from_reason("Failed to send command"))?;

        let id = match rx.await {
            Ok(res) => res?,
            Err(_) => return Err(Error::from_reason("Connection Task Failed")),
        };
        
        Ok(Connection { id, cmd_tx: self.cmd_tx.clone() })
    }

    #[napi]
    pub async fn listen(&self, port: u16, on_connection: ThreadsafeFunction<(u32, String, u16)>, on_data: ThreadsafeFunction<(u32, Buffer)>, on_close: ThreadsafeFunction<u32>) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(NetworkCommand::Listen {
            port,
            on_connection,
            on_data,
            on_close,
            resp: tx,
        }).await.map_err(|_| Error::from_reason("Failed to send Listen command"))?;

        match rx.await {
            Ok(res) => res,
            Err(_) => Err(Error::from_reason("Listen Task Failed")),
        }
    }

    /// Send data to a connection by ID (works for both client and server connections)
    #[napi]
    pub async fn send_to(&self, connection_id: u32, data: Buffer) -> Result<()> {
        let vec_data: Vec<u8> = data.into();
        self.cmd_tx.send(NetworkCommand::SendData {
            connection_id,
            data: vec_data
        }).await.map_err(|_| Error::from_reason("Failed to send data"))?;
        Ok(())
    }

    /// Close a connection by ID (works for both client and server connections)
    #[napi]
    pub async fn close_connection(&self, connection_id: u32) -> Result<()> {
        self.cmd_tx.send(NetworkCommand::Close {
            connection_id
        }).await.map_err(|_| Error::from_reason("Failed to close connection"))?;
        Ok(())
    }
}

#[napi]
pub struct Connection {
    id: u32,
    cmd_tx: mpsc::Sender<NetworkCommand>,
}

#[napi]
impl Connection {
    #[napi]
    pub async fn send(&self, data: Buffer) -> Result<()> {
        let vec_data: Vec<u8> = data.into();
        self.cmd_tx.send(NetworkCommand::SendData {
            connection_id: self.id,
            data: vec_data
        }).await.map_err(|_| Error::from_reason("Failed to send data"))?;
        Ok(())
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.cmd_tx.send(NetworkCommand::Close {
            connection_id: self.id
        }).await.map_err(|_| Error::from_reason("Failed to send close"))?;
        Ok(())
    }
}

fn decode_key(key: &str) -> std::result::Result<[u8; 32], String> {
    let bytes = general_purpose::STANDARD.decode(key).map_err(|e| e.to_string())?;
    if bytes.len() != 32 {
        return Err("Key must be 32 bytes".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}
