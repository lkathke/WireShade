# WireShade Examples

This directory contains example scripts demonstrating various capabilities of the WireShade library.

## Getting Started

1.  Ensure you have a valid `wireguard.conf` in this directory (or update the scripts to point to one).
2.  Run the examples using `node examples/<filename>`.

## Available Examples

### 1. Quickstart (`01_quickstart.js`)
The "Hello World" of WireShade. Shows how to initialize the connection, perform a simple request, and start a listener.
- **Run:** `node examples/01_quickstart.js`

### 2. HTTP Request (`02_http_request.js`)
Performs a simple HTTP GET request to an internal web server using the simplified `gw.get()` API.
- **Run:** `node examples/02_http_request.js`

### 3. HTTPS & Custom DNS (`03_https_custom_dns.js`)
Demonstrates how to access an HTTPS server with a custom hostname (`internal.service.lan`) mapped to an internal IP.
- **Run:** `node examples/03_https_custom_dns.js`

### 4. Raw TCP Socket (`04_tcp_socket.js`)
Shows low-level usage to send raw data bytes (HTTP request manually constructed) and receive raw bytes, bypassing higher-level helpers.
- **Run:** `node examples/04_tcp_socket.js`

### 5. Internet Routing (`05_internet_routing.js`)
Tests routing to the public internet by fetching your IP from `ifconfig.me`. Confirms that traffic exits via the WireGuard VPN gateway.
- **Run:** `node examples/05_internet_routing.js`

### 6. Simple Server (`06_simple_server.js`)
Host a basic HTTP server inside the VPN tunnel. 
- **Run:** `node examples/06_simple_server.js`

### 7. Express App (`07_express_app.js`)
Run a full Express.js application and make it accessible via the VPN tunnel (Reverse Tunneling).
- **Run:** `node examples/07_express_app.js`

### 8. Local Forwarding (`08_local_forwarding.js`)
Starts a local TCP server on port `8080` that forwards all traffic to an internal host (`10.0.0.5:80`).
- **Run:** `node examples/08_local_forwarding.js`

### 9. Advanced Reconnect (`09_reconnect_config.js`)
Demonstrates reconnection logic, health checks, and event monitoring.
- **Run:** `node examples/09_reconnect_config.js`

### 10. Remote Forwarding (`10_remote_forwarding.js`)
Exposes a service running on your local machine (or local network) to the VPN. Traffic sent to a specific VPN port is forwarded to the local target.
- **Run:** `node examples/10_remote_forwarding.js`


## Configuration
All examples read from `wireguard.conf` in this directory. Ensure this file contains your valid Client configuration.
