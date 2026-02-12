/**
 * Sentry configuration for Edge Runtime error tracking.
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
});
