'use strict';

// Child process for the "clean shutdown" test: runs a full lifecycle and must
// exit on its own (no process.exit) once both clients are closed. A leaked
// handle (UDP socket, timer, threadsafe function, ...) makes it hang.

const { createPeers } = require('./peers');

async function main() {
    const { a, b, ipB } = await createPeers();
    await Promise.all([a.start(), b.start()]);

    await a.ping(ipB);

    await b.listen(9000, (socket) => {
        socket.on('error', () => { });
        socket.pipe(socket);
    });

    await new Promise((resolve, reject) => {
        const s = a.connect({ host: ipB, port: 9000 });
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
