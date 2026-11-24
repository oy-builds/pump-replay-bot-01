// Steady Tape — filtered-momentum paper bot for the pump.fun replay sprint
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy lives in
// strategy.ts and the protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, PARAMS } from './strategy.ts';

await runBot(createStrategy(PARAMS));
