/**
 * Vercel Cron endpoint for running ML forecasting
 * Triggered daily at midnight by Vercel Cron Jobs
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';
export const maxDuration = 300; // 5 minutes max

export async function GET(request: NextRequest) {
  // Verify cron secret for security
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    console.log('[Cron] Forecasting triggered at:', new Date().toISOString());

    // TODO: Call Python forecasting service or implement in TypeScript

    return NextResponse.json({
      success: true,
      message: 'Forecasting completed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Cron] Forecasting failed:', error);
    return NextResponse.json(
      { error: 'Forecasting failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
