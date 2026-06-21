// Minimal untrusted WebSocket relay. The relay can never forge or alter a state
// without breaking a signature; it only shuttles messages between the two parties.
import { WebSocketServer, WebSocket } from "ws";

interface Channel { provider?: WebSocket; consumer?: WebSocket; }
const channels = new Map<string, Channel>();

export function startRelay(port = 8787) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", (ws) => {
    let sessionId = "", role = "";
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "join") {
        sessionId = msg.session; role = msg.role;
        const ch = channels.get(sessionId) ?? {};
        (ch as any)[role] = ws;
        channels.set(sessionId, ch);
        return;
      }
      // Forward signed state updates to the counterparty verbatim.
      const ch = channels.get(sessionId);
      if (!ch) return;
      const peer = role === "provider" ? ch.consumer : ch.provider;
      peer?.send(raw.toString());
    });
    ws.on("close", () => {
      const ch = channels.get(sessionId);
      if (ch) (ch as any)[role] = undefined;
    });
  });
  console.log(`SolMesh relay listening on ws://localhost:${port}`);
  return wss;
}

if (require.main === module) startRelay();
