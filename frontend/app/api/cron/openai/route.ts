/**
 * Vercel Cron endpoint for OpenAI data collection
 * Triggered every 6 hours at :10 by Vercel Cron Jobs
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
    console.log('[Cron] OpenAI collection triggered at:', new Date().toISOString());

    return NextResponse.json({
      success: true,
      provider: 'openai',
      message: 'Collection triggered successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Cron] OpenAI collection failed:', error);
    return NextResponse.json(
      { error: 'Collection failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
