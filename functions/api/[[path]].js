import {handleRequest} from "../../cloudflare/worker.js";

export function onRequest(context) {
  return handleRequest(context.request, context.env);
}
