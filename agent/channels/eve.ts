import { localDev, vercelOidc } from "eve/channels/auth";
import { type EveAuthFn, eveChannel } from "eve/channels/eve";

// eve's HTTP API. Deployed, only callers with a Vercel OIDC token for this
// team get in. Under `eve dev`, local callers get in and may stub tools, which
// is what `eve eval` needs.
const local = localDev();
const localWithStubs: EveAuthFn = async (request) => {
  const caller = await local(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({ auth: [vercelOidc(), localWithStubs] });
