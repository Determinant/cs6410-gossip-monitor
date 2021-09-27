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
const retryDelay = 1000; // 1s
const pullInterval = 1000; // 1s
const readTimeout = 10000; // 10s
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
        return uuid();
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

const addPeer = async (ip, port) => {
    const id = toID(ip, port);
    const newConn = async () => {
        const c = new PromiseSocket();
        c.connect(idToPort(id), idToIP(id)).catch(async (e) => {
            peer.conn = null;
            stderr.write(`E: failed to connect ${idToStr(id)} (${e})\n`);
            await peer.retry();
        });
        return c;
    };
    const peer = touchPeer(id);
    peer.conn = await newConn();
    peer.retry = async () => {
        await delay(retryDelay);
        peer.conn = await newConn();
    };
    stderr.write(`added ${ip}:${port} (${id.toString('hex')})\n`);
};

const csvLine = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+),([0-9]+),([0-9])/;
const addIP = /\+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)/;
const setDigit = /([0-9])/;
const cmdParser = async line => {
    line = line.trim();
    let m = line.match(addIP);
    if (m) {
        const ip = m[1];
        const port = parseInt(m[2]);
        if (port == NaN || port >= 65536) {
            stderr.write("E: invalid port format\n");
            return;
        }
        await addPeer(ip, port);
    } else {
        m = line.match(setDigit);
        if (m) {
            myDigit = parseInt(m[1]);
            stdout.write(`${tcpAddress}:${tcpPort} --> ${myDigit}\n`);
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

const pullPeer = async peer => {
    if (peer.conn) {
        const k = idToStr(peer.id);
        stderr.write(`pulling ${k}\n`);
        try {
            let all = Buffer.alloc(0);
            peer.conn.setTimeout(readTimeout);
            while (true) {
                const chunk = await peer.conn.read(readChunkSize);
                if (!chunk) break;
                all = Buffer.concat([all, chunk]);
                if (all.length > tableMaxBytes) {
                    throw `data from ${k} is too long`;
                }
            }
            peer.conn.setTimeout(0);
            const lines = all.toString().split('\n');
            lines.forEach(raw => {
                const m = raw.match(csvLine);
                if (m) {
                    const id = toID(m[1], m[2]);
                    const socket = idToStr(id);
                    const info = {
                        id,
                        socket,
                        timestamp: new Date(parseInt(m[3], 10) * 1000),
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
            await peer.conn.end();
        } catch (e) {
            stderr.write(`E: ${k} (${e})\n`);
        } finally {
            peer.conn = null;
            await peer.retry();
        }
    }
};


const pullRandomPeers = async () => {
    stderr.write("pulling all peers");
    if (peerMap.size > 0) {
        const key = getRandomKey(peerMap);
        const peer = peerMap.get(key);
        await pullPeer(peer);
    }
    await delay(pullInterval);
    pullRandomPeers();
};

const pullAllPeers = async () => {
    const keys = peerMap.keys();
    let pms = [];
    for (const k of keys) {
        const peer = peerMap.get(k);
        pms.push(pullPeer(peer));
    }
    await Promise.all(pms);
    await delay(pullInterval);
    pullAllPeers();
};

process.stdin.pipe(require('split')()).on('data', async chunk => {
    await cmdParser(chunk.toString());
});

var tcpServer = net.createServer(function(conn) {
    stderr.write(`${conn.localAddress}:${conn.localPort} tried to connect\n`);
    conn.end();
});
tcpServer.listen(tcpPort, tcpAddress);

//pullRandomPeers();
pullAllPeers();

app.use(express.static('public'));

const timeAgo = (now, t) => {
    let diff = now - t;
    if (Math.abs(diff) <= 1000) {
        return `${diff.toFixed(2)}ms`;
    }
    diff /= 1000;
    if (Math.abs(diff) <= 60) {
        return `${diff.toFixed(2)}s`;
    }
    diff /= 60;
    if (Math.abs(diff) <= 60) {
        return `${diff.toFixed(2)}m`;
    }
    diff /= 60;
    return Math.abs(diff) > 10 ? ">10h" : `${diff.toFixed(2)}h`;
}

app.get('/state', (req, res) => {
    let data = {};
    const now = new Date();
    peerMap.forEach((v, k) => {
        let csv = {};
        Object.entries(v.csv).forEach(e => {
            const info = e[1];
            csv[e[0]] = {
                id: info.id,
                socket: info.socket,
                timestamp: timeAgo(now, info.timestamp),
                digit: info.digit,
            };
        });
        data[k] = {
            id: v.id,
            lastAlleged: timeAgo(now, v.lastAlleged),
            digit: v.digit,
            csv,
        };
    });
    res.send(data);
});


app.listen(webPort, () => {
    stderr.write(`listening at localhost:${webPort}\n`);
})

