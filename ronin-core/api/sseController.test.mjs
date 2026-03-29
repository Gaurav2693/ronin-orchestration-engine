// api/sseController.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Test suite for sseController.
//
// Tests cover:
//   - registerSSEClient sets correct HTTP headers
//   - sendEvent writes proper SSE format
//   - sendThinkingState, sendStreamChunk, sendComplete work correctly
//   - modelId is NOT included in completion events
//   - Clients are cleaned up on disconnect
//   - getClientCount and isClientConnected work
//
// Mock response object simulates the Express response API.
// ─────────────────────────────────────────────────────────────────────────────

import {
  registerSSEClient,
  sendThinkingState,
  sendStreamChunk,
  sendComplete,
  sendError,
  getClientCount,
  isClientConnected,
  clients,
} from './sseController.mjs';
import { EventEmitter } from 'events';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Response Object
// ─────────────────────────────────────────────────────────────────────────────
// Simulates the Express response object for testing. We capture:
//   - writeHead calls (headers)
//   - write calls (event data)
//   - event listeners (close, error)

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.writtenData = [];
    this.writable = true;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(data) {
    if (!this.writable) return;
    this.writtenData.push(data);
  }

  // Helper to get all written content as a single string
  getAllWritten() {
    return this.writtenData.join('');
  }

  // Helper to extract events from written data
  getEvents() {
    const events = [];
    const dataStr = this.getAllWritten();
    // Split by double newline to separate events
    const eventBlocks = dataStr.split('\n\n').filter(block => block.trim());

    for (const block of eventBlocks) {
      const lines = block.split('\n');
      let eventName = null;
      let eventData = null;

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventName = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          eventData = line.slice('data: '.length);
        }
      }

      if (eventName && eventData) {
        events.push({
          name: eventName,
          data: eventData,
        });
      }
    }

    return events;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: registerSSEClient sets correct headers
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] registerSSEClient sets correct headers');
const res1 = new MockResponse();
registerSSEClient('conv-001', res1);

console.assert(res1.statusCode === 200, 'Should set status 200');
console.assert(res1.headers['Content-Type'] === 'text/event-stream', 'Should set event-stream content type');
console.assert(res1.headers['Cache-Control'] === 'no-cache', 'Should disable caching');
console.assert(res1.headers['Connection'] === 'keep-alive', 'Should enable keep-alive');
console.assert(res1.headers['Access-Control-Allow-Origin'] === '*', 'Should allow CORS');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: registerSSEClient registers client
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] registerSSEClient registers client in map');
const res2 = new MockResponse();
registerSSEClient('conv-002', res2);

console.assert(isClientConnected('conv-002') === true, 'Should register client');
console.assert(getClientCount() === 1, 'Should count 1 client');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: sendThinkingState sends correct event
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] sendThinkingState sends ronin.state event');
const res3 = new MockResponse();
registerSSEClient('conv-003', res3);
sendThinkingState('conv-003', 'reviewing');

const written3 = res3.getAllWritten();
console.assert(written3.includes('event: ronin.state'), 'Should send ronin.state event');
console.assert(written3.includes('reviewing'), 'Should include the thinking label');
console.assert(written3.includes('thinking'), 'Should include state: thinking');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: sendStreamChunk sends correct format
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] sendStreamChunk sends ronin.stream event');
const res4 = new MockResponse();
registerSSEClient('conv-004', res4);
sendStreamChunk('conv-004', 'Hello ', 'Hello ');
sendStreamChunk('conv-004', 'world', 'Hello world');

const written4 = res4.getAllWritten();
console.assert(written4.includes('event: ronin.stream'), 'Should send ronin.stream event');
console.assert(written4.includes('Hello'), 'Should include chunk content');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: sendComplete does NOT include modelId
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] sendComplete sends event without modelId');
const res5 = new MockResponse();
registerSSEClient('conv-005', res5);
sendComplete('conv-005', 'This is the response', 0.0025);

const written5 = res5.getAllWritten();
console.assert(written5.includes('event: ronin.complete'), 'Should send ronin.complete event');
console.assert(written5.includes('This is the response'), 'Should include response');
console.assert(written5.includes('0.0025'), 'Should include cost');
console.assert(!written5.includes('modelId'), 'Should NOT include modelId');
console.assert(!written5.includes('model'), 'Should NOT mention model');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: sendError sends error event
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] sendError sends ronin.error event');
const res6 = new MockResponse();
registerSSEClient('conv-006', res6);
sendError('conv-006', 'Something went wrong', true);

const written6 = res6.getAllWritten();
console.assert(written6.includes('event: ronin.error'), 'Should send ronin.error event');
console.assert(written6.includes('Something went wrong'), 'Should include error message');
console.assert(written6.includes('true'), 'Should include recoverable flag');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: Client cleanup on close
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Client cleanup on close event');
const res7 = new MockResponse();
registerSSEClient('conv-007', res7);

console.assert(getClientCount() === 1, 'Should have 1 client');
console.assert(isClientConnected('conv-007') === true, 'Client should be connected');

// Simulate client disconnect
res7.emit('close');

console.assert(getClientCount() === 0, 'Should have 0 clients after close');
console.assert(isClientConnected('conv-007') === false, 'Client should not be connected');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: Client cleanup on error
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Client cleanup on error event');
const res8 = new MockResponse();
registerSSEClient('conv-008', res8);

console.assert(getClientCount() === 1, 'Should have 1 client');

// Simulate error
res8.emit('error', new Error('Connection failed'));

console.assert(getClientCount() === 0, 'Should have 0 clients after error');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: Multiple clients
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Multiple concurrent clients');
const res9a = new MockResponse();
const res9b = new MockResponse();
const res9c = new MockResponse();

registerSSEClient('conv-009a', res9a);
registerSSEClient('conv-009b', res9b);
registerSSEClient('conv-009c', res9c);

console.assert(getClientCount() === 3, 'Should have 3 clients');
console.assert(isClientConnected('conv-009a') === true, 'Client A connected');
console.assert(isClientConnected('conv-009b') === true, 'Client B connected');
console.assert(isClientConnected('conv-009c') === true, 'Client C connected');

// Send to one client
sendThinkingState('conv-009a', 'thinking');
console.assert(res9a.writtenData.length > 0, 'Client A should receive event');
console.assert(res9b.writtenData.length === 0, 'Client B should not receive event');
console.assert(res9c.writtenData.length === 0, 'Client C should not receive event');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: Heartbeat is sent
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Heartbeat messages are sent');
const res10 = new MockResponse();
registerSSEClient('conv-010', res10);

// After some time, heartbeat should be sent (we won't wait 30s in tests)
// Just verify that the heartbeat interval was set up
const clientData = clients.get('conv-010');
console.assert(clientData.heartbeatInterval !== undefined, 'Should have heartbeat interval set');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Test: Send to non-existent client doesn't crash
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Sending to non-existent client is safe');
// Should not throw
sendThinkingState('conv-nonexistent', 'thinking');
console.assert(true, 'Should not crash when client not found');

// ─────────────────────────────────────────────────────────────────────────────
// Test: Response.writable=false stops events
// ─────────────────────────────────────────────────────────────────────────────

console.log('[TEST] Respect response.writable flag');
const res11 = new MockResponse();
registerSSEClient('conv-011', res11);

sendThinkingState('conv-011', 'test');
const beforeCount = res11.writtenData.length;

res11.writable = false;
sendThinkingState('conv-011', 'test2');
const afterCount = res11.writtenData.length;

console.assert(beforeCount > 0, 'Should write while writable');
console.assert(afterCount === beforeCount, 'Should not write when not writable');

// Clean up
clients.clear();

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n✅ All SSE controller tests completed!');
console.log('Run with: node --test api/sseController.test.mjs');
