import { contractProof } from "./contract-proof.js";

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/contract-proof") return Response.json(await contractProof());
    return new Response("Not found", { status: 404 });
  },
};
