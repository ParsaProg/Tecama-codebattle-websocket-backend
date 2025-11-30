import express from "express";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

// Redis connection (Railway automatically injects REDIS_URL)
const redis = new Redis(process.env.REDIS_URL);

// store active WebSocket connections only in memory
const wsConnections = new Map(); // socketId -> ws

// create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// --- Helpers --------------------------------------------------

async function getRoom(roomId) {
  const data = await redis.get(`room:${roomId}`);
  return data ? JSON.parse(data) : null;
}

async function saveRoom(roomId, roomData) {
  await redis.set(`room:${roomId}`, JSON.stringify(roomData));
}

async function deleteRoom(roomId) {
  await redis.del(`room:${roomId}`);
}

function broadcast(room, msg) {
  room.users.forEach((u) => {
    if (wsConnections.has(u.socketId)) {
      wsConnections.get(u.socketId).send(JSON.stringify(msg));
    }
  });
}

// --- WebSocket Logic -----------------------------------------

wss.on("connection", async (ws) => {
  const socketId = uuidv4();
  wsConnections.set(socketId, ws);

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const { action, roomId, user } = data;

    // Create Room --------------------------------------------------
    if (action === "createRoom") {
      const newRoomId = uuidv4().slice(0, 6);

      const roomData = {
        id: newRoomId,
        users: [],
        gameState: {}
      };

      await saveRoom(newRoomId, roomData);

      ws.send(JSON.stringify({ ok: true, roomId: newRoomId }));
      return;
    }

    // Join Room --------------------------------------------------
    if (action === "joinRoom") {
      const room = await getRoom(roomId);
      if (!room) {
        ws.send(JSON.stringify({ error: "ROOM_NOT_FOUND" }));
        return;
      }

      // add user (no WebSocket object inside!)
      const newUser = {
        email: user.email,
        username: user.username,
        socketId: socketId,
        score: 0
      };

      room.users.push(newUser);
      await saveRoom(roomId, room);

      ws.send(JSON.stringify({ ok: true, room }));

      broadcast(room, {
        action: "userJoined",
        user: newUser
      });

      return;
    }

    // Game Events --------------------------------------------------
    if (action === "sendEvent") {
      const room = await getRoom(roomId);
      if (!room) return;

      broadcast(room, {
        action: "event",
        payload: data.payload
      });

      return;
    }
  });

  ws.on("close", async () => {
    wsConnections.delete(socketId);

    // find which room had this socket
    const keys = await redis.keys("room:*");

    for (const key of keys) {
      const room = JSON.parse(await redis.get(key));
      const before = room.users.length;

      room.users = room.users.filter((u) => u.socketId !== socketId);

      if (room.users.length === 0) {
        // delete empty room
        await deleteRoom(room.id);
      } else if (before !== room.users.length) {
        // update if someone left
        await saveRoom(room.id, room);

        broadcast(room, {
          action: "userLeft",
          socketId: socketId
        });
      }
    }
  });
});

// --- HTTP Upgrade Handler -------------------------------------

const server = app.listen(process.env.PORT || 3001, () =>
  console.log("WebSocket server running")
);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Root route
app.get("/", (req, res) => {
  res.send("TECAMA CodeBattle WebSocket Server (Redis-backed)");
});
