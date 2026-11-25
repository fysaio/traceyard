"use strict";

/* global module */

const NativeDOMException = globalThis.DOMException;

if (typeof NativeDOMException !== "function") {
  throw new Error("TraceYard requires Node.js 22.12 or newer with native DOMException support.");
}

module.exports = NativeDOMException;
