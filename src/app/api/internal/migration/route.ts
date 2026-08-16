import { NextRequest, NextResponse } from "next/server";
import { abortMigration, authorizeMigration, beginMigration, finalizeMigration, importMigrationChunk } from "@/lib/migration";

export async function POST(request: NextRequest) {
  try {
    const claims = await authorizeMigration(request.headers);
    const sourceSha = String(claims.sha);
    const body = await request.json<Record<string, unknown>>();
    if (body.action === "begin") return NextResponse.json(await beginMigration(body.manifest, sourceSha));
    if (body.action === "chunk") return NextResponse.json(await importMigrationChunk(body, sourceSha));
    if (body.action === "finalize") return NextResponse.json(await finalizeMigration(body.runId, sourceSha));
    if (body.action === "abort") return NextResponse.json(await abortMigration(body.runId, sourceSha));
    return NextResponse.json({ ok: false, error: "Migration action is invalid." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Migration request failed.";
    const status = /authorization|disabled/u.test(message.toLowerCase()) ? 403 : /invalid|match|approved|incomplete/u.test(message.toLowerCase()) ? 400 : 409;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
