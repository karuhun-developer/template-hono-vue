import { pino, type Logger } from 'pino'

import { env } from '#env'

/**
 * One logger for the whole process. Handlers do not import it directly — they use
 * `c.get('logger')`, which already carries the `requestId` (see
 * `middleware/request-context`) so that every line belonging to one request can be
 * stitched back together in the log aggregator.
 */
export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { app: env.APP_NAME },
  redact: {
    // No secret ever reaches a log aggregator.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.apiKey',
      '*.secret',
      // A link is a credential too. An invitation or reset URL sitting in a log aggregator
      // is a live way into somebody's account, and it does not look like one at a glance.
      '*.inviteToken',
      '*.resetToken',
      '*.inviteUrl',
      '*.resetUrl',
    ],
    censor: '[redacted]',
  },
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app' },
        },
      }
    : {}),
})
