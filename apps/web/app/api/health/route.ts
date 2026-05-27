import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'mira-web',
    timestamp: new Date().toISOString(),
  });
}
