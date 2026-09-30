'use strict';
const { EventEmitter } = require('node:events');

/**
 * Domain event bus. Every record mutation publishes an event here; the
 * webhook dispatcher and realtime integration sync subscribe to it.
 *
 * Event payload: { type, module, project_id, record, previous, actor, at }
 * Event types:   <module>.created | <module>.updated | <module>.deleted | <module>.status_changed
 */
function createEventBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  bus.publish = (type, payload) => {
    const event = { type, at: new Date().toISOString(), ...payload };
    bus.emit('event', event);
    return event;
  };
  return bus;
}

/** Match an event type against a subscription pattern such as "*", "rfis.*" or "*.status_changed". */
function matchesEvent(pattern, type) {
  if (pattern === '*' || pattern === type) return true;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(type);
}

module.exports = { createEventBus, matchesEvent };
