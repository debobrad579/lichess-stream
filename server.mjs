import express from 'express';
import fetch from 'node-fetch';
const app = express();

const broadcasts = new Map();

app.get('/:broadcastRoundId', async (req, res) => {
  const broadcastRoundId = req.params.broadcastRoundId;

  let broadcastPromise = broadcasts.get(broadcastRoundId);

  if (!broadcastPromise) {
    console.log(`Starting new upstream for round: ${broadcastRoundId}`);

    broadcastPromise = (async () => {
      const abortController = new AbortController();

      const upstreamRes = await fetch(
        `https://lichess.org/api/stream/broadcast/round/${broadcastRoundId}.pgn`,
        {
          headers: { Accept: 'application/x-ndjson' },
          signal: abortController.signal,
        }
      );

      if (!upstreamRes.ok) {
        throw new Error(`Upstream error: ${upstreamRes.status} ${upstreamRes.statusText}`);
      }

      const clients = new Set();

      upstreamRes.body.on('data', (chunk) => {
        const text = chunk.toString();

        for (const client of clients) {
          client.write(`data: ${text}\n\n`);
        }
      });

      upstreamRes.body.on('end', () => {
        console.log(`Upstream closed for round ${broadcastRoundId}`);
        broadcasts.delete(broadcastRoundId);

        for (const client of clients) {
          client.end();
        }
      });

      upstreamRes.body.on('error', (err) => {
        if (err.name === 'AbortError') {
          console.log(`Upstream for round ${broadcastRoundId} aborted normally.`);
        } else {
          console.error('Upstream stream error:', err);
        }
      
        broadcasts.delete(broadcastRoundId);
      
        for (const client of clients) {
          client.end();
        }
      });

      return { clients, abortController, upstreamRes };
    })();

    broadcasts.set(broadcastRoundId, broadcastPromise);
  }

  const broadcast = await broadcastPromise;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 60000)

  const client = { res, heartbeat };
  broadcast.clients.add(client);

  broadcast.clients.add(res);

  res.write(`: connected to round ${broadcastRoundId}\n\n`);

  console.log(`Client connected to round ${broadcastRoundId}. Total clients: ${broadcast.clients.size}`);

  req.on('close', () => {
    clearInterval(heartbeat);
    broadcast.clients.delete(res);
    console.log(`Client disconnected from round ${broadcastRoundId}. Remaining clients: ${broadcast.clients.size}`);

    if (broadcast.clients.size === 0) {
      console.log(`No clients left. Aborting upstream for round ${broadcastRoundId}`);
      broadcast.abortController.abort();
      broadcast.upstreamRes.body.destroy();
      broadcasts.delete(broadcastRoundId);
    }
  });
});

app.listen(process.env.PORT || 5000);
