import { send, type Req, type Res } from "../server/http.js";
import { stats } from "../server/log.js";

export default async function handler(_req: Req, res: Res) {
  send(res, 200, { stats: await stats() });
}
