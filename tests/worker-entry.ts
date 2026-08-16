export default {
  fetch() {
    return Response.json({ ok: true, runtime: "workerd" });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
