/**
 * Vercel Cron endpoint for refreshing materialized views
 * Triggered every 15 minutes by Vercel Cron Jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers';

export const runtime = 'edge';
export const maxDuration = 60;

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
    console.log('[Cron] Refreshing aggregates at:', new Date().toISOString());

    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
        },
      }
    );

    // Call the refresh function
    const { error } = await supabase.rpc('refresh_cost_records_daily');

    if (error) {
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: 'Aggregates refreshed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Cron] Aggregate refresh failed:', error);
    return NextResponse.json(
      { error: 'Refresh failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
