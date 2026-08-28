import { NextRequest, NextResponse } from "next/server";
import {
  isMaintenanceBypassPath,
  maintenanceApiBody,
  maintenanceHeaders,
  maintenanceHtml,
} from "./lib/maintenance-gate";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isMaintenanceBypassPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return new NextResponse(maintenanceApiBody, {
      status: 503,
      headers: maintenanceHeaders("application/json; charset=utf-8"),
    });
  }

  return new NextResponse(maintenanceHtml, {
    status: 503,
    headers: maintenanceHeaders("text/html; charset=utf-8"),
  });
}

export const config = {
  matcher: "/:path*",
};
