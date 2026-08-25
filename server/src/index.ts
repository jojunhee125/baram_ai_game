import { createGameServer, resolvePort } from "./server";

const port = resolvePort(process.env.PORT);
await createGameServer().listen(port);
console.log(
  `[zep-test] listening on port ${port} — client at /, matchmaking at /matchmake, health at /api/health`,
);
