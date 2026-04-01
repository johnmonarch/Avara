import { createServer } from "node:http";

import { log } from "@avara/telemetry";

const port = Number(process.env.PORT ?? "8090");
const defaultGameServerUrl = process.env.GAME_SERVER_URL ?? "http://127.0.0.1:8091";

interface WorkerState {
  id: string;
  gameServerUrl: string;
  roomBudget: number;
  reservedPlayers: number;
  roomIds: Set<string>;
}

interface RoomAssignment {
  roomId: string;
  workerId: string;
  gameServerUrl: string;
  playerCap: number;
  assignedAt: string;
  lastTouchedAt: string;
}

const workers = parseWorkers(process.env.GAME_WORKERS ?? `game-worker-1|${defaultGameServerUrl}|64`);
const assignments = new Map<string, RoomAssignment>();

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, {
        service: "matchmaker",
        status: "healthy",
        workers: workers.map((worker) => ({
          id: worker.id,
          gameServerUrl: worker.gameServerUrl,
          roomBudget: worker.roomBudget,
          reservedPlayers: worker.reservedPlayers,
          rooms: worker.roomIds.size
        })),
        assignedRooms: assignments.size
      });
    }

    if (request.method === "POST" && request.url === "/assign-room") {
      const body = await readJsonBody(request);
      const roomId = typeof body?.roomId === "string" ? body.roomId : "";
      const playerCap = clampPlayerCap(body?.playerCap);
      if (!roomId) {
        return sendJson(response, 400, { error: "roomId is required" });
      }

      const existing = assignments.get(roomId);
      if (existing) {
        existing.lastTouchedAt = new Date().toISOString();
        return sendJson(response, 200, existing);
      }

      const worker = selectWorker(playerCap);
      worker.roomIds.add(roomId);
      worker.reservedPlayers += playerCap;

      const assignment: RoomAssignment = {
        roomId,
        workerId: worker.id,
        gameServerUrl: worker.gameServerUrl,
        playerCap,
        assignedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString()
      };
      assignments.set(roomId, assignment);
      return sendJson(response, 201, assignment);
    }

    if (request.method === "GET" && request.url?.startsWith("/rooms/") && request.url.endsWith("/route")) {
      const roomId = decodeURIComponent(request.url.slice("/rooms/".length, -"/route".length));
      const assignment = assignments.get(roomId);
      if (!assignment) {
        return sendJson(response, 404, { error: "Room assignment not found" });
      }

      assignment.lastTouchedAt = new Date().toISOString();
      return sendJson(response, 200, assignment);
    }

    if (request.method === "POST" && request.url?.startsWith("/rooms/") && request.url.endsWith("/touch")) {
      const roomId = decodeURIComponent(request.url.slice("/rooms/".length, -"/touch".length));
      const assignment = assignments.get(roomId);
      if (!assignment) {
        return sendJson(response, 404, { error: "Room assignment not found" });
      }

      assignment.lastTouchedAt = new Date().toISOString();
      return sendJson(response, 200, assignment);
    }

    if (request.method === "POST" && request.url?.startsWith("/rooms/") && request.url.endsWith("/release")) {
      const roomId = decodeURIComponent(request.url.slice("/rooms/".length, -"/release".length));
      const assignment = assignments.get(roomId);
      if (!assignment) {
        return sendJson(response, 404, { error: "Room assignment not found" });
      }

      assignments.delete(roomId);
      const worker = workers.find((candidate) => candidate.id === assignment.workerId);
      if (worker) {
        worker.roomIds.delete(roomId);
        worker.reservedPlayers = Math.max(0, worker.reservedPlayers - assignment.playerCap);
      }

      return sendJson(response, 200, { released: true, roomId });
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    log({
      service: "matchmaker",
      level: "error",
      event: "request_failed",
      payload: { message: error instanceof Error ? error.message : String(error) }
    });
    return sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
}).listen(port, () => {
  log({
    service: "matchmaker",
    level: "info",
    event: "server_started",
    payload: {
      port,
      workers: workers.map((worker) => ({
        id: worker.id,
        gameServerUrl: worker.gameServerUrl,
        roomBudget: worker.roomBudget
      }))
    }
  });
});

function parseWorkers(value: string): WorkerState[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [idPart, urlPart, budgetPart] = entry.split("|").map((part) => part.trim());
      return {
        id: idPart || `game-worker-${index + 1}`,
        gameServerUrl: urlPart || defaultGameServerUrl,
        roomBudget: normalizeBudget(budgetPart),
        reservedPlayers: 0,
        roomIds: new Set<string>()
      };
    });
}

function selectWorker(playerCap: number): WorkerState {
  const sorted = workers.slice().sort((left, right) => {
    const leftProjected = left.reservedPlayers + playerCap;
    const rightProjected = right.reservedPlayers + playerCap;
    if (leftProjected !== rightProjected) {
      return leftProjected - rightProjected;
    }

    return left.roomIds.size - right.roomIds.size;
  });

  return sorted[0] ?? {
    id: "game-worker-1",
    gameServerUrl: defaultGameServerUrl,
    roomBudget: 64,
    reservedPlayers: 0,
    roomIds: new Set<string>()
  };
}

function normalizeBudget(value: string | undefined): number {
  const numeric = Number(value ?? "64");
  return Number.isFinite(numeric) ? Math.max(8, Math.round(numeric)) : 64;
}

function clampPlayerCap(value: unknown): number {
  const numeric = Number(value ?? 8);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(8, Math.round(numeric))) : 8;
}

async function readJsonBody(request: AsyncIterable<Buffer>): Promise<Record<string, any> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body: string): void;
  },
  statusCode: number,
  payload: unknown
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}
