# WireShade – Code Review (2026-09-30)

Status-Legende: `[ ]` offen · `[x]` behoben

## 🔴 Kritisch

- [ ] **K1 – Native Binding lädt nur auf Windows.** `index.js:5-13`, `lib/client.js:5-13` versuchen nur `wireshade.node` bzw. `wireshade.win32-x64-msvc.node`; der Publish-Workflow liefert aber `wireshade.<platform>-<arch>[-<abi>].node` für 6 Targets. Loader doppelt vorhanden.
- [ ] **K2 – Busy-Loop mit 100 % CPU / Task-Leak.** `src/lib.rs:370`: Sobald alle `cmd_tx` gedroppt sind, liefert `cmd_rx.recv()` sofort `None`, wird ignoriert → Endlosschleife. Kein Shutdown-Mechanismus; `close()`/`reconnect()` lassen alte Tasks (UDP-Socket, Heartbeats) weiterlaufen.
- [ ] **K3 – Datenverlust bei Partial-Send.** `src/lib.rs:431`, `:628`, `:768`: `send_slice` nimmt ggf. weniger Bytes an, Rest wird verworfen; `buffers.drain(..)` verwirft beim Flush alles, was nicht passt.
- [ ] **K4 – Panic ab 32 Sockets.** `src/lib.rs:208`: `SocketSet` auf festem 32er-Array → `add()` panict. Außerdem `expect()`s in `:198-203` töten den Task still.
- [ ] **K5 – Hardcodierter Heartbeat an `10.245.1.1`.** `src/lib.rs:340-369`: Dummy-UDP-Paket alle 5 s an eine fixe IP (Test-Setup-Artefakt). Stattdessen `persistent_keepalive` von `Tunn::new` nutzen (`PersistentKeepalive` aus der Config).
- [ ] **K6 – Callbacks doppelt.** `lib/client.js:225-227` registriert `onConnect/onDisconnect/onReconnect` als Listener *und* ruft sie in `_onConnected`/`_handleConnectionError`/`close` zusätzlich direkt auf.
- [ ] **K7 – `logging: false` wirkungslos.** `lib/client.js:315`, `:623` übergeben `this.logging` (undefined) statt `this.config.logging`.

## 🟠 Performance

- [ ] **P1 – 10-ms-Polling-Loop.** `src/lib.rs:671`: ≥100 Wakeups/s im Leerlauf, jedes Mal Iteration über alle Connections/Listener. → `iface.poll_delay()` als Timeout, `update_timers` gedrosselt (~250 ms).
- [ ] **P2 – `eprintln!` + `stderr().flush()` im Hot-Path.** 3–4 Zeilen pro Chunk, Flush pro UDP-Paket. → `log::debug!/trace!` + `env_logger` (via `RUST_LOG`).
- [ ] **P3 – `try_send` droppt UDP-Pakete.** `src/lib.rs:446`, `:644`, `:833` → einheitlich `send().await`.
- [ ] **P4 – TCP-Buffer 64 KB.** Limitiert Durchsatz auf 64 KB/RTT → größere Buffer (z. B. 512 KB).
- [ ] **P5 – Nur ein UDP-Paket pro Loop-Iteration**, danach Full-Poll + O(n)-Iteration. → mit `try_recv` alles Anliegende drainen, dann einmal pollen.
- [ ] **P6 – Unnötige Kopien/Allokationen.** `:698/:701` Doppelkopie, `:287/:573` 64-KB-Array pro Schleife neu genullt, `:350` Vec pro Heartbeat.
- [ ] **P7 – Kein Backpressure.** `SendData` bestätigt beim Enqueue; `pending_data` wächst unbegrenzt; `stream.push()`-Rückgabewert ignoriert.

## 🟡 Sonstiges

- [ ] **S1 – Fake-„connected“.** `lib/client.js:327` meldet nach 1 s Timer Erfolg; `connect()` resolved vor TCP-Handshake (`src/lib.rs:414`), RST/Timeout erreichen JS nie.
- [ ] **S2 – Remote-FIN wird nicht signalisiert.** `on_close` nur bei `State::Closed` (`:714`); bei `CloseWait` bekommt JS kein EOF.
- [ ] **S3 – Listener-Backlog = 1.** Nur ein Listen-Socket pro Port; gleichzeitige SYNs → RST.
- [ ] **S4 – Blockierendes DNS im Konstruktor** (`:186`, `to_socket_addrs()` auf JS-Main-Thread).
- [ ] **S5 – `client.request()`**: `data += c` zerstört Multibyte-UTF-8/Binärdaten, kein Statuscode, kein `res.on('error')`.
- [ ] **S6 – Server-Stream** überschreibt `destroy`/`end` (`lib/server.js:907-923`) und umgeht Duplex-Semantik (`destroyed`, `close`-Event).
- [ ] **S7 – Aufräumen.** Toter Code (`type_name`, TCP-Flag-Analyse, `ListenerInfo.port`), ungenutzte Crates (`bytes`, `thiserror`, `hex`), „exactly like river“-Kommentare, `npm test` → nicht existierendes `test.js`.

---

## Schnittstellen-Vertrag Rust ⇄ JS (für die Fixes)

Native Klasse `WireShade` (napi, camelCase in JS):

| Methode | Verhalten |
|---|---|
| `new WireShade(privateKey, peerPublicKey, presharedKey?, endpoint, sourceIp, listenPort?, persistentKeepalive?)` | Wirft nur bei ungültigen Keys/IP. Endpoint-DNS + UDP-Bind laufen asynchron im Task (kein Blocking, kein Panic). `persistentKeepalive` in Sekunden (`Option<u16>`), wird an `Tunn::new` übergeben. |
| `waitForHandshake(timeoutMs?: number): Promise<void>` | Resolved, sobald der WireGuard-Handshake abgeschlossen ist (sofort, falls schon fertig). Rejected bei Timeout (Default 10000 ms) oder wenn der Task beim Setup scheitert (DNS/Bind) – mit aussagekräftiger Fehlermeldung. Mehrfach aufrufbar. |
| `shutdown(): Promise<void>` | Beendet den Netzwerk-Task sauber; alle offenen Connections bekommen `onClose`, offene Pings/Connects werden rejected. Danach schlagen alle Methoden fehl. Idempotent. |
| `connect(ip, port, onData, onClose): Promise<Connection>` | Resolved erst bei `Established`; rejected bei RST/Timeout (10 s). |
| `onClose` (client + server) | Feuert, wenn die Gegenseite schließt (EOF / `!may_recv()`), bei RST oder bei `Closed` – genau einmal pro Connection. |
| `send`/`sendTo` | Resolved erst, wenn die Daten vollständig im smoltcp-TX-Buffer liegen (echtes Backpressure); kein Datenverlust. |
| `listen`, `closeConnection`, `ping` | Wie bisher. |

`index.d.ts` wird an diesen Vertrag angepasst.

---

## Offene Punkte – Runde 2 (Contract)

- [ ] **O1 – Tunnel-Drop nach Handshake wird nicht signalisiert.**
  Native: neuer Methoden-Contract `waitForDisconnect(): Promise<void>`, der resolved,
  sobald der Watch-State von `Ready` weg wechselt (Ready→Connecting/Failed/Closed),
  d. h. WireGuard-Session verloren. Mehrfach aufrufbar; nach Shutdown resolved er sofort.
  JS (`client.js`): nach erfolgreichem `waitForHandshake()` ein `waitForDisconnect()`
  starten; beim Resolve (sofern nicht durch `close()`/Reconnect ausgelöst) →
  `_handleConnectionError(new Error('tunnel lost'))` → normaler Reconnect-Pfad.
- [ ] **O2 – Server werden nach Reconnect nicht neu erstellt.**
  JS (`client.js`): `listen()`-Aufrufe (port + onConnection + Optionen) in einer Liste
  merken. Nach erfolgreichem Reconnect (`_onConnected`, `wasReconnecting`) alle
  gemerkten Server auf der neuen `gw`-Instanz erneut `listen()`en. Die alten
  Server-Objekte auf 'close' beenden. `forwardRemote` läuft über `listen` und ist damit
  automatisch abgedeckt; `forwardLocal` (lokaler net.Server) muss nicht neu gebaut werden.
- [ ] **O3 – Inbound-Flow-Control (echtes Backpressure Richtung JS).**
  Native: `pauseConnection(id): Promise<void>` / `resumeConnection(id): Promise<void>`.
  Pausiert = die Engine liest die betreffende smoltcp-RX-Queue nicht mehr leer → das
  TCP-Window schließt sich → Gegenseite drosselt. Resume nimmt das Lesen wieder auf
  (inkl. bereits gepufferter Daten). Unbekannte/geschlossene ID: no-op-resolve.
  JS (`agent.js`, `server.js`): wenn `stream.push(buf)` `false` liefert →
  `gw.pauseConnection(id)`; auf dem Duplex `read()`/`_read` bzw. `'drain'` →
  `gw.resumeConnection(id)`. Kommentar-Platzhalter aus P7 ersetzen.

persistentKeepalive-Default (25 s) bleibt wie ist – NICHT ändern.
