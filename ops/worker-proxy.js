const UPSTREAM = "https://mcp-app-validator.pages.dev";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const upstream = new URL(incoming.pathname + incoming.search, UPSTREAM);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(new Request(upstream, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual"
    }));
    const outputHeaders = new Headers(response.headers);
    outputHeaders.set("x-mcp-app-ready-origin", "cloudflare-pages");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
  }
};
