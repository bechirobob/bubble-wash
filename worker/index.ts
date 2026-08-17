import handler from "vinext/server/app-router-entry";
import { processNotificationOutbox } from "../src/lib/notifications";
import { operationsDataMetrics, purgeOperationalData } from "../src/lib/data-store";

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), payment=(self), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self)");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-BubbleWash-Render", "worker");
  headers.delete("X-Powered-By");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function runScheduledOperations(controller: ScheduledController) {
  const delivered = await processNotificationOutbox(50);
  const purged = await purgeOperationalData();
  const metrics = await operationsDataMetrics();
  console.log(JSON.stringify({
    message: "scheduled maintenance completed",
    cron: controller.cron,
    deliveryAttempts: delivered.length,
    purged,
    metrics,
  }));
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      return secureResponse(await handler.fetch(request, env, ctx));
    } catch (error) {
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return secureResponse(Response.json({ error: "The service could not complete this request." }, { status: 500 }));
    }
  },
  async scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledOperations(controller));
  },
};

export default worker satisfies ExportedHandler<Cloudflare.Env>;
