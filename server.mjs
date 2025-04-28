import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

const PORT = process.env.PORT || 5000;
const wss = new WebSocketServer({ port: PORT });

const broadcasts = new Map();

console.log(`WebSocket server listening on port ${PORT}`);

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const roundId = url.pathname.slice(1);

  if (!roundId) {
    ws.close(1008, 'Missing roundId in URL');
    return;
  }

  console.log(`Client connected for round ${roundId}`);

  let broadcast = broadcasts.get(roundId);

  if (!broadcast) {
    console.log(`Starting new upstream for round: ${roundId}`);

    const abortController = new AbortController();
    const clients = new Set();

    const upstreamRes = await fetch(
      `https://lichess.org/api/stream/broadcast/round/${roundId}.pgn`,
      {
        headers: { Accept: 'application/x-ndjson' },
        signal: abortController.signal,
      }
    );

    if (!upstreamRes.ok) {
      console.error(`Upstream error ${upstreamRes.status} ${upstreamRes.statusText}`);
      ws.close(1011, 'Failed to connect upstream');
      return;
    }

    upstreamRes.body.on('data', (chunk) => {
      const text = chunk.toString();

      for (const client of clients) {
        if (client.readyState === client.OPEN) {
          client.send(text);
        }
      }
    });

    upstreamRes.body.on('end', () => {
      console.log(`Upstream closed for round ${roundId}`);
      broadcasts.delete(roundId);

      for (const client of clients) {
        client.close(1000, 'Upstream ended');
      }
    });

    upstreamRes.body.on('error', (err) => {
      console.error('Upstream stream error:', err);
      broadcasts.delete(roundId);

      for (const client of clients) {
        client.close(1011, 'Upstream error');
      }
    });

    broadcast = { clients, abortController };
    broadcasts.set(roundId, broadcast);
  }

  broadcast.clients.add(ws);

  ws.on('close', () => {
    console.log(`Client disconnected from round ${roundId}`);
    broadcast.clients.delete(ws);

    if (broadcast.clients.size === 0) {
      console.log(`No clients left for round ${roundId}. Aborting upstream.`);
      broadcast.abortController.abort();
      broadcasts.delete(roundId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});
