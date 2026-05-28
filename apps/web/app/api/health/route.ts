import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'haru-web',
    timestamp: new Date().toISOString(),
  });
}
