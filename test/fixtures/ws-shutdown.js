'use strict';

// Child process for the WS "clean shutdown" test: runs a full ws:// lifecycle
// and must exit on its own (no process.exit) once both clients are closed. A
// leaked handle (TCP listener, WS connection, timer, threadsafe function, ...)
// makes it hang.

const { createWsPeers } = require('./peers');

async function main() {
    const { a, b, ipB } = await createWsPeers();

    // Start server (resolves on bind) then client (resolves on handshake).
    await b.start();
    await a.start();

    await a.ping(ipB);

    await b.listen(9100, (socket) => {
        socket.on('error', () => { });
        socket.pipe(socket);
    });

    await new Promise((resolve, reject) => {
        const s = a.connect({ host: ipB, port: 9100 });
        s.on('error', reject);
        s.once('data', () => {
            s.end();
        });
        s.on('close', resolve);
        s.resume();
        s.write('ping');
    });

    await Promise.all([a.close(), b.close()]);
    console.log('CLOSED');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
