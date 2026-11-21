// The agent's handle on the team's Vercel Board. On Vercel it acts as this
// project with the deployment's OIDC token; under `eve dev` it acts as you,
// with your `vercel login`. Creating it does no I/O.

import { board } from "@vercel/board";

export const team = board();
