const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.get("/", (req, res) => {
  res.send("TECAMA CodeBattle WebSocket Server (MVP)");
});
// =====================
// UTILS
// =====================
function makeId(len = 6) {
  return crypto.randomBytes(len).toString("hex");
}
function safeSend(ws, type, payload = {}) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  } catch (e) {
    console.log("❌ Send error:", e);
  }
}
// =====================
// ROOMS STORAGE
// =====================
/*
rooms = Map {
  roomId: {
    id: string,
    users: Map<userEmail, { ws, userData }>,
    challenge: {...},
    started: boolean,
    winner: string (email),
    loser: string (email)
  }
}
*/
const rooms = new Map();
const history = new Map(); // For completed games: roomId => {room data, result}
function broadcast(roomId, type, payload, except = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [email, user] of room.users.entries()) {
    if (email === except) continue;
    safeSend(user.ws, type, payload);
  }
}
// =====================
// SAMPLE CHALLENGE
// =====================
function getRandomChallenge() {
  return {
    title: "مجموع اعداد",
    description: "تابعی بنویسید که مجموع اعداد 1 تا n را محاسبه کند.",
    examples: [
      { input: "5", output: "15" },
      { input: "10", output: "55" },
    ],
    testCases: [
      { input: "10", expectedOutput: "55" },
      { input: "100", expectedOutput: "5050" },
    ],
  };
}
// =====================
// WEBSOCKET SERVER
// =====================
wss.on("connection", (ws) => {
  const socketId = makeId(4);
  ws.socketId = socketId;
  console.log("🟢 Connected:", socketId);
  safeSend(ws, "welcome", { socketId });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      safeSend(ws, "error", { message: "invalid_json" });
      return;
    }
    const type = msg?.type;
    const payload = msg?.payload || {};
    if (!type) {
      safeSend(ws, "error", { message: "missing_type" });
      return;
    }
    // ===================== CREATE ROOM =====================
    if (type === "create_room") {
      const roomId = makeId(4);
      const challenge = getRandomChallenge();
      rooms.set(roomId, {
        id: roomId,
        users: new Map(),
        challenge,
        started: false,
      });
      console.log("📦 Room created:", roomId);
      safeSend(ws, "room_created", { roomId, challenge });
      // Broadcast updated list to all clients
      const list = [...rooms.values()].map((r) => ({
        roomId: r.id,
        userCount: r.users.size,
        challenge: r.challenge,
      }));
      wss.clients.forEach((client) =>
        safeSend(client, "rooms_list", { rooms: list })
      );
      return;
    }
    // ===================== LIST ROOMS =====================
    if (type === "list_rooms") {
      const list = [...rooms.values()].map((r) => ({
        roomId: r.id,
        userCount: r.users.size,
        challenge: r.challenge,
      }));
      safeSend(ws, "rooms_list", { rooms: list });
      return;
    }
    // ===================== JOIN ROOM =====================
    if (type === "join_room") {
      const roomId = payload.roomId;
      const userEmail = payload.userData.email;
      if (!userEmail) {
        safeSend(ws, "join_error", { message: "missing_email" });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        safeSend(ws, "join_error", { message: "room_not_found" });
        return;
      }
      const existingUser = room.users.get(userEmail);
      if (existingUser) {
        // Rejoin: update ws and send state
        room.users.set(userEmail, { ws, userData: payload.userData });
        safeSend(ws, "joined_room", {
          roomId,
          users: [...room.users.values()].map((u) => u.userData),
          challenge: room.challenge || null,
          started: room.started,
        });
        console.log(userEmail, "rejoined room", roomId);
      } else {
        if (room.users.size >= 2) {
          safeSend(ws, "join_error", { message: "room_full" });
          return;
        }
        // New join
        room.users.set(userEmail, { ws, userData: payload.userData });
        safeSend(ws, "joined_room", {
          roomId,
          users: [...room.users.values()].map((u) => u.userData),
          challenge: room.challenge || null,
          started: room.started,
        });
        broadcast(
          roomId,
          "user_joined",
          { userData: payload.userData },
          userEmail
        );
        console.log(userEmail, "joined room", roomId);
      }
      // Update rooms list
      const roomList = [...rooms.values()].map((r) => ({
        roomId: r.id,
        userCount: r.users.size,
        challenge: r.challenge || null,
      }));
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          safeSend(client, "rooms_list", { rooms: roomList });
        }
      }
      // If room full, start game
      if (room.users.size === 2) {
        room.started = true;
        broadcast(roomId, "game_started", { time: 300 });
      }
      return;
    }
    // ===================== LEAVE ROOM =====================
    if (type === "leave_room") {
      const { roomId } = payload;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      let deleted = false;
      let leftUserData = null;
      let leftEmail = null;
      for (const [email, user] of room.users.entries()) {
        if (user.ws === ws) {
          leftUserData = user.userData;
          leftEmail = email;
          room.users.delete(email);
          deleted = true;
          break;
        }
      }
      if (deleted) {
        if (room.started && room.users.size > 0) {
          // Game was started, the remaining player wins
          const winnerEmail = [...room.users.keys()][0];
          const winnerData = room.users.get(winnerEmail).userData;
          room.winner = winnerEmail;
          room.loser = leftEmail;
          broadcast(roomId, "game_ended", {
            winner: winnerData,
            loser: leftUserData,
            reason: "opponent_left",
          });
          safeSend(ws, "game_ended", {
            winner: winnerData,
            loser: leftUserData,
            reason: "you_left",
          });
          // Move to history
          history.set(roomId, { ...room, completedAt: Date.now() });
          rooms.delete(roomId);
          console.log(`🏆 Game ended in ${roomId}: Winner ${winnerEmail}, Loser ${leftEmail}`);
        } else {
          // Not started or empty
          broadcast(roomId, "user_left", {
            userData: leftUserData,
            users: [...room.users.values()].map((u) => u.userData),
          });
          safeSend(ws, "left_room", { roomId });
          console.log(`🚪 ${leftUserData?.email} left ${roomId}`);
          if (room.users.size === 0) {
            rooms.delete(roomId);
            console.log("🗑 Room removed:", roomId);
          }
        }
        // Update rooms list
        const roomList = [...rooms.values()].map((r) => ({
          roomId: r.id,
          userCount: r.users.size,
          challenge: r.challenge || null,
        }));
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            safeSend(client, "rooms_list", { rooms: roomList });
          }
        }
      }
      return;
    }
    // ===================== CHAT MESSAGE =====================
    if (type === "chat_message") {
      const { roomId, message } = payload;
      if (!roomId || !message) return;
      const room = rooms.get(roomId);
      if (!room) return;
      let senderEmail = null;
      let senderName = null;
      for (const [email, user] of room.users.entries()) {
        if (user.ws === ws) {
          senderEmail = email;
          senderName = user.userData.fullName;
          break;
        }
      }
      if (!senderEmail) return;
      broadcast(
        roomId,
        "chat_message",
        { sender: senderName, message },
        senderEmail
      );
      return;
    }
    // ===================== UNKNOWN TYPE =====================
    safeSend(ws, "error", { message: "unknown_type", type });
  });
  ws.on("close", () => {
    console.log("🔴 Disconnected:", ws.socketId);
    for (const [roomId, room] of rooms.entries()) {
      let deleted = false;
      let leftUserData = null;
      let leftEmail = null;
      for (const [email, user] of room.users.entries()) {
        if (user.ws === ws) {
          leftUserData = user.userData;
          leftEmail = email;
          room.users.delete(email);
          deleted = true;
          break;
        }
      }
      if (deleted) {
        if (room.started && room.users.size > 0) {
          // Game was started, the remaining player wins
          const winnerEmail = [...room.users.keys()][0];
          const winnerData = room.users.get(winnerEmail).userData;
          room.winner = winnerEmail;
          room.loser = leftEmail;
          broadcast(roomId, "game_ended", {
            winner: winnerData,
            loser: leftUserData,
            reason: "opponent_left",
          });
          // Move to history
          history.set(roomId, { ...room, completedAt: Date.now() });
          rooms.delete(roomId);
          console.log(`🏆 Game ended in ${roomId}: Winner ${winnerEmail}, Loser ${leftEmail}`);
        } else {
          broadcast(roomId, "user_left", {
            userData: leftUserData,
            users: [...room.users.values()].map((u) => u.userData),
          });
          if (room.users.size === 0) rooms.delete(roomId);
        }
        // Update rooms list
        const roomList = [...rooms.values()].map((r) => ({
          roomId: r.id,
          userCount: r.users.size,
          challenge: r.challenge || null,
        }));
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            safeSend(client, "rooms_list", { rooms: roomList });
          }
        }
        break; // assuming user in at most one room
      }
    }
  });
});
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});