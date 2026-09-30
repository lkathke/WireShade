# WireShade – WebSocket-Transport (WS / WSS) · Konzept

Ziel: WireGuard nicht nur über UDP, sondern auch über eine WebSocket-Verbindung
tunneln. Unterstützt werden soll:

1. **WS und WSS** (Klartext und TLS).
2. **wstunnel-Kompatibilität** – WireShade als WS-*Client* gegen einen unveränderten
   `wstunnel server`, und WireShade als WS-*Server*, der wstunnel-*Clients* annimmt.
3. **WireShade ⇄ WireShade** – eigener WS-Server und WS-Client (wie `local_vpn.js`,
   nur über WebSocket statt UDP).
4. **Beispiel-Skript**, das ein Self-Signed-Zertifikat erzeugt, es auf beiden Seiten
   zulässt und einen WSS-Server + -Client aufbaut.

Referenz-Tool: [`wstunnel`](https://github.com/erebe/wstunnel) (v2, Rust).

---

## 1. Kernidee: ein `Transport`-Trait

Heute ist der UDP-Socket in `src/lib.rs` fest verdrahtet: jedes
`tunn.encapsulate()`-Ergebnis geht per `udp_socket.send()` raus, jedes
`udp_socket.recv()` in `tunn.decapsulate()`. Das ist die einzige Naht, die sich
ändert. Wir ziehen eine Abstraktion ein – **datagram-orientiert**, weil WireGuard
in Datagrammen denkt:

```rust
// src/transport/mod.rs
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Ein WireGuard-Paket rausschicken (genau ein Datagramm / ein WS-Binary-Frame).
    async fn send(&self, packet: &[u8]) -> io::Result<()>;
    /// Nächstes eingehendes WireGuard-Paket (blockiert bis Daten da sind).
    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize>;
    /// Sauberes Schließen.
    async fn close(&self) -> io::Result<()> { Ok(()) }
}
```

Implementierungen:

| Impl | Rolle | Framing |
|---|---|---|
| `UdpTransport` | bisher | 1 UDP-Datagramm = 1 Paket |
| `WsClientTransport` | Client | 1 Binary-Frame = 1 Paket |
| `WsServerTransport` | eine akzeptierte Server-Verbindung | 1 Binary-Frame = 1 Paket |

Der große Loop in `lib.rs` bekommt statt `udp_socket: UdpSocket` ein
`transport: Arc<dyn Transport>`. `udp_socket.send(b).await` → `transport.send(b).await`,
`udp_socket.recv(&mut buf).await` → `transport.recv(&mut buf).await`. **Sonst ändert
sich am WireGuard-/smoltcp-Teil nichts.** Schritt 1 ist reines Refactoring (UDP hinter
den Trait schieben, Verhalten identisch), erst Schritt 2 bringt WebSocket.

> Hinweis WS ist message-basiert – das Reassembly-Problem von ICMP/DNS entfällt.
> Ein `ws.send(Binary(paket))` überträgt genau ein WireGuard-Paket. Für WireShade↔WireShade
> ist das trivial; für wstunnel-Kompatibilität gilt exakt dasselbe Framing (UDP-Modus).

---

## 2. Das wstunnel-Wire-Protokoll (verifiziert gegen `main`)

Damit WireShade mit einem echten `wstunnel server` bzw. `wstunnel client` spricht,
müssen wir dessen Handshake exakt nachbauen. Aus dem Quellcode:

**Upgrade-Request (Client → Server):**

```
GET /<http-upgrade-path-prefix>/events HTTP/1.1
Host: <http_header_host>
Upgrade: websocket
Connection: upgrade
Sec-WebSocket-Key: <base64 16 random bytes>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: v1, authorization.bearer.<JWT>
Authorization: <optional, wenn --http-upgrade-credentials gesetzt>
```

- `<http-upgrade-path-prefix>` ist frei wählbar (Default in wstunnel:
  `v1`), dient als schwaches Auth-Token, muss auf beiden Seiten gleich sein.
- Das eigentliche Tunnelziel steckt im **`Sec-WebSocket-Protocol`** als
  `authorization.bearer.<JWT>` (Prefix-Konstante `JWT_HEADER_PREFIX =
  "authorization.bearer."`, Subprotokoll-Version-Tag `v1`).

**Der JWT** (HS256, aber serverseitig via `insecure_decode()` **ohne
Signaturprüfung** → Secret irrelevant, beliebig signierbar). Claims:

```json
{
  "id": "<uuid v7>",                       // Tunnel-ID
  "p":  { "Udp": { "timeout": null } },    // LocalProtocol (serde) – für WG immer UDP
  "r":  "<remote host des echten WG-Servers>",
  "rp": 51820                              // remote port
}
```

- `p` = `LocalProtocol`-Enum, serde-serialisiert. Für unseren Fall **immer UDP**.
  ⚠️ Die genaue serde-Form von `timeout` (`null` vs. `{"secs":..,"nanos":..}`) ist ein
  internes, unversioniertes Detail – beim Implementieren gegen die tatsächlich
  eingesetzte wstunnel-Version pinnen (Integrationstest, siehe §8). Der `v1`-Tag im
  Subprotokoll ist der stabile Versionsmarker.

**Frames:** Binary. Client maskiert (Standard-WS-Client-Verhalten,
`websocket_mask_frame`). Im UDP-Modus gilt **ein Binary-Frame = ein UDP-Datagramm** –
also genau ein WireGuard-Paket. Rückverkehr identisch über dieselbe WS-Verbindung.

**Konsequenz für WireShade:**
- *Client gegen wstunnel-Server* (Topologie A): WireShade baut diesen Request,
  füllt `r`/`rp` mit dem echten WG-Endpoint, und schiebt WG-Pakete als Binary-Frames.
- *Server für wstunnel-Clients* (Topologie C): WireShade akzeptiert `/…/events`,
  parst `Sec-WebSocket-Protocol`, decodiert den JWT (ohne Prüfung), und bridged die
  Frames als UDP an `r:rp`.

---

## 3. Deployment-Topologien

```
A) WireShade-Client  ──WSS──▶  wstunnel server (VPS)  ──UDP──▶  wg (kernel) :51820
   [WsClientTransport, wstunnel-compat]                         echter WG-Server

B) WireShade-Client  ──WSS──▶  WireShade-Server (VPS)
   beide Enden sind WireShade-Peers; der Server TERMINIERT den WG-Tunnel selbst
   (WS-Frames werden direkt in den lokalen Tunn/smoltcp gefüttert). → local_vpn über WSS.

C) wstunnel client   ──WSS──▶  WireShade-Server (bridge)  ──UDP──▶  wg :51820
   WireShade ersetzt den wstunnel-Binary auf dem VPS.
```

- **A** braucht nur den **WS-Client**. Wichtigster Interop-Fall.
- **B** braucht **WS-Server + WS-Client**, beide „native“ (eigenes, einfaches Framing –
  wir können hier auch den wstunnel-Handshake benutzen, damit nur *ein* Codepfad
  existiert; `r`/`rp` werden dann ignoriert bzw. auf einen Loopback-Marker gesetzt).
- **C** braucht den **WS-Server im wstunnel-Emulationsmodus** (JWT parsen → UDP-Bridge).

Empfehlung: **einen** Server-Handshake implementieren (wstunnel-kompatibel), und über
`p`/`r`/`rp` entscheiden, ob terminiert (B) oder gebridged (C) wird.

---

## 4. TLS (WSS)

- Bibliothek: **`tokio-tungstenite`** mit **`rustls`** (`tokio-tungstenite = { features
  = ["rustls-tls-webpki-roots"] }`), plus `tokio-rustls` für den Server-Accept.
  (wstunnel selbst nutzt `fastwebsockets`; für Interop ist nur das *Wire*-Format
  relevant, nicht die Lib.)
- **Client:**
  - `wss://` → TLS. Vertrauensanker: System-Roots **oder** ein gepinntes CA/Cert aus
    der Config (`tls.ca` = PEM). Für Self-Signed-Setups (Beispiel) pinnen wir das Cert.
  - Option `tls.insecureSkipVerify` (nur für Tests, laut dokumentieren).
  - SNI aus dem Host des `wss://`-URL bzw. `tls.servername`.
- **Server:**
  - Cert + Key als PEM (`tls.cert`, `tls.key`).
  - `ws://` = ohne TLS (Klartext, z. B. hinter einem Reverse-Proxy, der TLS terminiert).

**Zertifikatserzeugung** stellen wir als napi-Helper bereit, damit das Beispiel ohne
`openssl`-Abhängigkeit läuft (Crate `rcgen`):

```rust
#[napi]
pub fn generate_self_signed_cert(subject_alt_names: Vec<String>) -> Result<CertPair> {
    // rcgen::generate_simple_self_signed(subject_alt_names)
    // -> CertPair { cert_pem: String, key_pem: String }
}
```

---

## 5. API-Design

### Config-Erweiterung (`WireShadeClient`)

Der Transport wird optional; ohne Angabe bleibt es beim heutigen UDP-Verhalten.

```js
new WireShadeClient({
  wireguard: { privateKey, peerPublicKey, endpoint, sourceIp, /* … */ },
  transport: {
    type: 'websocket',            // 'udp' (default) | 'websocket'
    url: 'wss://vpn.example.com:443',
    pathPrefix: 'v1',             // muss zu Server passen (wstunnel: --http-upgrade-path-prefix)
    mode: 'wstunnel',             // 'wstunnel' (default) | 'native'
    // im wstunnel-Modus: wohin der Server das UDP weiterreicht (= echter WG-Endpoint):
    remoteHost: '10.0.0.1', remotePort: 51820,
    headers: { 'User-Agent': '…' },     // getarnte Zusatz-Header
    credentials: 'user:pass',           // -> Authorization-Header (optional)
    tls: {
      ca: fs.readFileSync('server.crt', 'utf8'),  // Self-Signed pinnen
      servername: 'vpn.example.com',
      insecureSkipVerify: false
    },
    keepaliveIntervalSec: 20            // WS ping/pong gegen Proxy-Idle-Timeouts
  }
});
```

Bei `endpoint` + `transport.type==='websocket'`+`mode==='wstunnel'` wird `endpoint`
automatisch als `remoteHost:remotePort` übernommen (weniger Redundanz).

### WS-Server (neu: `WireShadeWsServer`)

```js
const { WireShadeWsServer, generateSelfSignedCert } = require('wireshade');

const srv = new WireShadeWsServer({
  listen: '0.0.0.0:443',
  pathPrefix: 'v1',
  tls: { cert, key },                 // weglassen => ws:// (Klartext)
  // Topologie B: dieser Server IST ein WireShade-WG-Peer
  wireguard: { privateKey, peerPublicKey, sourceIp, /* … */ },
  // ODER Topologie C: reine Bridge zu einem echten WG-Server
  // bridge: { allowTargets: ['127.0.0.1:51820'] }
});
await srv.start();
```

### Native (napi) Oberfläche

Der `WireShade`-Konstruktor bekommt statt der UDP-Endpoint-Strings ein
Transport-Descriptor-Objekt (oder eine zweite Factory `WireShade.overWebsocket(...)`),
damit der Tokio-Task den passenden `Arc<dyn Transport>` baut. `index.d.ts` entsprechend
erweitern.

---

## 6. `.conf`-Erweiterung (optional, wstunnel-freundlich)

WireGuard-`.conf` kennt keine WS-Felder. Wir lesen einen Kommentar-Header, den
`config_parser.js` extrahiert, damit Standard-`wg`-Tools die Datei ignorieren:

```ini
[Interface]
PrivateKey = ...
Address = 10.0.0.2/32
# WireShade-Transport: wss://vpn.example.com:443/v1  mode=wstunnel

[Peer]
PublicKey = ...
Endpoint = 10.0.0.1:51820      # remoteHost:remotePort für den WS-Server
```

---

## 7. Beispiel-Skript (Cert-Gen + WSS-Server + Client)

`examples/11_websocket_wss.js` (Topologie B, beide Enden WireShade, self-signed, gepinnt):

```js
const { WireShadeClient, WireShadeWsServer,
        generateKeyPair, generateSelfSignedCert } = require('../index.js');

async function main() {
  // 1) Self-Signed-Zertifikat für 'localhost'
  const { certPem, keyPem } = generateSelfSignedCert(['localhost', '127.0.0.1']);

  // 2) WireGuard-Keys für beide Peers
  const server = generateKeyPair();
  const client = generateKeyPair();

  // 3) WSS-Server (Peer B) – terminiert TLS UND den WG-Tunnel
  const wsServer = new WireShadeWsServer({
    listen: '127.0.0.1:8443',
    pathPrefix: 'v1',
    tls: { cert: certPem, key: keyPem },
    wireguard: {
      privateKey: server.privateKey,
      peerPublicKey: client.publicKey,
      sourceIp: '10.0.0.1'
    }
  });
  await wsServer.start();
  wsServer.listen(8080, (sock) => {           // TCP-Dienst im Tunnel
    sock.on('data', () => sock.end('pong'));
  });

  // 4) WSS-Client (Peer A) – trusted das self-signed Cert per Pinning
  const wsClient = new WireShadeClient({
    wireguard: {
      privateKey: client.privateKey,
      peerPublicKey: server.publicKey,
      sourceIp: '10.0.0.2'
    },
    transport: {
      type: 'websocket',
      url: 'wss://127.0.0.1:8443',
      pathPrefix: 'v1',
      mode: 'native',
      tls: { ca: certPem, servername: 'localhost' }
    }
  });
  await wsClient.start();                      // wartet auf echten WG-Handshake über WSS

  // 5) durch den Tunnel reden
  const conn = wsClient.connect({ host: '10.0.0.1', port: 8080 });
  conn.on('connect', () => conn.write('ping'));
  conn.on('data', (d) => { console.log('Antwort:', d.toString()); process.exit(0); });
}
main();
```

Zweite Variante `examples/12_wstunnel_compat.js`: nur WS-*Client* gegen einen extern
gestarteten `wstunnel server` (`wstunnel server wss://0.0.0.0:8443
--restrict-http-upgrade-path-prefix v1`), `mode: 'wstunnel'`, `remoteHost/remotePort`
= echter WG-Server. Kommando im Header dokumentieren.

---

## 8. Tests

- **Unit:** JWT-Bau (Claims-Form), Upgrade-Request-Bytes, Frame-Split
  (1 Frame = 1 Paket).
- **Integration native (B):** wie `test/loopback.test.js`, aber Transport `websocket`
  über `wss://127.0.0.1` mit generiertem Cert – Handshake, Ping, 5-MB-Transfer,
  sauberes Shutdown.
- **Integration wstunnel-compat (A/C):** wenn `wstunnel`-Binary im PATH, in CI einen
  echten `wstunnel server` starten und WireShade-Client dagegen fahren (und umgekehrt
  WireShade-Server ↔ `wstunnel client`). Dieser Test pinnt die genaue `p`-Serialisierung
  gegen die installierte wstunnel-Version. Fehlt das Binary → Test überspringen (skip).

---

## 9. Abhängigkeiten (Cargo)

| Crate | Zweck |
|---|---|
| `tokio-tungstenite` (+`rustls-tls-webpki-roots`) | WS/WSS Client & Server |
| `tokio-rustls`, `rustls`, `rustls-pemfile` | TLS-Server-Accept, PEM laden |
| `rcgen` | Self-Signed-Cert-Helper |
| `jsonwebtoken` | wstunnel-JWT bauen/lesen |
| `async-trait` | `Transport`-Trait |
| `http` | Upgrade-Header bauen |
| `uuid` (v7) | Tunnel-`id` |

Die ungenutzten Crates (`bytes`, `thiserror`, `hex`) aus dem laufenden Cleanup können
teils hier wiederverwendet werden.

---

## 10. Bekannte Trade-offs

- **TCP-over-TCP-Meltdown:** WireGuard trägt meist TCP; läuft es in einem TCP-Tunnel
  (WS), stauen sich innere und äußere Retransmits bei Paketverlust. Bei stabiler
  Leitung kaum spürbar, bei Jitter/Verlust deutlicher Durchsatzeinbruch. Für
  „muss durchkommen“ akzeptabel, für Max-Speed UDP bevorzugen.
- **MTU:** WS-/TLS-Overhead → WireGuard-MTU ggf. leicht senken (z. B. 1380), damit
  ein WG-Paket sicher in ein Frame/Segment passt.
- **Idle-Timeouts:** Proxies/CDNs killen stille Verbindungen → WS ping/pong
  (`keepaliveIntervalSec`) plus WireGuard-`PersistentKeepalive`.
- **Reconnect:** Bricht die WS-Verbindung, muss der Transport neu verbinden; der
  bestehende Reconnect-Layer in `client.js` greift, solange `waitForHandshake` erst
  nach erfolgreichem WS-Connect + WG-Handshake resolved.

---

## 11. Umsetzungsreihenfolge

1. `Transport`-Trait einziehen, UDP-Pfad dahinter (reines Refactoring, kein Verhaltensänderung).
2. `WsClientTransport` (native Framing) + `WireShadeWsServer` (native) → Topologie B, `ws://`.
3. TLS/`rcgen`-Helper → `wss://`, Beispiel `11_websocket_wss.js`.
4. wstunnel-Handshake (JWT + Sec-WebSocket-Protocol + `/…/events`) → Topologie A, Beispiel `12`.
5. Server-Emulationsmodus (JWT parsen → UDP-Bridge) → Topologie C.
6. Integrationstests inkl. optionalem echten `wstunnel`-Binary.

---

## Umsetzungs-Contract – Runde WS-1 (native WS/WSS, ohne wstunnel)

Scope: Konzept-Schritte 1–3. wstunnel-Kompat (4–6) NICHT in dieser Runde.

**Peer-Modell:** 1:1 (ein Tunn, ein Peer) wie heute. Ein WS-Server nimmt genau eine
aktive Client-Verbindung an; bricht sie ab, wartet er auf eine neue (und der bestehende
Watch-State geht Ready→Connecting, damit O1/Reconnect greifen).

**Schritt 1 – `Transport`-Trait (reines Refactoring):** UDP hinter
`trait Transport { async send(&[u8]); async recv(&mut [u8]) -> usize; async close(); }`
schieben. Verhalten identisch, alle 16 Tests bleiben grün, Benchmark-Baseline unverändert.

**Schritt 2/3 – WS-Client + WS-Server + TLS:**
- `WsClientTransport`: verbindet `ws://host:port/<path>` bzw. `wss://…`; 1 Binary-Frame =
  1 WireGuard-Paket. WS ping/pong Keepalive. `tokio-tungstenite` + `rustls`.
- `WsServerTransport`: bindet `host:port`, akzeptiert eine WS-Verbindung, Frames rein/raus.
  TLS optional (cert+key → wss; ohne → ws hinter Reverse-Proxy). **Beide Modelle** (ws + wss).
- `generateSelfSignedCert(altNames: string[]) -> { certPem, keyPem }` via `rcgen` (napi).

**JS-sichtbarer Contract (native Ebene):** Der `WireShade`-Konstruktor bekommt eine
Transport-Auswahl. Vorschlag: zusätzliche Factory-Methoden statt den positionalen
Konstruktor weiter aufzublähen:
- `WireShade.overUdp(privateKey, peerPublicKey, presharedKey?, endpoint, sourceIp, listenPort?, persistentKeepalive?)` (= heutiges Verhalten; alter Konstruktor bleibt als Alias erhalten, damit `lib/*.js` unverändert weiterläuft).
- `WireShade.wsClient({ privateKey, peerPublicKey, presharedKey?, sourceIp, persistentKeepalive?, url, pathPrefix?, headers?, keepaliveSec?, tls?: { ca?, servername?, insecureSkipVerify? } }): WireShade`
- `WireShade.wsServer({ privateKey, peerPublicKey, presharedKey?, sourceIp, persistentKeepalive?, listen: "host:port", pathPrefix?, tls?: { cert, key } }): WireShade`
Alle drei liefern dasselbe `WireShade`-Objekt mit identischer Methodenoberfläche
(`waitForHandshake`, `connect`, `listen`, `ping`, `pause/resumeConnection`,
`waitForDisconnect`, `shutdown`). Die High-Level-JS-API (`transport:{…}` in
WireShadeClient, `WireShadeWsServer`) kommt in einer separaten JS-Runde DANACH.

**Beweis:** `examples/11_websocket_wss.js` (Cert-Gen + wsServer + wsClient über wss,
Self-Signed gepinnt) läuft end-to-end (Handshake, TCP-Echo). Und `bench/throughput.js`
mit `BENCH_TRANSPORT=wss` liefert eine Zahl.

Nicht ändern: persistentKeepalive-Default (25 s), UDP-Verhalten, die 16 grünen Tests.
