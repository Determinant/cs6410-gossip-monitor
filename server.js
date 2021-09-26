#!/usr/bin/env node

const fs = require('fs');
const express = require('express');
const uuid = require('uuid').v4;
const session = require('express-session');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3');
const sqliteStoreFactory = require('express-session-sqlite').default;
const SqliteStore = sqliteStoreFactory(session);
const IP = require('ip');
const net = require('net');
const {PromiseSocket, TimeoutError} = require("promise-socket");

const webPort = 8080;
const tcpPort = 2333;
const tcpAddress = '0.0.0.0';
const defaultDigit = 0;
const retryDelay = 1000;
const readChunkSize = 4096;
const tableMaxBytes = 65536;
var myDigit = defaultDigit;

const stdout = process.stdout;
const stderr = process.stderr;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
    genid: (req) => {
        console.log(req.sessionID);
        return uuid()
    },
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    store: new SqliteStore({
      driver: sqlite3.Database,
      path: './gossip.db',
      ttl: 30 * 86400 * 1000,
      prefix: 'sess:',
      cleanupInterval: 300000
    }),
}));

let peerMap = new Map();

const toID = (ip, port) => {
    let p = Buffer.alloc(2);
    p.writeUint16BE(port);
    return Buffer.concat([IP.toBuffer(ip), p]);
};

const idToIP = id => `${id[0]}.${id[1]}.${id[2]}.${id[3]}`;
const idToPort = id => `${id.readUint16BE(4, 2)}`;
const idToStr = id => `${idToIP(id)}:${idToPort(id)}`;

const touchPeer = id => {
    const key = idToStr(id);
    let peer = peerMap.get(key);
    if (!peer) {
        peer = {
            id,
            lastAlleged: new Date(0),
            csv: {},
            digit: defaultDigit,
        };
        peerMap.set(key, peer);
    }
    return peer;
};

const addPeer = (ip, port) => {
    const id = toID(ip, port);
    const newConn = () => new PromiseSocket(net.connect(idToPort(id), idToIP(id)));
    const peer = touchPeer(id);
    peer.conn = newConn();
    peer.retry = () => setTimeout(() => {
        peer.conn = newConn();
        errRetry();
    }, retryDelay);

    const errRetry = () => {
        peer.conn.read(0).catch((e) => {
            stderr.write(`E: failed to connect ${idToStr(id)} (${e})\n`);
            peer.conn = null;
            peer.retry();
        });
    };
    errRetry();
    stderr.write(`added ${ip}:${port} (${id.toString('hex')})\n`);
};

const csvLine = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+),([0-9]+),([0-9])/;
const addIP = /\+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)/;
const setDigit = /([0-9])/;
const cmdParser = line => {
    line = line.trim();
    let m = line.match(addIP);
    if (m) {
        const ip = m[1];
        const port = parseInt(m[2]);
        if (port == NaN || port >= 65536) {
            console.log("E: invalid port format");
            return;
        }
        addPeer(ip, port);
    } else {
        m = line.match(setDigit);
        if (m) {
            myDigit = parseInt(m[1]);
            console.log(`${tcpAddress}:${tcpPort} --> ${myDigit}`);
        } else if (line == '?') {
            peerMap.forEach((v, k, _) => {
                stdout.write(`${k} --> ${v.digit}\n`);
            });
        }
    }
};

const getRandomKey = (pm) => {
    let keys = Array.from(pm.keys());
    return keys[Math.floor(Math.random() * keys.length)];
}

const delay = (t, v) => new Promise((resolve) => {
    setTimeout(resolve.bind(null, v), t);
});

const pullPeer = async () => {
    if (peerMap.size > 0) {
        const key = getRandomKey(peerMap);
        const peer = peerMap.get(key);
        if (peer.conn) {
            stderr.write(`pulling ${key}\n`);
            try {
                let all = Buffer.alloc(0);
                while (true) {
                    const chunk = await peer.conn.read(readChunkSize);
                    if (!chunk) break;
                    all = Buffer.concat([all, chunk]);
                    if (all.length > tableMaxBytes) {
                        stderr.write(`data from ${key} is too long\n`);
                        await peer.conn.end();
                        throw 0;
                    }
                }
                const lines = all.toString().split('\n');
                lines.forEach(raw => {
                    const m = raw.match(csvLine);
                    if (m) {
                        const id = toID(m[1], m[2]);
                        const socket = idToStr(id);
                        const info = {
                            id,
                            socket,
                            timestamp: new Date(parseInt(m[3], 10)),
                            digit: parseInt(m[4]),
                        };
                        peer.csv[socket] = info;
                        const p = touchPeer(id);
                        if (info.timestamp > p.lastAlleged) {
                            p.lastAlleged = info.timestamp;
                            p.digit = info.digit;
                        }
                    }
                });
            } catch (_) {
            } finally {
                peer.conn = null;
                peer.retry();
            }
        }
    }
    await delay(3000);
    pullPeer();
};

process.stdin.on('data', function(chunk) {
    cmdParser(chunk.toString());
});

var tcpServer = net.createServer(function(conn) {
    console.log(`${conn.localAddress}:${conn.localPort} tried to connect`);
    conn.end();
});
tcpServer.listen(tcpPort, tcpAddress);

pullPeer();

app.use(express.static('public'));

app.get('/state', (req, res) => {
    let data = {};
    peerMap.forEach((v, k) => {
        data[k] = v;
    });
    res.send(data);
});


app.listen(webPort, () => {
    console.log(`listening at localhost:${webPort}`);
})

