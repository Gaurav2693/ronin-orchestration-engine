// api/sseController.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Server-Sent Events (SSE) handler for streaming responses to the macOS SwiftUI client.
//
// SSE is a simple HTTP protocol for one-way streaming: the server sends events
// to the client as they happen (thinking, streaming chunks, completion, errors).
// This keeps the client UI responsive without polling.
//
// Architecture:
//   - clients Map stores active connections by conversationId
//   - Heartbeat every 30s keeps the connection alive (prevents timeouts)
//   - Events are JSON objects wrapped in SSE format (event: name\ndata: json\n\n)
//   - modelId is NEVER sent to the client (operator UI doesn't care which model runs)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// State: Active SSE Connections
// ─────────────────────────────────────────────────────────────────────────────
// Map of conversationId → { res, heartbeatInterval }
// res is the Express response object; heartbeatInterval is the NodeJS timer ID.

const clients = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// registerSSEClient(conversationId, res)
// ─────────────────────────────────────────────────────────────────────────────
// Call this when a client initiates an SSE connection. Sets up the response
// headers, starts a heartbeat, and registers the client for future events.
//
// The heartbeat (every 30s) is important: HTTP proxies and firewalls may drop
// idle connections. By sending periodic ": heartbeat\n\n" comments, we keep
// the connection alive.
//
// When the client disconnects (intentionally or due to network failure), the
// 'close' event fires and we clean up.

export function registerSSEClient(conversationId, res) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Start heartbeat: send a comment every 30 seconds
  // Comments (lines starting with :) are ignored by clients but keep the connection alive
  const heartbeatInterval = setInterval(() => {
    if (res.writable) {
      res.write(': heartbeat\n\n');
    }
  }, 30_000);

  // Store the connection
  clients.set(conversationId, {
    res,
    heartbeatInterval,
  });

  // Clean up when client disconnects
  res.on('close', () => {
    const client = clients.get(conversationId);
    if (client) {
      clearInterval(client.heartbeatInterval);
      clients.delete(conversationId);
    }
  });

  // Also clean up on error
  res.on('error', () => {
    const client = clients.get(conversationId);
    if (client) {
      clearInterval(client.heartbeatInterval);
      clients.delete(conversationId);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendEvent(conversationId, event, data)
// ─────────────────────────────────────────────────────────────────────────────
// Low-level helper: sends an SSE-formatted event to a connected client.
//
// SSE format:
//   event: {name}
//   data: {json string}
//
// (blank line)

function sendEvent(conversationId, event, data) {
  const client = clients.get(conversationId);
  if (!client) {
    console.warn(`[sseController] No client for conversationId: ${conversationId}`);
    return;
  }

  if (!client.res.writable) {
    return;
  }

  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  client.res.write(`event: ${event}\ndata: ${dataStr}\n\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendThinkingState(conversationId, label)
// ─────────────────────────────────────────────────────────────────────────────
// Sends a "thinking" state to the UI, e.g., "RONIN is reviewing..." or
// "RONIN is thinking...". Used during the waiting period before streaming starts.
//
// The UI uses this to show a loading spinner with contextual text.

export function sendThinkingState(conversationId, label) {
  sendEvent(conversationId, 'ronin.state', {
    state: 'thinking',
    label,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendStreamChunk(conversationId, content, accumulated)
// ─────────────────────────────────────────────────────────────────────────────
// Sends a chunk of streamed model output to the client.
//
// Parameters:
//   content    — the new text chunk (e.g., one token or a few words)
//   accumulated — the full response so far (allows client to render incrementally)

export function sendStreamChunk(conversationId, content, accumulated) {
  sendEvent(conversationId, 'ronin.stream', {
    chunk: content,
    accumulated,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendComplete(conversationId, fullResponse, costUsd)
// ─────────────────────────────────────────────────────────────────────────────
// Sends the final completion event. The client UI will hide the spinner,
// show the full response, and update the cost counter.
//
// IMPORTANT: modelId is intentionally NOT included.
// The operator UI doesn't care which model powered a response — they care about
// the result and cost. This also prevents model swaps from being visible.

export function sendComplete(conversationId, fullResponse, costUsd) {
  sendEvent(conversationId, 'ronin.complete', {
    response: fullResponse,
    costUsd,
    // NOTE: modelId is NOT included
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendError(conversationId, message, recoverable)
// ─────────────────────────────────────────────────────────────────────────────
// Sends an error event to the client.
//
// Parameters:
//   message    — the error description to show the user
//   recoverable — if true, the UI shows a "retry" button; if false, it's fatal

export function sendError(conversationId, message, recoverable = false) {
  sendEvent(conversationId, 'ronin.error', {
    message,
    recoverable,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getClientCount()
// ─────────────────────────────────────────────────────────────────────────────
// Returns the number of currently connected SSE clients.
// Useful for monitoring and load balancing.

export function getClientCount() {
  return clients.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// isClientConnected(conversationId)
// ─────────────────────────────────────────────────────────────────────────────
// Checks if a specific client is connected.
// Useful before attempting to send events.

export function isClientConnected(conversationId) {
  return clients.has(conversationId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export the internal clients Map for testing
// ─────────────────────────────────────────────────────────────────────────────
// Tests need to inspect or clear the Map.

export { clients };
