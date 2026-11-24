// TwinGate — pump.fun paper-trading entry for
// "Pump.fun Paper Sprint: Any Bot Can Win" (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
//
// The strategy itself lives in strategy.ts; this file only wires it to the
// replay harness. It runs on Node 22 with no dependencies and no network:
// every decision comes from the batches the harness feeds it, so two runs
// of the same data produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createTwinGate } from './strategy.ts';

await runBot(createTwinGate());
