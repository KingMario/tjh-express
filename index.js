var SAMPLE_STATS_INTERVAL = 60*1000; // 1 minute
var SAMPLE_LOAD_INTERVAL = 5*60*1000; // 5 minutes
var EMPTY_ROOM_LOG_TIMEOUT = 3*60*1000; // 3 minutes
var WEBSOCKET_COMPAT = true;

var WebSocketServer = WEBSOCKET_COMPAT ?
    require("./websocket-compat").server :
    require("websocket").server;
var parseUrl = require('url').parse;
var fs = require('fs');

var logLevel = process.env.LOG_LEVEL || 0;

var Logger = function (level, filename, stdout) {
    this.level = level;
    this.filename = filename;
    this.stdout = !!stdout;
    this._open();
    process.on("SIGUSR2", (function () {
        this._open();
    }).bind(this));
};

Logger.prototype = {

    write: function () {
        if (this.stdout) {
            console.log.apply(console, arguments);
        }
        if (this.file) {
            var s = [];
            for (var i=0; i<arguments.length; i++) {
                var a = arguments[i];
                if (typeof a == "string") {
                    s.push(a);
                } else {
                    s.push(JSON.stringify(a));
                }
            }
            s = s.join(" ") + "\n";
            this.file.write(this.date() + " " + s);
        }
    },

    date: function () {
        return (new Date()).toISOString();
    },

    _open: function () {
        if (this.file) {
            this.file.end(this.date() + " Logs rotating\n");
            this.file = null;
        }
        if (this.filename) {
            this.file = fs.createWriteStream(this.filename, {flags: 'a', mode: parseInt('644', 8), encoding: "UTF-8"});
        }
    }

};

[["error", 4], ["warn", 3], ["info", 2], ["log", 1], ["debug", 0]].forEach(function (nameLevel) {
    var name = nameLevel[0];
    var level = nameLevel[1];
    Logger.prototype[name] = function () {
        if (logLevel <= level) {
            if (name != "log") {
                this.write.apply(this, [name.toUpperCase()].concat(Array.prototype.slice.call(arguments)));
            } else {
                this.write.apply(this, arguments);
            }
        }
    };
});

var logger = new Logger(0, null, true);

exports.findRoom = function (prefix, max, response) {
    var smallestNumber;
    var smallestRooms = [];
    for (var candidate in allConnections) {
        if (candidate.indexOf(prefix + "__") === 0) {
            var count = allConnections[candidate].length;
            if (count < max && (smallestNumber === undefined || count <= smallestNumber)) {
                if (smallestNumber === undefined || count < smallestNumber) {
                    smallestNumber = count;
                    smallestRooms = [candidate];
                } else {
                    smallestRooms.push(candidate);
                }
            }
        }
    }
    var room;
    if (! smallestRooms.length) {
        room = prefix + "__" + generateId();
    } else {
        room = pickRandom(smallestRooms);
    }
    response.end(JSON.stringify({name: room}));
};

function generateId(length) {
    length = length || 10;
    var letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV0123456789';
    var s = '';
    for (var i=0; i<length; i++) {
        s += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return s;
}

function pickRandom(seq) {
    return seq[Math.floor(Math.random() * seq.length)];
}

exports.getLoad = function () {
    var sessions = 0;
    var connections = 0;
    var empty = 0;
    var solo = 0;
    for (var id in allConnections) {
        if (allConnections[id].length) {
            sessions++;
            connections += allConnections[id].length;
            if (allConnections[id].length == 1) {
                solo++;
            }
        } else {
            empty++;
        }
    }
    return {
        sessions: sessions,
        connections: connections,
        empty: empty,
        solo: solo
    };
};

var allConnections = {};
var connectionStats = {};

var ID = 0;

exports.startWsServer = function (server) {
    var wsServer = new WebSocketServer({
        httpServer: server,
        // 10Mb max size (1Mb is default, maybe this bump is unnecessary)
        maxReceivedMessageSize: 0x1000000,
        // The browser doesn't seem to break things up into frames (not sure what this means)
        // and the default of 64Kb was exceeded; raised to 1Mb
        maxReceivedFrameSize: 0x100000,
        // Using autoaccept because the origin is somewhat dynamic
        // FIXME: make this smarter?
        autoAcceptConnections: false
    });

    function originIsAllowed(origin) {
        // Unfortunately the origin will be whatever page you are sharing,
        // which could be any origin
        return true;
    }

    wsServer.on('request', function(request) {
        if (!originIsAllowed(request.origin)) {
            // Make sure we only accept requests from an allowed origin
            request.reject();
            logger.info('Connection from origin ' + request.origin + ' rejected.');
            return;
        }

        var id = request.httpRequest.url.replace(/^\/+hub\/+/, '').replace(/\//g, "");
        if (! id) {
            request.reject(404, 'No ID Found');
            return;
        }

        // FIXME: we should use a protocol here instead of null, but I can't
        // get it to work.  "Protocol" is what the two clients are using
        // this channel for (we don't bother to specify this)
        var connection = request.accept(null, request.origin);
        connection.ID = ID++;
        if (! allConnections[id]) {
            allConnections[id] = [];
            connectionStats[id] = {
                created: Date.now(),
                sample: [],
                clients: {},
                domains: {},
                urls: {},
                firstDomain: null,
                totalMessageChars: 0,
                totalMessages: 0,
                connections: 0
            };
        }
        allConnections[id].push(connection);
        connectionStats[id].connections++;
        connectionStats[id].lastLeft = null;
        logger.debug('Connection accepted to ' + JSON.stringify(id) + ' ID:' + connection.ID);
        connection.sendUTF(JSON.stringify({
            type: "init-connection",
            peerCount: allConnections[id].length-1
        }));
        connection.on('message', function(message) {
            var parsed;
            try {
                parsed = JSON.parse(message.utf8Data);
            } catch (e) {
                logger.warn('Error parsing JSON: ' + JSON.stringify(message.utf8Data) + ": " + e);
                return;
            }
            connectionStats[id].clients[parsed.clientId] = true;
            var domain = null;
            if (parsed.url) {
                domain = parseUrl(parsed.url).hostname;
                connectionStats[id].urls[parsed.url] = true;
            }
            if ((! connectionStats[id].firstDomain) && domain) {
                connectionStats[id].firstDomain = domain;
            }
            connectionStats[id].domains[domain] = true;
            connectionStats[id].totalMessageChars += message.utf8Data.length;
            connectionStats[id].totalMessages++;
            logger.debug('Message on ' + id + ' bytes: ' +
                (message.utf8Data && message.utf8Data.length) +
                ' conn ID: ' + connection.ID + ' data:' + message.utf8Data.substr(0, 20) +
                ' connections: ' + allConnections[id].length);
            for (var i=0; i<allConnections[id].length; i++) {
                var c = allConnections[id][i];
                if (c == connection && !parsed["server-echo"]) {
                    continue;
                }
                if (message.type === 'utf8') {
                    c.sendUTF(message.utf8Data);
                } else if (message.type === 'binary') {
                    c.sendBytes(message.binaryData);
                }
            }
        });
        connection.on('close', function(reasonCode, description) {
            if (! allConnections[id]) {
                // Got cleaned up entirely, somehow?
                logger.info("Connection ID", id, "was cleaned up entirely before last connection closed");
                return;
            }
            var index = allConnections[id].indexOf(connection);
            if (index != -1) {
                allConnections[id].splice(index, 1);
            }
            if (! allConnections[id].length) {
                delete allConnections[id];
                connectionStats[id].lastLeft = Date.now();
            }
            logger.debug('Peer ' + connection.remoteAddress + ' disconnected, ID: ' + connection.ID);
        });
    });

    setInterval(function () {
        for (var id in connectionStats) {
            if (connectionStats[id].lastLeft && Date.now() - connectionStats[id].lastLeft > EMPTY_ROOM_LOG_TIMEOUT) {
                logStats(id, connectionStats[id]);
                delete connectionStats[id];
                continue;
            }
            var totalClients = countClients(connectionStats[id].clients);
            var connections = 0;
            if (allConnections[id]) {
                connections = allConnections[id].length;
            }
            connectionStats[id].sample.push({
                time: Date.now(),
                totalClients: totalClients,
                connections: connections
            });
        }
    }, SAMPLE_STATS_INTERVAL);

    setInterval(function () {
        var load = exports.getLoad();
        load.time = Date.now();
        logger.info("LOAD", JSON.stringify(load));
    }, SAMPLE_LOAD_INTERVAL);

    function countClients(clients) {
        var n = 0;
        for (var clientId in clients) {
            n++;
        }
        return n;
    }

    function logStats(id, stats) {
        logger.info("STATS", JSON.stringify({
            id: id,
            created: stats.created,
            sample: stats.sample,
            totalClients: countClients(stats.clients),
            totalMessageChars: stats.totalMessageChars,
            totalMessages: stats.totalMessages,
            domain: stats.firstDomain || null,
            domainCount: countClients(stats.domains),
            urls: countClients(stats.urls)
        }));
    }
};
