import Debug from "debug";
import express, { Request } from "express";
import expressWs from "express-ws";
import path from "path";
import rp from "request-promise";
import uuid from "uuid";

const debug = Debug("streamer-event-viewer");

const CLIENT_ID = process.env.CLIENT_ID;
const REDIRECT = process.env.REDIRECT;

const appWs = expressWs(express());
const app = appWs.app;

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "..", "views")));
app.use(express.json());
app.use(express.urlencoded());

function _show_req(req: Request) {
  debug(
    "request [%s] %s://%s%s, \nparams: %s, \nbody: %s, \nheaders: %s",
    req.method,
    req.protocol,
    req.headers.host,
    req.originalUrl,
    JSON.stringify(req.query),
    JSON.stringify(req.body),
    JSON.stringify(req.headers)
  );
}

app.ws("/eventSocket", function(ws, req) {
  _show_req(req);

  ws.on("message", function(msg) {
    debug("got message %s", msg);
  });

  ws.on("close", function() {
    debug("WebSocket was closed");
  });
});

const eventWss = appWs.getWss();

app.get("/hello", (req, res) => {
  res.send("Hello world!");
});

app.get("/", function(req, res) {
  _show_req(req);

  res.render("pages/index", {
    clientId: CLIENT_ID,
    loginRedirectUrl: `${REDIRECT}`,
    responseType: "token",
    scope: "user:read:email",
    state: uuid.v4()
  });
});

app.get("/subscribe", function(req, res) {
  _show_req(req);

  const uname = req.query.favorteStreamerName;
  const token = req.query.accessToken;

  const opt = {
    url: `https://api.twitch.tv/helix/users?login=${uname}`,
    headers: {
      "Client-ID": CLIENT_ID,
      Authorization: `Bearer ${token}`
    }
  };

  debug("send request to", opt);
  rp(opt)
    .then(function(body) {
      debug(body);
      const json = JSON.parse(body);
      const userId = json.data[0].id;
      return userId;
    })
    .then(function(userId) {
      return subscribeUserEvent(userId, token);
    })
    .then(function() {
      res.redirect(`/streamer?username=${uname}`);
    })
    .catch(function(err) {
      console.error("failed to subscribe for user", uname, ":", err.message);
      res.redirect("/error");
    });
});

// add subscription callback endpoints
const subscribeCallbacks = [
  {
    path: "/onUserEdit",
    topicSuffix: (userId: string) => `users?id=${userId}`,
    postProc: (payload: any) => ({
      message: `user ${payload.data[0].login} modified profile`
    })
  },
  {
    path: "/onFollowing",
    topicSuffix: (userId: string) => `users/follows?first=1&from_id=${userId}`,
    postProc: (payload: any) => ({
      message: `${payload.data[0].from_name} followed ${
        payload.data[0].to_name
      }`
    })
  },
  {
    path: "/onFollower",
    topicSuffix: (userId: string) => `users/follows?first=1&to_id=${userId}`,
    postProc: (payload: any) => ({
      message: `${payload.data[0].from_name} followed ${
        payload.data[0].to_name
      }`
    })
  }
];

for (var cb of subscribeCallbacks) {
  app.get(cb.path, function(req, res) {
    _show_req(req);
    const mode = req.query["hub.mode"];
    if (mode == "subscribe") {
      res.send(req.query["hub.challenge"]);
    } else {
      res.send("");
    }
  });

  app.post(cb.path, function(req, res) {
    _show_req(req);

    eventWss.clients.forEach(function(client) {
      client.send(JSON.stringify(cb.postProc(req.body)));
    });

    res.send("");
  });
}

function subscribeUserEvent(userId: string, token: string) {
  function _subscribeTopic(suffix: string, path: string) {
    const opt = {
      url: "https://api.twitch.tv/helix/webhooks/hub",
      method: "POST",
      headers: {
        "Client-ID": CLIENT_ID,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      json: true,
      body: {
        "hub.mode": "subscribe",
        "hub.topic": `https://api.twitch.tv/helix/${suffix}`,
        "hub.callback": `${REDIRECT}${path}`,
        "hub.lease_seconds": (864000 / 1000) | 0,
        "hub.secret": "eF2pK3"
      }
    };
    debug("subscribe", opt);
    return rp(opt);
  }

  return Promise.all(
    subscribeCallbacks.map(cb =>
      _subscribeTopic(cb.topicSuffix(userId), cb.path)
    )
  );
}

app.get("/streamer", function(req, res) {
  if (!req.query.username) {
    res.redirect(`/error?message=empty username`);
    return;
  }

  res.render("pages/streamer", {
    subsribedUsername: req.query.username
  });
});

app.get("/error", function(req, res) {
  res.render("pages/404", { message: req.query.message });
});

export default app;