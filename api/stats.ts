import { guarded, send } from "../server/http.js";
import { stats } from "../server/store.js";

export default guarded(async (_req, res) => {
  send(res, 200, { stats: await stats() });
});
