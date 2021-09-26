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

app.get('/state', (req, res) => {
    res.send("hello world");
});


app.listen(webPort, () => {
    console.log(`listening at localhost:${webPort}`);
})

let peerMap = new Map();

const toID = (ip, port) => {
    let p = Buffer.alloc(2);
    p.writeUint16BE(port);
    return Buffer.concat([IP.toBuffer(ip), p]);
};

const idToIP = id => `${id[0]}.${id[1]}.${id[2]}.${id[3]}`;
const idToPort = id => `${id.readUint16BE(4, 2)}`;
const idToStr = id => `${idToIP(id)}:${idToPort(id)}`;

const addPeer = (ip, port) => {
    const id = toID(ip, port);
    const newConn = new PromiseSocket(net.connect(idToPort(id), idToIP(id)));
    if (!peerMap.has(id)) {
        const peer = {
            digit: defaultDigit,
            conn: newConn()
        };
        const errRetry = () => {
            peer.conn.on('error', () => {
                stderr.write(`E: failed to connect ${idToStr(id)}\n`);
                peer.conn = null;
                setTimeout(() => {
                    peer.conn = newConn();
                    errRetry();
                }, retryDelay);
            });
        };
        errRetry();
        peerMap.set(id, peer);
        stderr.write(`added ${ip}:${port} (${id.toString('hex')})\n`);
    }
};

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
                stdout.write(`${idToStr(k)} --> ${v}\n`);
            });
        }
    }
};

const getRandomKey = (pm) => {
    let keys = Array.from(pm.keys());
    return keys[Math.floor(Math.random() * keys.length)];
}

const pullPeer = () => {
    const peer = peerMap[getRandomKey(peerMap)];
    if (peer.conn) {
        try {
            // how?
            await peer.conn.write('hello');
            await peer.conn.read();
        } catch (_) {}
    }
};

process.stdin.on('data', function(chunk) {
    cmdParser(chunk.toString());
});

var tcpServer = net.createServer(function(conn) {
    console.log(`${conn.localAddress}:${conn.localPort} tried to connect`);
});
tcpServer.listen(tcpPort, tcpAddress);
