#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use base64::{engine::general_purpose, Engine as _};
use boringtun::noise::{Tunn, TunnResult};
use log::{debug, error, info, trace, warn};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use smoltcp::iface::{Config, Interface, PollIngressSingleResult, PollResult, SocketHandle, SocketSet};
use smoltcp::phy::{Checksum, ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{icmp, tcp};
use smoltcp::wire::{IpAddress, Icmpv4Packet, Icmpv4Repr, Ipv4Address, Ipv4Cidr};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

mod transport;
use transport::{setup_transport, Transport, TransportConfig, WsClientConfig, WsClientMode, WsServerConfig};

// --- Tunables ---

/// MTU of the virtual interface (WireGuard default).
const MTU: usize = 1420;
/// Default size of each TCP socket's RX and TX buffer (the TCP window). Used
/// when no `tcpBufferSize` option is supplied, so behavior is unchanged.
const DEFAULT_TCP_BUFFER_SIZE: usize = 512 * 1024;
/// Hard cap on a configured TCP buffer size, so a bogus value cannot request
/// an absurd per-connection allocation (RX + TX buffers).
const MAX_TCP_BUFFER_SIZE: usize = 64 * 1024 * 1024;
/// Number of sockets kept in the LISTEN state per port. Concurrent SYN bursts
/// larger than this are still accepted, because LISTEN sockets are replenished
/// between individual ingress packets (see `Engine::ensure_listen_backlog`).
const LISTEN_BACKLOG: usize = 4;
/// Hard cap on sockets held by one listener's pool (LISTEN + in-flight
/// handshakes), i.e. the largest concurrent SYN burst absorbed before excess
/// SYNs are reset. Bounds memory under a SYN flood.
const MAX_LISTEN_POOL: usize = 64;
/// How long a client connect may stay in SYN-SENT before it is rejected.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// smoltcp retransmission timeout: abort if the peer is silent this long while data is unacked.
const TCP_TIMEOUT: smoltcp::time::Duration = smoltcp::time::Duration::from_secs(60);
/// How long an ICMP echo request waits for its reply.
const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// Default timeout for `waitForHandshake`.
const DEFAULT_HANDSHAKE_TIMEOUT_MS: u32 = 10_000;
/// Interval for boringtun's `update_timers` and other housekeeping.
const TIMER_INTERVAL: Duration = Duration::from_millis(250);
/// After the peer half-closed a connection, close our side automatically if
/// JS has not done so within this time (prevents leaking half-open sockets).
const HALF_CLOSE_LINGER: Duration = Duration::from_secs(30);
/// Upper bounds for work done per loop iteration, so no source starves the others.
const MAX_DATAGRAMS_PER_ITER: usize = 256;
const MAX_COMMANDS_PER_ITER: usize = 64;
const MAX_EGRESS_ROUNDS: usize = 64;
/// Safety bound on ingress packets processed per `poll_iface` call.
const MAX_INGRESS_PACKETS: usize = 2048;
/// Identifier used for our ICMP echo requests.
const ICMP_IDENT: u16 = 0x1234;
const EPHEMERAL_PORT_START: u16 = 49152;

// --- Commands (JS -> network task) ---

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
        resp: oneshot::Sender<Result<()>>,
    },
    Close {
        connection_id: u32,
    },
    /// Stop draining this connection's RX queue (inbound backpressure).
    Pause {
        connection_id: u32,
    },
    /// Resume draining this connection's RX queue.
    Resume {
        connection_id: u32,
    },
    Listen {
        port: u16,
        /// (conn_id, remote_ip, remote_port)
        on_connection: ThreadsafeFunction<(u32, String, u16)>,
        /// (conn_id, data)
        on_data: ThreadsafeFunction<(u32, Buffer)>,
        /// (conn_id)
        on_close: ThreadsafeFunction<u32>,
        resp: oneshot::Sender<Result<()>>,
    },
    Ping {
        dest_ip: Ipv4Address,
        resp: oneshot::Sender<Result<u32>>,
    },
    Shutdown {
        resp: oneshot::Sender<()>,
    },
}

impl NetworkCommand {
    /// Answer the command with an error without executing it.
    fn reject(self, msg: &str) {
        match self {
            NetworkCommand::Connect { resp, .. } | NetworkCommand::Ping { resp, .. } => {
                let _ = resp.send(Err(Error::from_reason(msg)));
            }
            NetworkCommand::SendData { resp, .. } | NetworkCommand::Listen { resp, .. } => {
                let _ = resp.send(Err(Error::from_reason(msg)));
            }
            NetworkCommand::Shutdown { resp } => {
                let _ = resp.send(());
            }
            NetworkCommand::Close { .. } | NetworkCommand::Pause { .. } | NetworkCommand::Resume { .. } => {}
        }
    }
}

// --- Tunnel state (network task -> JS) ---

#[derive(Clone, Debug)]
enum TunnelState {
    /// Setup running or WireGuard handshake not (yet / any longer) complete.
    Connecting,
    /// WireGuard session established.
    Ready,
    /// Setup failed (DNS, UDP bind, ...). The task has terminated.
    Failed(String),
    /// Shut down. The task has terminated.
    Closed,
}

// --- Connection bookkeeping ---

enum ConnectionContext {
    Client {
        on_data: ThreadsafeFunction<Buffer>,
        on_close: ThreadsafeFunction<()>,
    },
    Server {
        on_data: ThreadsafeFunction<(u32, Buffer)>,
        on_close: ThreadsafeFunction<u32>,
    },
}

/// Data waiting to be copied into the smoltcp TX buffer.
struct PendingSend {
    data: Vec<u8>,
    offset: usize,
    resp: oneshot::Sender<Result<()>>,
}

struct TcpConnection {
    handle: SocketHandle,
    ctx: ConnectionContext,
    /// `false` while a client connect is still in SYN-SENT.
    established: bool,
    /// Responder of a client connect that is not yet established.
    connect_resp: Option<oneshot::Sender<Result<u32>>>,
    connect_deadline: std::time::Instant,
    pending: VecDeque<PendingSend>,
    /// JS asked to close; FIN is sent once `pending` is drained.
    close_requested: bool,
    /// `socket.close()` has been called.
    fin_sent: bool,
    /// `on_close` has been delivered to JS.
    close_signaled: bool,
    /// When the peer's FIN (EOF) was observed.
    eof_at: Option<std::time::Instant>,
    /// While `true` the engine stops draining this socket's RX queue, so its
    /// TCP window closes and the peer throttles (inbound backpressure).
    paused: bool,
}

impl TcpConnection {
    fn new(handle: SocketHandle, ctx: ConnectionContext, established: bool) -> Self {
        Self {
            handle,
            ctx,
            established,
            connect_resp: None,
            connect_deadline: std::time::Instant::now() + CONNECT_TIMEOUT,
            pending: VecDeque::new(),
            close_requested: false,
            fin_sent: false,
            close_signaled: false,
            eof_at: None,
            paused: false,
        }
    }

    fn deliver_data(&self, id: u32, data: Vec<u8>) {
        let buffer = Buffer::from(data);
        match &self.ctx {
            ConnectionContext::Client { on_data, .. } => {
                on_data.call(Ok(buffer), ThreadsafeFunctionCallMode::NonBlocking);
            }
            ConnectionContext::Server { on_data, .. } => {
                on_data.call(Ok((id, buffer)), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }

    /// Deliver `on_close` exactly once.
    fn signal_close(&mut self, id: u32) {
        if self.close_signaled {
            return;
        }
        self.close_signaled = true;
        debug!("[TCP] connection {} closed", id);
        match &self.ctx {
            ConnectionContext::Client { on_close, .. } => {
                on_close.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
            }
            ConnectionContext::Server { on_close, .. } => {
                on_close.call(Ok(id), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }

    fn fail_pending(&mut self, msg: &str) {
        for p in self.pending.drain(..) {
            let _ = p.resp.send(Err(Error::from_reason(msg)));
        }
    }

    /// Move as much pending data as possible into the socket's TX buffer.
    /// A send is acknowledged only once all of its bytes are queued.
    fn flush_pending(&mut self, socket: &mut tcp::Socket<'_>) {
        while let Some(front) = self.pending.front_mut() {
            if !socket.can_send() {
                break;
            }
            match socket.send_slice(&front.data[front.offset..]) {
                Ok(0) => break,
                Ok(n) => {
                    front.offset += n;
                    if front.offset >= front.data.len() {
                        if let Some(done) = self.pending.pop_front() {
                            let _ = done.resp.send(Ok(()));
                        }
                    }
                }
                Err(e) => {
                    debug!("[TCP] send_slice failed: {:?}", e);
                    break;
                }
            }
        }
        if !self.pending.is_empty() && self.established && !socket.may_send() {
            self.fail_pending("Connection closed before data could be sent");
        }
    }
}

struct Listener {
    on_connection: ThreadsafeFunction<(u32, String, u16)>,
    on_data: ThreadsafeFunction<(u32, Buffer)>,
    on_close: ThreadsafeFunction<u32>,
    /// Pool of sockets in LISTEN / SYN-RECEIVED state.
    pool: Vec<SocketHandle>,
}

struct PendingPing {
    resp: oneshot::Sender<Result<u32>>,
    started: std::time::Instant,
}

// --- Virtual Device (IP) ---

struct VirtualDevice {
    rx_queue: VecDeque<Vec<u8>>,
    tx_queue: VecDeque<Vec<u8>>,
    /// Recycled packet buffers to avoid an allocation per packet.
    pool: Vec<Vec<u8>>,
    mtu: usize,
}

const DEVICE_POOL_MAX: usize = 256;

fn take_buf(pool: &mut Vec<Vec<u8>>, len: usize) -> Vec<u8> {
    let mut buf = pool.pop().unwrap_or_default();
    buf.clear();
    buf.resize(len, 0);
    buf
}

impl VirtualDevice {
    fn new(mtu: usize) -> Self {
        Self {
            rx_queue: VecDeque::new(),
            tx_queue: VecDeque::new(),
            pool: Vec::new(),
            mtu,
        }
    }

    fn push_rx(&mut self, packet: &[u8]) {
        let mut buf = take_buf(&mut self.pool, 0);
        buf.extend_from_slice(packet);
        self.rx_queue.push_back(buf);
    }

    fn recycle(&mut self, buf: Vec<u8>) {
        if self.pool.len() < DEVICE_POOL_MAX {
            self.pool.push(buf);
        }
    }
}

impl Device for VirtualDevice {
    type RxToken<'a> = RxTokenVec;
    type TxToken<'a> = TxTokenVec<'a>;

    fn receive(&mut self, _timestamp: smoltcp::time::Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        let buffer = self.rx_queue.pop_front()?;
        Some((
            RxTokenVec { buffer },
            TxTokenVec {
                queue: &mut self.tx_queue,
                pool: &mut self.pool,
            },
        ))
    }

    fn transmit(&mut self, _timestamp: smoltcp::time::Instant) -> Option<Self::TxToken<'_>> {
        Some(TxTokenVec {
            queue: &mut self.tx_queue,
            pool: &mut self.pool,
        })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = self.mtu;
        caps.checksum.ipv4 = Checksum::Both;
        caps.checksum.tcp = Checksum::Both;
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
        f(&self.buffer)
    }
}

struct TxTokenVec<'a> {
    queue: &'a mut VecDeque<Vec<u8>>,
    pool: &'a mut Vec<Vec<u8>>,
}

impl TxToken for TxTokenVec<'_> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut buffer = take_buf(self.pool, len);
        let result = f(&mut buffer);
        self.queue.push_back(buffer);
        result
    }
}

// --- Helpers ---

fn random_u64() -> u64 {
    RandomState::new().build_hasher().finish()
}

fn smol_now() -> smoltcp::time::Instant {
    smoltcp::time::Instant::now()
}

/// Sanitize a caller-supplied TCP buffer size (bytes): `None` / `0` falls back
/// to the default (512 KiB, unchanged behavior), anything larger than
/// `MAX_TCP_BUFFER_SIZE` is clamped down to it.
fn sanitize_tcp_buffer_size(size: Option<u32>) -> usize {
    match size {
        Some(n) if n > 0 => (n as usize).min(MAX_TCP_BUFFER_SIZE),
        _ => DEFAULT_TCP_BUFFER_SIZE,
    }
}

fn new_tcp_socket(buffer_size: usize) -> tcp::Socket<'static> {
    let rx = tcp::SocketBuffer::new(vec![0; buffer_size]);
    let tx = tcp::SocketBuffer::new(vec![0; buffer_size]);
    let mut socket = tcp::Socket::new(rx, tx);
    socket.set_nagle_enabled(false);
    // Abort connections whose peer stops acknowledging outstanding data.
    socket.set_timeout(Some(TCP_TIMEOUT));
    socket
}

/// Read everything currently available in the socket's RX buffer.
fn drain_recv(socket: &mut tcp::Socket<'_>) -> Vec<u8> {
    let mut data = Vec::with_capacity(socket.recv_queue());
    while socket.can_recv() {
        let res = socket.recv(|chunk| {
            data.extend_from_slice(chunk);
            (chunk.len(), chunk.len())
        });
        match res {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    data
}

// --- Network engine (runs inside one tokio task) ---

struct Engine {
    tunn: Tunn,
    transport: Arc<dyn Transport>,
    device: VirtualDevice,
    iface: Interface,
    sockets: SocketSet<'static>,
    source_ip: Ipv4Address,
    /// RX/TX buffer size for every TCP socket created by this engine.
    tcp_buffer_size: usize,
    state_tx: watch::Sender<TunnelState>,

    icmp_handle: SocketHandle,
    pending_pings: HashMap<u16, PendingPing>,
    ping_seq: u16,

    connections: HashMap<u32, TcpConnection>,
    listeners: HashMap<u16, Listener>,
    next_conn_id: u32,
    next_local_port: u16,

    /// Incoming UDP datagram buffer.
    udp_buf: Vec<u8>,
    /// Output buffer for boringtun (encapsulate / decapsulate / timers).
    wg_buf: Vec<u8>,

    /// Cheap instrumentation (Stage A), printed only when `WIRESHADE_STATS` set.
    stats: Stats,
}

/// Result of handling a command.
enum Flow {
    Continue,
    Shutdown(Option<oneshot::Sender<()>>),
}

/// Cheap engine instrumentation (Stage A). Counters are always incremented
/// (plain u64 adds); a per-second summary is printed to stderr only when the
/// `WIRESHADE_STATS` env var is set, so there is no cost on the hot path in
/// production. Used to characterize where the UDP path idles.
#[derive(Default)]
struct Stats {
    enabled: bool,
    last: Option<std::time::Instant>,
    loop_iters: u64,
    woke_cmd: u64,
    woke_recv: u64,
    woke_timer: u64,
    woke_sleep: u64,
    rx_datagrams: u64,
    rx_drained: u64,
    tx_packets: u64,
    send_calls: u64,
    flush_calls: u64,
    flush_nonempty: u64,
    ingress_pkts: u64,
    egress_pkts: u64,
    cmds: u64,
}

impl Stats {
    fn new() -> Self {
        Self {
            enabled: std::env::var_os("WIRESHADE_STATS").is_some(),
            ..Default::default()
        }
    }

    fn maybe_report(&mut self) {
        if !self.enabled {
            return;
        }
        let now = std::time::Instant::now();
        let last = *self.last.get_or_insert(now);
        let dt = now.duration_since(last).as_secs_f64();
        if dt < 1.0 {
            return;
        }
        let per = |n: u64| (n as f64 / dt) as u64;
        let avg_flush = if self.flush_nonempty > 0 {
            self.tx_packets as f64 / self.flush_nonempty as f64
        } else {
            0.0
        };
        eprintln!(
            "[STATS] iters/s={} | wake: cmd={} recv={} timer={} sleep={} | rx_dgram/s={} (drained/s={}) \
             | tx_pkt/s={} send/s={} flush(nonempty)/s={} avg_tx_batch={:.1} | ingress/s={} egress/s={} cmds/s={}",
            per(self.loop_iters),
            per(self.woke_cmd), per(self.woke_recv), per(self.woke_timer), per(self.woke_sleep),
            per(self.rx_datagrams), per(self.rx_drained),
            per(self.tx_packets), per(self.send_calls), per(self.flush_nonempty), avg_flush,
            per(self.ingress_pkts), per(self.egress_pkts), per(self.cmds),
        );
        // Reset the window.
        let enabled = self.enabled;
        *self = Stats { enabled, last: Some(now), ..Default::default() };
    }
}

impl Engine {
    fn new(
        tunn: Tunn,
        transport: Arc<dyn Transport>,
        source_ip: Ipv4Address,
        tcp_buffer_size: usize,
        state_tx: watch::Sender<TunnelState>,
    ) -> std::result::Result<Self, String> {
        let mut device = VirtualDevice::new(MTU);
        let mut sockets = SocketSet::new(vec![]);

        let mut config = Config::new(smoltcp::wire::HardwareAddress::Ip);
        config.random_seed = random_u64();
        let mut iface = Interface::new(config, &mut device, smol_now());
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(Ipv4Cidr::new(source_ip, 32).into());
        });

        let icmp_rx = icmp::PacketBuffer::new(vec![icmp::PacketMetadata::EMPTY; 16], vec![0; 4096]);
        let icmp_tx = icmp::PacketBuffer::new(vec![icmp::PacketMetadata::EMPTY; 16], vec![0; 4096]);
        let mut icmp_socket = icmp::Socket::new(icmp_rx, icmp_tx);
        icmp_socket
            .bind(icmp::Endpoint::Ident(ICMP_IDENT))
            .map_err(|e| format!("Failed to bind ICMP socket: {:?}", e))?;
        let icmp_handle = sockets.add(icmp_socket);

        let port_range = u64::from(u16::MAX - EPHEMERAL_PORT_START) + 1;
        let next_local_port = EPHEMERAL_PORT_START + (random_u64() % port_range) as u16;

        Ok(Self {
            tunn,
            transport,
            device,
            iface,
            sockets,
            source_ip,
            tcp_buffer_size,
            state_tx,
            icmp_handle,
            pending_pings: HashMap::new(),
            ping_seq: 1,
            connections: HashMap::new(),
            listeners: HashMap::new(),
            next_conn_id: 1,
            next_local_port,
            udp_buf: vec![0; 65535],
            wg_buf: vec![0; 65535],
            stats: Stats::new(),
        })
    }

    async fn run(mut self, mut cmd_rx: mpsc::Receiver<NetworkCommand>, queued: Vec<NetworkCommand>) {
        self.initiate_handshake().await;

        for cmd in queued {
            if let Flow::Shutdown(resp) = self.handle_command(cmd) {
                self.shutdown(resp).await;
                return;
            }
        }

        let mut next_timer = tokio::time::Instant::now() + TIMER_INTERVAL;
        loop {
            self.stats.loop_iters += 1;
            self.stats.maybe_report();
            self.poll_iface();
            self.process_listeners();
            self.process_connections();
            self.process_icmp();
            self.poll_iface();
            self.flush_tx().await;
            self.update_state();

            let now = tokio::time::Instant::now();
            if now >= next_timer {
                self.stats.woke_timer += 1;
                self.on_timer().await;
                next_timer = now + TIMER_INTERVAL;
                continue;
            }

            let wake_at = match self.iface.poll_delay(smol_now(), &self.sockets) {
                Some(d) => next_timer.min(now + Duration::from_micros(d.total_micros())),
                None => next_timer,
            };

            let flow = tokio::select! {
                biased;
                cmd = cmd_rx.recv() => match cmd {
                    None => Flow::Shutdown(None),
                    Some(cmd) => {
                        self.stats.woke_cmd += 1;
                        self.stats.cmds += 1;
                        let mut flow = self.handle_command(cmd);
                        for _ in 1..MAX_COMMANDS_PER_ITER {
                            if !matches!(flow, Flow::Continue) {
                                break;
                            }
                            match cmd_rx.try_recv() {
                                Ok(cmd) => { self.stats.cmds += 1; flow = self.handle_command(cmd); }
                                Err(_) => break,
                            }
                        }
                        flow
                    }
                },
                res = self.transport.recv(&mut self.udp_buf) => {
                    self.stats.woke_recv += 1;
                    match res {
                        Ok(len) => {
                            self.stats.rx_datagrams += 1;
                            self.handle_datagram(len).await;
                            // Drain any further datagrams that are already available,
                            // so a burst is processed in one poll cycle (as UDP did).
                            for _ in 1..MAX_DATAGRAMS_PER_ITER {
                                match self.transport.try_recv(&mut self.udp_buf) {
                                    Ok(len) => { self.stats.rx_datagrams += 1; self.stats.rx_drained += 1; self.handle_datagram(len).await; }
                                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                                    Err(e) => debug!("[WG] transport recv error: {}", e),
                                }
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                        Err(e) => debug!("[WG] transport recv error: {}", e),
                    }
                    Flow::Continue
                },
                _ = tokio::time::sleep_until(wake_at) => { self.stats.woke_sleep += 1; Flow::Continue },
            };

            if let Flow::Shutdown(resp) = flow {
                self.shutdown(resp).await;
                return;
            }
        }
    }

    // --- WireGuard / transport ---

    async fn initiate_handshake(&mut self) {
        if let TunnResult::WriteToNetwork(b) = self.tunn.format_handshake_initiation(&mut self.wg_buf, false) {
            debug!("[WG] sending handshake initiation ({} bytes)", b.len());
            if let Err(e) = self.transport.send(b).await {
                warn!("[WG] failed to send handshake initiation: {}", e);
            }
        }
    }

    async fn handle_datagram(&mut self, len: usize) {
        let mut first = true;
        loop {
            let input: &[u8] = if first { &self.udp_buf[..len] } else { &[] };
            first = false;
            match self.tunn.decapsulate(None, input, &mut self.wg_buf) {
                TunnResult::WriteToNetwork(b) => {
                    trace!("[WG] decapsulate -> network ({} bytes)", b.len());
                    if let Err(e) = self.transport.send(b).await {
                        debug!("[WG] transport send failed: {}", e);
                    }
                    // boringtun may have more queued packets: repeat with empty input.
                }
                TunnResult::WriteToTunnelV4(b, _) => {
                    trace!("[WG] decapsulate -> tunnel ({} bytes)", b.len());
                    self.device.push_rx(b);
                    break;
                }
                TunnResult::WriteToTunnelV6(..) => {
                    trace!("[WG] dropping IPv6 packet");
                    break;
                }
                TunnResult::Done => break,
                TunnResult::Err(e) => {
                    debug!("[WG] decapsulate error: {:?}", e);
                    break;
                }
            }
        }
    }

    /// Encrypt and send everything smoltcp has emitted.
    async fn flush_tx(&mut self) {
        self.stats.flush_calls += 1;
        let mut sent = false;
        while let Some(packet) = self.device.tx_queue.pop_front() {
            match self.tunn.encapsulate(&packet, &mut self.wg_buf) {
                TunnResult::WriteToNetwork(b) => {
                    self.stats.tx_packets += 1;
                    self.stats.send_calls += 1;
                    sent = true;
                    if let Err(e) = self.transport.send(b).await {
                        debug!("[WG] transport send failed: {}", e);
                    }
                }
                TunnResult::Err(e) => debug!("[WG] encapsulate error: {:?}", e),
                _ => {}
            }
            self.device.recycle(packet);
        }
        if sent {
            self.stats.flush_nonempty += 1;
        }
    }

    async fn on_timer(&mut self) {
        match self.tunn.update_timers(&mut self.wg_buf) {
            TunnResult::WriteToNetwork(b) => {
                trace!("[WG] timer packet ({} bytes)", b.len());
                if let Err(e) = self.transport.send(b).await {
                    debug!("[WG] transport send failed: {}", e);
                }
            }
            TunnResult::Err(e) => {
                // ConnectionExpired: boringtun exhausted handshake retries or the
                // session aged out past REJECT_AFTER_TIME * 3 and cleared all keys.
                // The WireGuard session is gone; reflect that in the watch state so
                // `waitForDisconnect` resolves without waiting for the next poll.
                debug!("[WG] session expired: {:?}", e);
                self.update_state();
            }
            _ => {}
        }

        let expired: Vec<u16> = self
            .pending_pings
            .iter()
            .filter(|(_, p)| p.started.elapsed() > PING_TIMEOUT)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in expired {
            if let Some(p) = self.pending_pings.remove(&seq) {
                let _ = p.resp.send(Err(Error::from_reason("Ping timeout")));
            }
        }
    }

    fn update_state(&mut self) {
        // The tunnel is only usable when the WireGuard session is established AND
        // the underlying transport is connected. For UDP `is_connected()` is
        // always true, so this is unchanged; for a WS server it drives the state
        // Ready -> Connecting when the single peer connection drops (and back to
        // Ready once a new peer connects and re-handshakes).
        let ready = self.tunn.time_since_last_handshake().is_some() && self.transport.is_connected();
        self.state_tx.send_if_modified(|state| match (ready, &*state) {
            (true, TunnelState::Connecting) => {
                info!("[WG] handshake complete");
                *state = TunnelState::Ready;
                true
            }
            (false, TunnelState::Ready) => {
                debug!("[WG] session lost, waiting for new handshake");
                *state = TunnelState::Connecting;
                true
            }
            _ => false,
        });
    }

    // --- smoltcp ---

    /// Poll the interface. Ingress is processed one packet at a time so the
    /// LISTEN backlog can be replenished between packets: a burst of concurrent
    /// SYNs larger than `LISTEN_BACKLOG` is absorbed instead of being reset,
    /// because a fresh LISTEN socket is armed before the next SYN is handled.
    fn poll_iface(&mut self) {
        let want_backlog = !self.listeners.is_empty();
        for _ in 0..MAX_INGRESS_PACKETS {
            match self.iface.poll_ingress_single(smol_now(), &mut self.device, &mut self.sockets) {
                PollIngressSingleResult::None => break,
                PollIngressSingleResult::PacketProcessed => { self.stats.ingress_pkts += 1; }
                PollIngressSingleResult::SocketStateChanged => {
                    self.stats.ingress_pkts += 1;
                    if want_backlog {
                        self.ensure_listen_backlog();
                    }
                }
            }
        }
        // Flush everything the sockets want to send.
        for _ in 0..MAX_EGRESS_ROUNDS {
            let before = self.device.tx_queue.len();
            let res = self.iface.poll_egress(smol_now(), &mut self.device, &mut self.sockets);
            let after = self.device.tx_queue.len();
            self.stats.egress_pkts += (after.saturating_sub(before)) as u64;
            if after == before && matches!(res, PollResult::None) {
                break;
            }
        }
    }

    /// Keep `LISTEN_BACKLOG` sockets in the LISTEN state for every listening
    /// port. Sockets that advanced past LISTEN (SynReceived / Established) stay
    /// in the pool until accepted in `process_listeners`; fresh LISTEN sockets
    /// are added to refill, up to `MAX_LISTEN_POOL`. Established server sockets
    /// keep the full-size buffers, so throughput is unaffected.
    fn ensure_listen_backlog(&mut self) {
        let source_ip = self.source_ip;
        for (&port, listener) in self.listeners.iter_mut() {
            let mut listening = 0usize;
            for &handle in listener.pool.iter() {
                let socket = self.sockets.get_mut::<tcp::Socket>(handle);
                match socket.state() {
                    tcp::State::Listen => listening += 1,
                    tcp::State::Closed | tcp::State::TimeWait => {
                        // Aborted handshake: re-arm this slot in place.
                        socket.abort();
                        if socket.listen((IpAddress::Ipv4(source_ip), port)).is_ok() {
                            listening += 1;
                        }
                    }
                    _ => {}
                }
            }
            while listening < LISTEN_BACKLOG && listener.pool.len() < MAX_LISTEN_POOL {
                let mut socket = new_tcp_socket(self.tcp_buffer_size);
                if socket.listen((IpAddress::Ipv4(source_ip), port)).is_err() {
                    break;
                }
                listener.pool.push(self.sockets.add(socket));
                listening += 1;
            }
        }
    }

    fn alloc_local_port(&mut self) -> u16 {
        let port = self.next_local_port;
        self.next_local_port = if port == u16::MAX { EPHEMERAL_PORT_START } else { port + 1 };
        port
    }

    fn process_listeners(&mut self) {
        // Pull established sockets out of the listen pools.
        let mut accepted: Vec<(u16, SocketHandle)> = Vec::new();
        for (&port, listener) in self.listeners.iter_mut() {
            let mut i = 0;
            while i < listener.pool.len() {
                let handle = listener.pool[i];
                match self.sockets.get::<tcp::Socket>(handle).state() {
                    // Still LISTEN, mid-handshake, or awaiting re-arm: keep in pool.
                    tcp::State::Listen | tcp::State::SynReceived | tcp::State::Closed | tcp::State::TimeWait => {
                        i += 1;
                    }
                    // Handshake completed: hand off as an accepted connection.
                    _ => {
                        accepted.push((port, handle));
                        listener.pool.swap_remove(i);
                    }
                }
            }
        }

        for (port, handle) in accepted {
            let (remote_ip, remote_port) = match self.sockets.get::<tcp::Socket>(handle).remote_endpoint() {
                Some(ep) => (ep.addr.to_string(), ep.port),
                None => (String::from("unknown"), 0),
            };

            let Some(listener) = self.listeners.get(&port) else {
                self.sockets.remove(handle);
                continue;
            };

            let id = self.next_conn_id;
            self.next_conn_id = self.next_conn_id.wrapping_add(1).max(1);
            debug!("[LISTEN] accepted connection {} on port {} from {}:{}", id, port, remote_ip, remote_port);

            let ctx = ConnectionContext::Server {
                on_data: listener.on_data.clone(),
                on_close: listener.on_close.clone(),
            };
            listener
                .on_connection
                .call(Ok((id, remote_ip, remote_port)), ThreadsafeFunctionCallMode::NonBlocking);
            self.connections.insert(id, TcpConnection::new(handle, ctx, true));
        }

        // Refill the LISTEN backlog after removing accepted sockets.
        self.ensure_listen_backlog();
    }

    fn process_connections(&mut self) {
        let now = std::time::Instant::now();
        let mut to_remove: Vec<u32> = Vec::new();

        for (&id, conn) in self.connections.iter_mut() {
            let socket = self.sockets.get_mut::<tcp::Socket>(conn.handle);

            if !conn.established {
                match socket.state() {
                    tcp::State::SynSent => {
                        if now >= conn.connect_deadline {
                            socket.abort();
                            if let Some(resp) = conn.connect_resp.take() {
                                let _ = resp.send(Err(Error::from_reason("Connection timed out")));
                            }
                            conn.fail_pending("Connection timed out");
                            to_remove.push(id);
                        }
                        continue;
                    }
                    tcp::State::Closed => {
                        if let Some(resp) = conn.connect_resp.take() {
                            let _ = resp.send(Err(Error::from_reason("Connection refused")));
                        }
                        conn.fail_pending("Connection refused");
                        to_remove.push(id);
                        continue;
                    }
                    state => {
                        debug!("[CONNECT] connection {} established ({})", id, state);
                        conn.established = true;
                        if let Some(resp) = conn.connect_resp.take() {
                            let _ = resp.send(Ok(id));
                        }
                    }
                }
            }

            // While paused we leave the RX queue untouched so the TCP window
            // closes and the peer throttles; buffered data is delivered on resume.
            if !conn.paused && socket.can_recv() {
                let data = drain_recv(socket);
                if !data.is_empty() {
                    trace!("[TCP] connection {} received {} bytes", id, data.len());
                    conn.deliver_data(id, data);
                }
            }

            conn.flush_pending(socket);

            if conn.close_requested && !conn.fin_sent && conn.pending.is_empty() {
                socket.close();
                conn.fin_sent = true;
            }

            // Peer sent FIN (EOF) or connection reset/closed.
            if !socket.may_recv() && !socket.can_recv() {
                if conn.eof_at.is_none() {
                    conn.eof_at = Some(now);
                }
                conn.signal_close(id);
            }

            if let Some(eof_at) = conn.eof_at {
                if !conn.fin_sent && conn.pending.is_empty() && now.duration_since(eof_at) >= HALF_CLOSE_LINGER {
                    debug!("[TCP] connection {} half-closed for too long, closing", id);
                    socket.close();
                    conn.fin_sent = true;
                }
            }

            if matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait) {
                conn.fail_pending("Connection closed");
                conn.signal_close(id);
                to_remove.push(id);
            }
        }

        for id in to_remove {
            if let Some(conn) = self.connections.remove(&id) {
                self.sockets.remove(conn.handle);
            }
        }
    }

    fn process_icmp(&mut self) {
        let caps = ChecksumCapabilities::default();
        let socket = self.sockets.get_mut::<icmp::Socket>(self.icmp_handle);
        while socket.can_recv() {
            let Ok((data, _)) = socket.recv() else { break };
            let Ok(packet) = Icmpv4Packet::new_checked(data) else { continue };
            if let Ok(Icmpv4Repr::EchoReply { ident, seq_no, .. }) = Icmpv4Repr::parse(&packet, &caps) {
                if ident == ICMP_IDENT {
                    if let Some(p) = self.pending_pings.remove(&seq_no) {
                        let elapsed = p.started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
                        let _ = p.resp.send(Ok(elapsed));
                    }
                }
            }
        }
    }

    // --- Commands ---

    fn handle_command(&mut self, cmd: NetworkCommand) -> Flow {
        match cmd {
            NetworkCommand::Connect { dest_ip, dest_port, on_data, on_close, resp } => {
                self.cmd_connect(dest_ip, dest_port, ConnectionContext::Client { on_data, on_close }, resp);
            }
            NetworkCommand::SendData { connection_id, data, resp } => {
                self.cmd_send(connection_id, data, resp);
            }
            NetworkCommand::Close { connection_id } => {
                if let Some(conn) = self.connections.get_mut(&connection_id) {
                    debug!("[TCP] close requested for connection {}", connection_id);
                    conn.close_requested = true;
                }
            }
            NetworkCommand::Pause { connection_id } => {
                if let Some(conn) = self.connections.get_mut(&connection_id) {
                    debug!("[TCP] pausing RX for connection {}", connection_id);
                    conn.paused = true;
                }
            }
            NetworkCommand::Resume { connection_id } => {
                if let Some(conn) = self.connections.get_mut(&connection_id) {
                    debug!("[TCP] resuming RX for connection {}", connection_id);
                    conn.paused = false;
                }
            }
            NetworkCommand::Listen { port, on_connection, on_data, on_close, resp } => {
                let res = self.cmd_listen(port, on_connection, on_data, on_close);
                let _ = resp.send(res);
            }
            NetworkCommand::Ping { dest_ip, resp } => self.cmd_ping(dest_ip, resp),
            NetworkCommand::Shutdown { resp } => return Flow::Shutdown(Some(resp)),
        }
        Flow::Continue
    }

    fn cmd_connect(
        &mut self,
        dest_ip: Ipv4Address,
        dest_port: u16,
        ctx: ConnectionContext,
        resp: oneshot::Sender<Result<u32>>,
    ) {
        let mut socket = new_tcp_socket(self.tcp_buffer_size);
        let local_port = self.alloc_local_port();
        let remote = (IpAddress::Ipv4(dest_ip), dest_port);
        let local = (IpAddress::Ipv4(self.source_ip), local_port);
        debug!("[CONNECT] {}:{} from local port {}", dest_ip, dest_port, local_port);

        if let Err(e) = socket.connect(self.iface.context(), remote, local) {
            let _ = resp.send(Err(Error::from_reason(format!("Connect error: {:?}", e))));
            return;
        }

        let handle = self.sockets.add(socket);
        let id = self.next_conn_id;
        self.next_conn_id = self.next_conn_id.wrapping_add(1).max(1);
        let mut conn = TcpConnection::new(handle, ctx, false);
        conn.connect_resp = Some(resp);
        self.connections.insert(id, conn);
    }

    fn cmd_send(&mut self, connection_id: u32, data: Vec<u8>, resp: oneshot::Sender<Result<()>>) {
        let Some(conn) = self.connections.get_mut(&connection_id) else {
            let _ = resp.send(Err(Error::from_reason(format!("Connection {} not found", connection_id))));
            return;
        };
        if conn.close_requested || conn.fin_sent {
            let _ = resp.send(Err(Error::from_reason("Connection is closing")));
            return;
        }
        if data.is_empty() {
            let _ = resp.send(Ok(()));
            return;
        }
        trace!("[TCP] connection {} queueing {} bytes", connection_id, data.len());
        conn.pending.push_back(PendingSend { data, offset: 0, resp });
        let socket = self.sockets.get_mut::<tcp::Socket>(conn.handle);
        conn.flush_pending(socket);
    }

    fn cmd_listen(
        &mut self,
        port: u16,
        on_connection: ThreadsafeFunction<(u32, String, u16)>,
        on_data: ThreadsafeFunction<(u32, Buffer)>,
        on_close: ThreadsafeFunction<u32>,
    ) -> Result<()> {
        if port == 0 {
            return Err(Error::from_reason("Listen failed: port must not be 0"));
        }
        if self.listeners.contains_key(&port) {
            return Err(Error::from_reason(format!("Listen failed: port {} is already in use", port)));
        }

        let mut pool = Vec::with_capacity(LISTEN_BACKLOG);
        for _ in 0..LISTEN_BACKLOG {
            let mut socket = new_tcp_socket(self.tcp_buffer_size);
            if let Err(e) = socket.listen((IpAddress::Ipv4(self.source_ip), port)) {
                for handle in pool {
                    self.sockets.remove(handle);
                }
                return Err(Error::from_reason(format!("Listen failed: {:?}", e)));
            }
            pool.push(self.sockets.add(socket));
        }

        info!("[LISTEN] listening on {}:{}", self.source_ip, port);
        self.listeners.insert(
            port,
            Listener {
                on_connection,
                on_data,
                on_close,
                pool,
            },
        );
        Ok(())
    }

    fn cmd_ping(&mut self, dest_ip: Ipv4Address, resp: oneshot::Sender<Result<u32>>) {
        let seq = self.ping_seq;
        self.ping_seq = self.ping_seq.wrapping_add(1);

        let repr = Icmpv4Repr::EchoRequest {
            ident: ICMP_IDENT,
            seq_no: seq,
            data: b"PING",
        };
        let socket = self.sockets.get_mut::<icmp::Socket>(self.icmp_handle);
        if !socket.can_send() {
            let _ = resp.send(Err(Error::from_reason("ICMP socket cannot send")));
            return;
        }
        match socket.send(repr.buffer_len(), IpAddress::Ipv4(dest_ip)) {
            Ok(buf) => {
                let mut packet = Icmpv4Packet::new_unchecked(buf);
                repr.emit(&mut packet, &ChecksumCapabilities::default());
                debug!("[PING] echo request seq={} to {}", seq, dest_ip);
                self.pending_pings.insert(
                    seq,
                    PendingPing {
                        resp,
                        started: std::time::Instant::now(),
                    },
                );
            }
            Err(e) => {
                let _ = resp.send(Err(Error::from_reason(format!("ICMP send failed: {:?}", e))));
            }
        }
    }

    // --- Shutdown ---

    async fn shutdown(mut self, resp: Option<oneshot::Sender<()>>) {
        info!("[WG] shutting down");
        for (id, mut conn) in self.connections.drain() {
            let socket = self.sockets.get_mut::<tcp::Socket>(conn.handle);
            socket.abort();
            if let Some(r) = conn.connect_resp.take() {
                let _ = r.send(Err(Error::from_reason("WireShade has been shut down")));
            }
            conn.fail_pending("WireShade has been shut down");
            if conn.established {
                conn.signal_close(id);
            }
        }
        for (_, listener) in self.listeners.drain() {
            for handle in listener.pool {
                self.sockets.get_mut::<tcp::Socket>(handle).abort();
            }
        }
        for (_, p) in self.pending_pings.drain() {
            let _ = p.resp.send(Err(Error::from_reason("WireShade has been shut down")));
        }

        // Emit the RSTs so peers don't keep half-open connections.
        self.poll_iface();
        self.flush_tx().await;
        self.transport.close().await;

        self.state_tx.send_replace(TunnelState::Closed);
        if let Some(resp) = resp {
            let _ = resp.send(());
        }
    }
}

/// Entry point of the network task: async transport setup, then the engine loop.
async fn run_task(
    tunn: Tunn,
    transport_cfg: TransportConfig,
    source_ip: Ipv4Address,
    tcp_buffer_size: usize,
    mut cmd_rx: mpsc::Receiver<NetworkCommand>,
    state_tx: watch::Sender<TunnelState>,
) {
    // Commands arriving during setup are queued and processed afterwards.
    let mut queued: Vec<NetworkCommand> = Vec::new();
    let setup = setup_transport(transport_cfg);
    tokio::pin!(setup);

    let transport = loop {
        tokio::select! {
            res = &mut setup => break res,
            cmd = cmd_rx.recv() => match cmd {
                None => {
                    state_tx.send_replace(TunnelState::Closed);
                    return;
                }
                Some(NetworkCommand::Shutdown { resp }) => {
                    for cmd in queued {
                        cmd.reject("WireShade has been shut down");
                    }
                    state_tx.send_replace(TunnelState::Closed);
                    let _ = resp.send(());
                    return;
                }
                Some(cmd) => queued.push(cmd),
            },
        }
    };

    let engine = transport.and_then(|t| Engine::new(tunn, t, source_ip, tcp_buffer_size, state_tx.clone()));
    match engine {
        Ok(engine) => engine.run(cmd_rx, queued).await,
        Err(msg) => {
            error!("[WG] setup failed: {}", msg);
            for cmd in queued {
                cmd.reject(&msg);
            }
            state_tx.send_replace(TunnelState::Failed(msg));
        }
    }
}

// --- JS-facing API ---

/// Shared handle to the network task.
#[derive(Clone)]
struct TaskHandle {
    cmd_tx: mpsc::Sender<NetworkCommand>,
    state_rx: watch::Receiver<TunnelState>,
}

impl TaskHandle {
    /// Error used when the network task is no longer running.
    fn gone(&self) -> Error {
        match &*self.state_rx.borrow() {
            TunnelState::Failed(msg) => Error::from_reason(format!("WireShade setup failed: {}", msg)),
            _ => Error::from_reason("WireShade has been shut down"),
        }
    }

    async fn send(&self, cmd: NetworkCommand) -> Result<()> {
        self.cmd_tx.send(cmd).await.map_err(|_| self.gone())
    }

    async fn request<T>(&self, cmd: NetworkCommand, rx: oneshot::Receiver<Result<T>>) -> Result<T> {
        self.send(cmd).await?;
        rx.await.map_err(|_| self.gone())?
    }

    async fn send_data(&self, connection_id: u32, data: Buffer) -> Result<()> {
        let (resp, rx) = oneshot::channel();
        let data: Vec<u8> = data.into();
        self.request(NetworkCommand::SendData { connection_id, data, resp }, rx).await
    }

    async fn close(&self, connection_id: u32) -> Result<()> {
        self.send(NetworkCommand::Close { connection_id }).await
    }

    async fn pause(&self, connection_id: u32) -> Result<()> {
        // Best effort: an unknown/closed id or an already-gone task is a no-op.
        let _ = self.send(NetworkCommand::Pause { connection_id }).await;
        Ok(())
    }

    async fn resume(&self, connection_id: u32) -> Result<()> {
        // Best effort: an unknown/closed id or an already-gone task is a no-op.
        let _ = self.send(NetworkCommand::Resume { connection_id }).await;
        Ok(())
    }
}

/// Userspace WireGuard tunnel with an embedded TCP/IP stack.
#[napi]
pub struct WireShade {
    handle: TaskHandle,
}

/// Build a boringtun `Tunn` from base64 key material and a parsed source IP.
/// Shared by every transport factory. `persistentKeepalive` is in seconds
/// (0 / omitted = disabled); the default is unchanged from the UDP path.
fn build_tunnel(
    private_key: &str,
    peer_public_key: &str,
    preshared_key: Option<&str>,
    source_ip: &str,
    persistent_keepalive: Option<u16>,
) -> Result<(Tunn, Ipv4Address)> {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).try_init();

    let private_key_bytes = decode_key(private_key).map_err(|e| Error::from_reason(format!("Invalid private key: {}", e)))?;
    let peer_key_bytes = decode_key(peer_public_key).map_err(|e| Error::from_reason(format!("Invalid peer public key: {}", e)))?;
    let psk_bytes = match preshared_key {
        Some(psk) if !psk.is_empty() => {
            Some(decode_key(psk).map_err(|e| Error::from_reason(format!("Invalid preshared key: {}", e)))?)
        }
        _ => None,
    };
    let source_ip_addr = Ipv4Address::from_str(source_ip).map_err(|_| Error::from_reason(format!("Invalid source IP: {}", source_ip)))?;
    let keepalive = persistent_keepalive.filter(|&k| k > 0);

    let tunn = Tunn::new(private_key_bytes.into(), peer_key_bytes.into(), psk_bytes, keepalive, 0, None)
        .map_err(|e| Error::from_reason(format!("Failed to create WireGuard tunnel: {}", e)))?;
    Ok((tunn, source_ip_addr))
}

#[napi]
impl WireShade {
    /// Spawn the network task for a chosen transport and return the handle.
    /// `tcp_buffer_size` is the already-sanitized per-connection TCP window.
    fn spawn(tunn: Tunn, source_ip: Ipv4Address, tcp_buffer_size: usize, transport_cfg: TransportConfig) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (state_tx, state_rx) = watch::channel(TunnelState::Connecting);
        napi::bindgen_prelude::spawn(run_task(tunn, transport_cfg, source_ip, tcp_buffer_size, cmd_rx, state_tx));
        Self {
            handle: TaskHandle { cmd_tx, state_rx },
        }
    }

    /// Create the tunnel over UDP (today's behavior). Throws only on invalid
    /// keys / source IP; endpoint DNS resolution and the UDP bind happen
    /// asynchronously (see `waitForHandshake`). `persistentKeepalive` is in
    /// seconds (0 / omitted = disabled).
    ///
    /// This positional constructor is kept as-is so the high-level JS API
    /// (`new WireShade(...)`) keeps working; `WireShade.overUdp(...)` is an
    /// alias with identical behavior. The optional trailing `tcpBufferSize`
    /// (bytes) sets the per-connection TCP window (omitted / 0 = 512 KiB
    /// default, clamped to 64 MiB); larger helps saturate high-latency links.
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)] // positional transport args mirror the WireGuard config
    pub fn new(
        private_key: String,
        peer_public_key: String,
        preshared_key: Option<String>,
        endpoint: String,
        source_ip: String,
        listen_port: Option<u16>,
        persistent_keepalive: Option<u16>,
        tcp_buffer_size: Option<u32>,
    ) -> Result<Self> {
        let (tunn, source_ip_addr) =
            build_tunnel(&private_key, &peer_public_key, preshared_key.as_deref(), &source_ip, persistent_keepalive)?;
        let tcp_buffer_size = sanitize_tcp_buffer_size(tcp_buffer_size);
        Ok(Self::spawn(tunn, source_ip_addr, tcp_buffer_size, TransportConfig::Udp { endpoint, listen_port }))
    }

    /// Alias for the positional UDP constructor (`new`), matching the transport
    /// factory naming (`overUdp` / `wsClient` / `wsServer`).
    #[napi(factory)]
    #[allow(clippy::too_many_arguments)] // positional transport args mirror the WireGuard config
    pub fn over_udp(
        private_key: String,
        peer_public_key: String,
        preshared_key: Option<String>,
        endpoint: String,
        source_ip: String,
        listen_port: Option<u16>,
        persistent_keepalive: Option<u16>,
        tcp_buffer_size: Option<u32>,
    ) -> Result<Self> {
        Self::new(private_key, peer_public_key, preshared_key, endpoint, source_ip, listen_port, persistent_keepalive, tcp_buffer_size)
    }

    /// Create the tunnel as a WebSocket client. Connects to `url` (`ws://` or
    /// `wss://`); each WireGuard packet is one binary frame. TLS uses rustls
    /// (system roots by default, a pinned `tls.ca` PEM, or `tls.insecureSkipVerify`
    /// which disables verification and is for tests only).
    #[napi(factory)]
    pub fn ws_client(options: WsClientOptions) -> Result<Self> {
        let (tunn, source_ip_addr) = build_tunnel(
            &options.private_key,
            &options.peer_public_key,
            options.preshared_key.as_deref(),
            &options.source_ip,
            options.persistent_keepalive,
        )?;
        let tls = options.tls.unwrap_or_default();
        let mode = match options.mode.as_deref() {
            Some("wstunnel") => WsClientMode::Wstunnel,
            // `native` (default) or any other value keeps today's behavior.
            _ => WsClientMode::Native,
        };
        let cfg = WsClientConfig {
            url: options.url,
            path_prefix: options.path_prefix,
            headers: options.headers,
            keepalive_sec: options.keepalive_sec.filter(|&s| s > 0).unwrap_or(20),
            tls_ca: tls.ca,
            insecure_skip_verify: tls.insecure_skip_verify.unwrap_or(false),
            mode,
            remote_host: options.remote_host,
            remote_port: options.remote_port,
        };
        let tcp_buffer_size = sanitize_tcp_buffer_size(options.tcp_buffer_size);
        Ok(Self::spawn(tunn, source_ip_addr, tcp_buffer_size, TransportConfig::WsClient(cfg)))
    }

    /// Create the tunnel as a WebSocket server. Binds `listen` (`host:port`) and
    /// accepts one WS client at a time (1:1 peer model); if the connection drops
    /// the tunnel goes Ready -> Connecting and a new client is awaited. TLS is
    /// enabled by providing `tls.cert` + `tls.key` PEM (wss); without it plain
    /// `ws` is served (e.g. behind a TLS-terminating reverse proxy).
    #[napi(factory)]
    pub fn ws_server(options: WsServerOptions) -> Result<Self> {
        let (tunn, source_ip_addr) = build_tunnel(
            &options.private_key,
            &options.peer_public_key,
            options.preshared_key.as_deref(),
            &options.source_ip,
            options.persistent_keepalive,
        )?;
        let tls = options.tls.map(|t| (t.cert, t.key));
        let cfg = WsServerConfig {
            listen: options.listen,
            keepalive_sec: options.keepalive_sec.filter(|&s| s > 0).unwrap_or(20),
            tls,
        };
        let tcp_buffer_size = sanitize_tcp_buffer_size(options.tcp_buffer_size);
        Ok(Self::spawn(tunn, source_ip_addr, tcp_buffer_size, TransportConfig::WsServer(cfg)))
    }

    /// Resolves once the WireGuard handshake has completed (immediately if it
    /// already has). Rejects on timeout (default 10000 ms), setup failure or shutdown.
    #[napi]
    pub async fn wait_for_handshake(&self, timeout_ms: Option<u32>) -> Result<()> {
        let timeout_ms = timeout_ms.unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT_MS);
        let mut rx = self.handle.state_rx.clone();
        let res = tokio::time::timeout(
            Duration::from_millis(u64::from(timeout_ms)),
            rx.wait_for(|s| !matches!(s, TunnelState::Connecting)),
        )
        .await;
        let state = match res {
            Err(_) => return Err(Error::from_reason(format!("WireGuard handshake timed out after {} ms", timeout_ms))),
            Ok(Err(_)) => return Err(self.handle.gone()),
            Ok(Ok(state)) => state.clone(),
        };
        match state {
            TunnelState::Ready => Ok(()),
            TunnelState::Failed(msg) => Err(Error::from_reason(format!("WireShade setup failed: {}", msg))),
            TunnelState::Closed | TunnelState::Connecting => Err(Error::from_reason("WireShade has been shut down")),
        }
    }

    /// Resolves once the WireGuard session is lost, i.e. the tunnel state
    /// leaves `Ready` (Ready -> Connecting on session loss, or -> Failed /
    /// Closed). Resolves immediately if the tunnel is not currently `Ready`
    /// (never handshook, already reconnecting, or shut down). Safe to call
    /// repeatedly and concurrently.
    #[napi]
    pub async fn wait_for_disconnect(&self) -> Result<()> {
        let mut rx = self.handle.state_rx.clone();
        // `wait_for` returns immediately when the predicate already holds and
        // otherwise on the next state change; an error means the sender was
        // dropped (task gone), which is itself a disconnect.
        let _ = rx.wait_for(|s| !matches!(s, TunnelState::Ready)).await;
        Ok(())
    }

    /// Stop the network task. Open connections receive `onClose`, pending
    /// connects/pings/sends are rejected. Idempotent.
    #[napi]
    pub async fn shutdown(&self) -> Result<()> {
        let (resp, rx) = oneshot::channel();
        if self.handle.cmd_tx.send(NetworkCommand::Shutdown { resp }).await.is_ok() {
            let _ = rx.await;
        }
        Ok(())
    }

    /// Open a TCP connection. Resolves once established; rejects on RST or after 10 s.
    #[napi]
    pub async fn connect(
        &self,
        dest_ip: String,
        dest_port: u16,
        on_data: ThreadsafeFunction<Buffer>,
        on_close: ThreadsafeFunction<()>,
    ) -> Result<Connection> {
        let dest_ip = Ipv4Address::from_str(&dest_ip).map_err(|_| Error::from_reason(format!("Invalid destination IP: {}", dest_ip)))?;
        let (resp, rx) = oneshot::channel();
        let id = self
            .handle
            .request(NetworkCommand::Connect { dest_ip, dest_port, on_data, on_close, resp }, rx)
            .await?;
        Ok(Connection {
            id,
            handle: self.handle.clone(),
        })
    }

    /// Listen for incoming TCP connections on the tunnel IP.
    #[napi]
    pub async fn listen(
        &self,
        port: u16,
        on_connection: ThreadsafeFunction<(u32, String, u16)>,
        on_data: ThreadsafeFunction<(u32, Buffer)>,
        on_close: ThreadsafeFunction<u32>,
    ) -> Result<()> {
        let (resp, rx) = oneshot::channel();
        self.handle
            .request(NetworkCommand::Listen { port, on_connection, on_data, on_close, resp }, rx)
            .await
    }

    /// Send data to a connection by ID (client or server). Resolves once all
    /// bytes are queued in the TCP send buffer.
    #[napi]
    pub async fn send_to(&self, connection_id: u32, data: Buffer) -> Result<()> {
        self.handle.send_data(connection_id, data).await
    }

    /// Gracefully close a connection by ID (client or server).
    #[napi]
    pub async fn close_connection(&self, connection_id: u32) -> Result<()> {
        self.handle.close(connection_id).await
    }

    /// Pause inbound delivery on a connection: the engine stops draining its
    /// RX queue, so the TCP window closes and the peer throttles. Data already
    /// buffered is delivered on `resumeConnection`. Unknown/closed id: no-op.
    #[napi]
    pub async fn pause_connection(&self, connection_id: u32) -> Result<()> {
        self.handle.pause(connection_id).await
    }

    /// Resume inbound delivery on a connection paused by `pauseConnection`,
    /// draining already-buffered data through `onData`. Unknown/closed id: no-op.
    #[napi]
    pub async fn resume_connection(&self, connection_id: u32) -> Result<()> {
        self.handle.resume(connection_id).await
    }

    /// Ping an IP via ICMP. Resolves with the round-trip time in ms.
    #[napi]
    pub async fn ping(&self, dest_ip: String) -> Result<u32> {
        let dest_ip = Ipv4Address::from_str(&dest_ip).map_err(|_| Error::from_reason(format!("Invalid destination IP: {}", dest_ip)))?;
        let (resp, rx) = oneshot::channel();
        self.handle.request(NetworkCommand::Ping { dest_ip, resp }, rx).await
    }
}

/// An established client TCP connection.
#[napi]
pub struct Connection {
    id: u32,
    handle: TaskHandle,
}

#[napi]
impl Connection {
    /// The connection id, usable with `pauseConnection`/`resumeConnection`.
    #[napi(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Resolves once all bytes are queued in the TCP send buffer.
    #[napi]
    pub async fn send(&self, data: Buffer) -> Result<()> {
        self.handle.send_data(self.id, data).await
    }

    /// Gracefully close the connection (pending data is sent first).
    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.handle.close(self.id).await
    }
}

fn decode_key(key: &str) -> std::result::Result<[u8; 32], String> {
    let bytes = general_purpose::STANDARD.decode(key.trim()).map_err(|e| e.to_string())?;
    bytes.try_into().map_err(|_| "Key must be 32 bytes".to_string())
}

// --- WebSocket transport options (napi object args) ---

/// Client TLS options for `wsClient`. All fields optional.
#[napi(object)]
#[derive(Default)]
pub struct WsClientTlsOptions {
    /// PEM of a CA / self-signed certificate to trust (pinning). Without it the
    /// system / webpki root store is used.
    pub ca: Option<String>,
    /// SNI server name override. Currently the host of `url` is used for SNI;
    /// this field is reserved for a later round.
    pub servername: Option<String>,
    /// Disable certificate verification entirely. TEST ONLY — never use in production.
    pub insecure_skip_verify: Option<bool>,
}

/// Options for `WireShade.wsClient({...})`.
#[napi(object)]
pub struct WsClientOptions {
    pub private_key: String,
    pub peer_public_key: String,
    pub preshared_key: Option<String>,
    pub source_ip: String,
    /// WireGuard persistent keepalive in seconds (0 / omitted = disabled).
    pub persistent_keepalive: Option<u16>,
    /// Target URL, `ws://host:port` or `wss://host:port`.
    pub url: String,
    /// Optional path appended to the URL (e.g. `v1` -> `/v1`). In `wstunnel`
    /// mode this is the upgrade path prefix (`/<prefix>/events`, default `v1`).
    pub path_prefix: Option<String>,
    /// Extra HTTP headers sent on the upgrade request (disguise / auth).
    pub headers: Option<HashMap<String, String>>,
    /// WebSocket ping keepalive interval in seconds (default 20).
    pub keepalive_sec: Option<u32>,
    pub tls: Option<WsClientTlsOptions>,
    /// Wire protocol: `"native"` (default, WireShade's own framing) or
    /// `"wstunnel"` (wstunnel v2 compatible upgrade so a WireShade client can
    /// reach a wstunnel-style server / the `wireshade bridge`).
    pub mode: Option<String>,
    /// wstunnel mode only: real WireGuard endpoint host the server forwards to
    /// (default `127.0.0.1`). Ignored in native mode.
    pub remote_host: Option<String>,
    /// wstunnel mode only: real WireGuard endpoint port (default `51820`).
    /// Ignored in native mode.
    pub remote_port: Option<u16>,
    /// Per-connection TCP window (RX+TX socket buffer) in bytes. Omitted / 0 =
    /// 512 KiB (default). Larger helps on high-latency links; clamped to 64 MiB.
    pub tcp_buffer_size: Option<u32>,
}

/// Server TLS options for `wsServer`. Providing this enables `wss`.
#[napi(object)]
pub struct WsServerTlsOptions {
    /// Certificate chain PEM.
    pub cert: String,
    /// Private key PEM.
    pub key: String,
}

/// Options for `WireShade.wsServer({...})`.
#[napi(object)]
pub struct WsServerOptions {
    pub private_key: String,
    pub peer_public_key: String,
    pub preshared_key: Option<String>,
    pub source_ip: String,
    /// WireGuard persistent keepalive in seconds (0 / omitted = disabled).
    pub persistent_keepalive: Option<u16>,
    /// Bind address, `host:port`.
    pub listen: String,
    /// Optional expected path prefix (accepted but not enforced in this round).
    pub path_prefix: Option<String>,
    /// WebSocket ping keepalive interval in seconds (default 20).
    pub keepalive_sec: Option<u32>,
    /// TLS cert + key PEM. Omit for plaintext `ws`.
    pub tls: Option<WsServerTlsOptions>,
    /// Per-connection TCP window (RX+TX socket buffer) in bytes. Omitted / 0 =
    /// 512 KiB (default). Larger helps on high-latency links; clamped to 64 MiB.
    pub tcp_buffer_size: Option<u32>,
}

/// A self-signed certificate and its private key, both PEM-encoded.
#[napi(object)]
pub struct CertPair {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Generate a self-signed certificate (and key) for the given subject alternative
/// names, PEM-encoded. Convenience for `wss` test/dev setups without OpenSSL.
#[napi]
pub fn generate_self_signed_cert(subject_alt_names: Vec<String>) -> Result<CertPair> {
    let certified = rcgen::generate_simple_self_signed(subject_alt_names)
        .map_err(|e| Error::from_reason(format!("Failed to generate self-signed certificate: {}", e)))?;
    Ok(CertPair {
        cert_pem: certified.cert.pem(),
        key_pem: certified.key_pair.serialize_pem(),
    })
}
