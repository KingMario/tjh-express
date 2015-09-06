## TogetherJS Hub Express

This is a port of [TogetherJS Hub](https://github.com/mozilla/togetherjs/tree/develop/hub) for Express.

TogetherJS is a **free**, **open source** JavaScript library by **Mozilla** that adds collaboration features and tools to your website. Learn more about [TogetherJS](https://togetherjs.com/).

## Install

```
npm install tjh-express --save
```

## Usage

In an express project, require tjh-express in `bin/www` and `app.js`.

```
var TJH = require('tjh-express');
```

Add the following routes in app.js

```
// togetherJS hub routes
app.get('/status', function (req, res, next) {
  res.end('OK');
});

app.get('/load', function (req, res, next) {
  var load = TJH.getLoad();

  res.header('Content-Type', 'text/plain');

  res.end("OK " + load.connections + " connections " +
    load.sessions + " sessions; " +
    load.solo + " are single-user and " +
    (load.sessions - load.solo) + " active sessions");
});

app.get('/findroom', function (req, res, next) {
  var prefix = req.query.prefix;
  var max = parseInt(req.query.max, 10);

  res.header('Content-Type', 'application/json');
  res.header("Access-Control-Allow-Origin", "*");

  if (! (prefix && max)) {
    return res.end("You must include a valid prefix=CHARS&max=NUM portion of the URL");
  }
  if (prefix.search(/[^a-zA-Z0-9]/) != -1) {
    return res.end("Invalid prefix");
  }

  TJH.findRoom(prefix, max, res);
});
```

Start the tjh-express at the end of `bin/www`.

```
TJH.startWsServer(server);
```
