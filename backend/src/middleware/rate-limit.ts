/**
 * Simple in-memory rate limiter middleware.
 *
 * Tracks requests per IP using a sliding window. No external dependencies.
 * Supports different limits for different route groups.
 */

import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window per IP
  message?: string;      // Error message for 429 responses
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

// Cleanup old entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [, store] of stores) {
    for (const [ip, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < 300000); // Keep 5 min max
      if (entry.timestamps.length === 0) {
        store.delete(ip);
      }
    }
  }
}, 60000);

function getClientIp(req: Request): string {
  // Support proxied requests
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Creates a rate limiting middleware with the given config.
 *
 * Usage:
 *   app.use("/api/chat", rateLimit({ windowMs: 60000, maxRequests: 30 }));
 */
export function rateLimit(config: RateLimitConfig) {
  const {
    windowMs = 60000,
    maxRequests = 60,
    message = "Too many requests. Please slow down.",
  } = config;

  const storeKey = `${windowMs}-${maxRequests}`;
  if (!stores.has(storeKey)) {
    stores.set(storeKey, new Map());
  }
  const store = stores.get(storeKey)!;

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const now = Date.now();

    if (!store.has(ip)) {
      store.set(ip, { timestamps: [] });
    }
    const entry = store.get(ip)!;

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((entry.timestamps[0] + windowMs - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      res.set("X-RateLimit-Limit", String(maxRequests));
      res.set("X-RateLimit-Remaining", "0");
      res.set("X-RateLimit-Reset", String(Math.ceil((entry.timestamps[0] + windowMs) / 1000)));
      res.status(429).json({ error: message, retry_after_seconds: retryAfter });
      return;
    }

    entry.timestamps.push(now);

    // Set rate limit headers
    res.set("X-RateLimit-Limit", String(maxRequests));
    res.set("X-RateLimit-Remaining", String(maxRequests - entry.timestamps.length));
    res.set("X-RateLimit-Reset", String(Math.ceil((now + windowMs) / 1000)));

    next();
  };
}

/**
 * Preset rate limiters for common use cases.
 */
export const rateLimits = {
  /** Standard API: 120 req/min per IP */
  standard: rateLimit({ windowMs: 60000, maxRequests: 120 }),

  /** Chat/LLM calls: 30 req/min per IP (more expensive) */
  chat: rateLimit({ windowMs: 60000, maxRequests: 30, message: "Chat rate limit exceeded. Max 30 requests per minute." }),

  /** Bulk operations: 10 req/min per IP */
  bulk: rateLimit({ windowMs: 60000, maxRequests: 10, message: "Bulk operation rate limit exceeded." }),

  /** Write operations: 60 req/min per IP */
  write: rateLimit({ windowMs: 60000, maxRequests: 60 }),
};
