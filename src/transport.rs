//! Transport abstraction for the WireGuard datagram path.
//!
//! WireGuard is datagram-oriented: every `tunn.encapsulate()` result is sent as
//! one packet and every inbound packet is fed to `tunn.decapsulate()`. This
//! module hides *how* those datagrams travel behind the [`Transport`] trait, so
//! the engine in `lib.rs` is transport-agnostic.
//!
//! Implementations:
//! * [`UdpTransport`] — one UDP datagram = one packet (the original behavior).
//! * [`WsClientTransport`] — one WebSocket binary frame = one packet.
//! * [`WsServerTransport`] — accepts a single WS client at a time, 1:1 peer model.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use log::{debug, info, warn};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async_tls_with_config, Connector, WebSocketStream};

/// Datagram-oriented transport for WireGuard packets.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Send exactly one WireGuard packet (one datagram / one WS binary frame).
    async fn send(&self, packet: &[u8]) -> io::Result<()>;

    /// Receive the next inbound WireGuard packet, blocking until one is available.
    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize>;

    /// Non-blocking receive of an already-available datagram. Used to drain a
    /// burst in one poll cycle. Returns `WouldBlock` when nothing is ready.
    /// Default: never batches.
    fn try_recv(&self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    }

    /// Whether the transport currently has a usable peer connection. UDP is
    /// connectionless and always reports `true`; the WS server reports whether a
    /// client is connected so the tunnel state can follow it.
    fn is_connected(&self) -> bool {
        true
    }

    /// Best-effort clean shutdown.
    async fn close(&self) {}
}

// --- Transport configuration (built by the JS factories) ---

/// Which transport the network task should build during async setup.
pub enum TransportConfig {
    Udp { endpoint: String, listen_port: Option<u16> },
    WsClient(WsClientConfig),
    WsServer(WsServerConfig),
}

/// Resolved options for the WebSocket client transport.
pub struct WsClientConfig {
    pub url: String,
    pub path_prefix: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub keepalive_sec: u32,
    pub tls_ca: Option<String>,
    pub insecure_skip_verify: bool,
}

/// Resolved options for the WebSocket server transport.
pub struct WsServerConfig {
    pub listen: String,
    pub keepalive_sec: u32,
    /// `(cert_pem, key_pem)` enables TLS (wss). `None` => plaintext ws.
    pub tls: Option<(String, String)>,
}

/// Build the chosen transport. Runs inside the network task's setup phase; any
/// error string is surfaced through the tunnel's `Failed` state.
pub async fn setup_transport(cfg: TransportConfig) -> Result<Arc<dyn Transport>, String> {
    match cfg {
        TransportConfig::Udp { endpoint, listen_port } => {
            Ok(Arc::new(UdpTransport::connect(&endpoint, listen_port).await?))
        }
        TransportConfig::WsClient(c) => Ok(Arc::new(WsClientTransport::connect(c).await?)),
        TransportConfig::WsServer(c) => Ok(Arc::new(WsServerTransport::bind(c).await?)),
    }
}

// --- UDP transport (original behavior) ---

pub struct UdpTransport {
    udp: UdpSocket,
}

impl UdpTransport {
    /// Resolve the endpoint and create a connected UDP socket.
    pub async fn connect(endpoint: &str, listen_port: Option<u16>) -> Result<Self, String> {
        debug!("[WG] resolving endpoint {}", endpoint);
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host(endpoint)
            .await
            .map_err(|e| format!("Failed to resolve endpoint '{}': {}", endpoint, e))?
            .collect();
        let endpoint_addr = addrs
            .iter()
            .find(|a| a.is_ipv4())
            .or_else(|| addrs.first())
            .copied()
            .ok_or_else(|| format!("Endpoint '{}' did not resolve to any address", endpoint))?;

        let port = listen_port.unwrap_or(0);
        let bind_addr: SocketAddr = if endpoint_addr.is_ipv4() {
            SocketAddr::from(([0, 0, 0, 0], port))
        } else {
            SocketAddr::from(([0u16; 8], port))
        };
        let udp = UdpSocket::bind(bind_addr)
            .await
            .map_err(|e| format!("Failed to bind UDP socket on {}: {}", bind_addr, e))?;
        udp.connect(endpoint_addr)
            .await
            .map_err(|e| format!("Failed to connect UDP socket to {}: {}", endpoint_addr, e))?;
        match udp.local_addr() {
            Ok(local) => info!("[WG] UDP {} -> {}", local, endpoint_addr),
            Err(_) => info!("[WG] UDP -> {}", endpoint_addr),
        }
        Ok(Self { udp })
    }
}

#[async_trait::async_trait]
impl Transport for UdpTransport {
    async fn send(&self, packet: &[u8]) -> io::Result<()> {
        self.udp.send(packet).await.map(|_| ())
    }

    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            self.udp.readable().await?;
            match self.udp.try_recv(buf) {
                Ok(n) => return Ok(n),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                // e.g. WSAECONNRESET on Windows after an ICMP port unreachable;
                // consume the error and keep waiting for the next datagram.
                Err(_) => continue,
            }
        }
    }

    fn try_recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.udp.try_recv(buf)
    }
}

// --- Shared WebSocket plumbing ---

/// Channels shared by both WS transports. A background task owns the actual
/// socket and moves frames to/from these channels, so `send`/`recv` are simple
/// and cancel-safe (they never touch the socket directly).
struct WsChannels {
    /// Engine -> writer task: outbound WireGuard packets.
    outbound_tx: mpsc::Sender<Vec<u8>>,
    /// Reader task -> engine: inbound WireGuard packets.
    inbound_rx: Mutex<mpsc::Receiver<Vec<u8>>>,
    connected: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl WsChannels {
    async fn recv_into(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut rx = self.inbound_rx.lock().await;
        match rx.recv().await {
            Some(data) => Ok(copy_into(&data, buf)),
            // The reader task ended (connection gone and, for the client, not
            // reconnecting). Park instead of returning so the engine does not
            // busy-loop; `is_connected()` drives the state to Connecting and the
            // timer keeps the loop alive.
            None => {
                std::future::pending::<()>().await;
                unreachable!()
            }
        }
    }

    fn try_recv_into(&self, buf: &mut [u8]) -> io::Result<usize> {
        match self.inbound_rx.try_lock() {
            Ok(mut rx) => match rx.try_recv() {
                Ok(data) => Ok(copy_into(&data, buf)),
                Err(_) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            },
            Err(_) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
        }
    }
}

impl Drop for WsChannels {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn copy_into(data: &[u8], buf: &mut [u8]) -> usize {
    let n = data.len().min(buf.len());
    buf[..n].copy_from_slice(&data[..n]);
    n
}

/// Drive one established WebSocket connection: inbound binary frames go to
/// `inbound_tx`, outbound packets come from `outbound_rx`, and periodic WS pings
/// keep the connection alive through idle proxies. Returns when the connection
/// closes or errors.
async fn pump_ws<S>(
    ws: WebSocketStream<S>,
    outbound_rx: &mut mpsc::Receiver<Vec<u8>>,
    inbound_tx: &mpsc::Sender<Vec<u8>>,
    keepalive: Duration,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut write, mut read) = ws.split();
    let mut ping = tokio::time::interval(keepalive);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            msg = read.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if inbound_tx.send(data).await.is_err() {
                        break; // engine dropped the transport
                    }
                }
                // tokio-tungstenite answers Ping/Close automatically while polling.
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    debug!("[WS] read error: {}", e);
                    break;
                }
            },
            outbound = outbound_rx.recv() => match outbound {
                Some(pkt) => {
                    if let Err(e) = write.send(Message::Binary(pkt)).await {
                        debug!("[WS] write error: {}", e);
                        break;
                    }
                }
                None => break, // transport dropped
            },
            _ = ping.tick() => {
                if write.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = write.close().await;
}

// --- WebSocket client transport ---

pub struct WsClientTransport {
    ch: WsChannels,
}

impl WsClientTransport {
    pub async fn connect(cfg: WsClientConfig) -> Result<Self, String> {
        let mut url = cfg.url.trim_end_matches('/').to_string();
        if let Some(prefix) = &cfg.path_prefix {
            let prefix = prefix.trim_matches('/');
            if !prefix.is_empty() {
                url = format!("{}/{}", url, prefix);
            }
        }
        let secure = url.starts_with("wss://");

        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| format!("Invalid WebSocket URL '{}': {}", url, e))?;
        if let Some(headers) = &cfg.headers {
            for (k, v) in headers {
                let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| format!("Invalid header '{}': {}", k, e))?;
                let value = HeaderValue::from_str(v).map_err(|e| format!("Invalid header value for '{}': {}", k, e))?;
                request.headers_mut().insert(name, value);
            }
        }

        let connector = if secure {
            let tls = build_client_tls(cfg.tls_ca.as_deref(), cfg.insecure_skip_verify)?;
            Some(Connector::Rustls(Arc::new(tls)))
        } else {
            None
        };

        info!("[WS] connecting to {}", url);
        let (ws, _resp) = connect_async_tls_with_config(request, None, false, connector)
            .await
            .map_err(|e| format!("WebSocket connect to '{}' failed: {}", url, e))?;
        info!("[WS] connected to {}", url);

        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(WS_CHANNEL_CAP);
        let (inbound_tx, inbound_rx) = mpsc::channel::<Vec<u8>>(WS_CHANNEL_CAP);
        let connected = Arc::new(AtomicBool::new(true));
        let connected_task = connected.clone();
        let keepalive = Duration::from_secs(u64::from(cfg.keepalive_sec));

        let task = tokio::spawn(async move {
            pump_ws(ws, &mut outbound_rx, &inbound_tx, keepalive).await;
            connected_task.store(false, Ordering::Relaxed);
            debug!("[WS] client connection closed");
        });

        Ok(Self {
            ch: WsChannels {
                outbound_tx,
                inbound_rx: Mutex::new(inbound_rx),
                connected,
                task,
            },
        })
    }
}

#[async_trait::async_trait]
impl Transport for WsClientTransport {
    async fn send(&self, packet: &[u8]) -> io::Result<()> {
        // Backpressure: block until the writer task drains. If the connection is
        // gone the channel is closed; drop the packet (WireGuard will retry).
        let _ = self.ch.outbound_tx.send(packet.to_vec()).await;
        Ok(())
    }

    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.ch.recv_into(buf).await
    }

    fn try_recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.ch.try_recv_into(buf)
    }

    fn is_connected(&self) -> bool {
        self.ch.connected.load(Ordering::Relaxed)
    }

    async fn close(&self) {
        self.ch.task.abort();
    }
}

// --- WebSocket server transport ---

pub struct WsServerTransport {
    ch: WsChannels,
}

impl WsServerTransport {
    pub async fn bind(cfg: WsServerConfig) -> Result<Self, String> {
        let listener = TcpListener::bind(&cfg.listen)
            .await
            .map_err(|e| format!("Failed to bind WebSocket server on '{}': {}", cfg.listen, e))?;
        let local = listener.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| cfg.listen.clone());

        let acceptor = match cfg.tls {
            Some((cert, key)) => {
                let server_cfg = build_server_tls(&cert, &key)?;
                info!("[WS] listening on wss://{}", local);
                Some(tokio_rustls::TlsAcceptor::from(Arc::new(server_cfg)))
            }
            None => {
                info!("[WS] listening on ws://{}", local);
                None
            }
        };

        let (outbound_tx, outbound_rx) = mpsc::channel::<Vec<u8>>(WS_CHANNEL_CAP);
        let (inbound_tx, inbound_rx) = mpsc::channel::<Vec<u8>>(WS_CHANNEL_CAP);
        let connected = Arc::new(AtomicBool::new(false));
        let connected_task = connected.clone();
        let keepalive = Duration::from_secs(u64::from(cfg.keepalive_sec));

        let task = tokio::spawn(server_loop(listener, acceptor, outbound_rx, inbound_tx, connected_task, keepalive));

        Ok(Self {
            ch: WsChannels {
                outbound_tx,
                inbound_rx: Mutex::new(inbound_rx),
                connected,
                task,
            },
        })
    }
}

#[async_trait::async_trait]
impl Transport for WsServerTransport {
    async fn send(&self, packet: &[u8]) -> io::Result<()> {
        // Never block: when no client is connected we drop the packet (like a UDP
        // send to nobody). `try_send` also drops on a momentarily full channel.
        if self.ch.connected.load(Ordering::Relaxed) {
            let _ = self.ch.outbound_tx.try_send(packet.to_vec());
        }
        Ok(())
    }

    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.ch.recv_into(buf).await
    }

    fn try_recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.ch.try_recv_into(buf)
    }

    fn is_connected(&self) -> bool {
        self.ch.connected.load(Ordering::Relaxed)
    }

    async fn close(&self) {
        self.ch.task.abort();
    }
}

/// Accept one client at a time, forever. When a connection drops, drain any
/// stale outbound packets and wait for the next client (1:1 peer model).
async fn server_loop(
    listener: TcpListener,
    acceptor: Option<tokio_rustls::TlsAcceptor>,
    mut outbound_rx: mpsc::Receiver<Vec<u8>>,
    inbound_tx: mpsc::Sender<Vec<u8>>,
    connected: Arc<AtomicBool>,
    keepalive: Duration,
) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                warn!("[WS] accept failed: {}", e);
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        debug!("[WS] client connecting from {}", peer);

        match &acceptor {
            Some(acc) => match acc.accept(stream).await {
                Ok(tls_stream) => match accept_async(tls_stream).await {
                    Ok(ws) => {
                        run_server_conn(ws, &mut outbound_rx, &inbound_tx, &connected, keepalive, peer).await;
                    }
                    Err(e) => debug!("[WS] handshake from {} failed: {}", peer, e),
                },
                Err(e) => debug!("[WS] TLS accept from {} failed: {}", peer, e),
            },
            None => match accept_async(stream).await {
                Ok(ws) => {
                    run_server_conn(ws, &mut outbound_rx, &inbound_tx, &connected, keepalive, peer).await;
                }
                Err(e) => debug!("[WS] handshake from {} failed: {}", peer, e),
            },
        }

        // Discard packets that were queued for the connection that just ended.
        while outbound_rx.try_recv().is_ok() {}
    }
}

async fn run_server_conn<S>(
    ws: WebSocketStream<S>,
    outbound_rx: &mut mpsc::Receiver<Vec<u8>>,
    inbound_tx: &mpsc::Sender<Vec<u8>>,
    connected: &AtomicBool,
    keepalive: Duration,
    peer: SocketAddr,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    info!("[WS] client {} connected", peer);
    connected.store(true, Ordering::Relaxed);
    pump_ws(ws, outbound_rx, inbound_tx, keepalive).await;
    connected.store(false, Ordering::Relaxed);
    info!("[WS] client {} disconnected, awaiting a new connection", peer);
}

const WS_CHANNEL_CAP: usize = 8192;

// --- TLS helpers (rustls, ring provider) ---

fn build_client_tls(ca: Option<&str>, insecure: bool) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());

    if insecure {
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS config error: {}", e))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(danger::NoVerifier::new()))
            .with_no_client_auth();
        return Ok(cfg);
    }

    let mut roots = rustls::RootCertStore::empty();
    match ca {
        Some(pem) => {
            let mut cursor = pem.as_bytes();
            for cert in rustls_pemfile::certs(&mut cursor) {
                let cert = cert.map_err(|e| format!("Invalid CA PEM: {}", e))?;
                roots.add(cert).map_err(|e| format!("Failed to add CA certificate: {}", e))?;
            }
            if roots.is_empty() {
                return Err("tls.ca did not contain any certificate".to_string());
            }
        }
        None => {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
    }

    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS config error: {}", e))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(cfg)
}

fn build_server_tls(cert_pem: &str, key_pem: &str) -> Result<rustls::ServerConfig, String> {
    let mut cert_cursor = cert_pem.as_bytes();
    let certs = rustls_pemfile::certs(&mut cert_cursor)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| format!("Invalid certificate PEM: {}", e))?;
    if certs.is_empty() {
        return Err("tls.cert did not contain any certificate".to_string());
    }

    let mut key_cursor = key_pem.as_bytes();
    let key = rustls_pemfile::private_key(&mut key_cursor)
        .map_err(|e| format!("Invalid private key PEM: {}", e))?
        .ok_or_else(|| "tls.key did not contain a private key".to_string())?;

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS config error: {}", e))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("TLS certificate/key error: {}", e))?;
    Ok(cfg)
}

/// Certificate verifier that accepts everything. TEST ONLY.
mod danger {
    use std::sync::Arc;

    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::CryptoProvider;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    pub struct NoVerifier(Arc<CryptoProvider>);

    impl NoVerifier {
        pub fn new() -> Self {
            Self(Arc::new(rustls::crypto::ring::default_provider()))
        }
    }

    impl ServerCertVerifier for NoVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }
}
