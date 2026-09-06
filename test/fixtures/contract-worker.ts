import { contractProof } from "./contract-proof.js";

export default {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/contract-proof") return Response.json(contractProof());
    return new Response("Not found", { status: 404 });
  },
};
