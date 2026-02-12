/**
 * Sentry configuration for client-side error tracking.
 * This file is automatically included by Next.js when Sentry is installed.
 */

import * as Sentry from '@sentry/nextjs';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: SENTRY_DSN,

  // Environment name
  environment: process.env.NEXT_PUBLIC_ENVIRONMENT || 'development',

  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: parseFloat(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || '0.1'),

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // Replay sessions for debugging
  replaysOnErrorSampleRate: 1.0, // Capture 100% of sessions with errors
  replaysSessionSampleRate: 0.1, // Capture 10% of all sessions

  integrations: [
    Sentry.replayIntegration({
      // Additional SDK configuration goes in here, for example:
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],

  // Filter out certain errors
  beforeSend(event, hint) {
    // Filter out expected errors
    const error = hint.originalException;

    if (error && typeof error === 'object' && 'message' in error) {
      const message = String(error.message);

      // Don't send these common errors to Sentry
      const ignoredPatterns = [
        /ResizeObserver loop limit exceeded/i,
        /Loading chunk \d+ failed/i,
        /Network Error/i,
      ];

      if (ignoredPatterns.some(pattern => pattern.test(message))) {
        return null;
      }
    }

    return event;
  },
});
