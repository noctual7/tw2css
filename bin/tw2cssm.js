#!/usr/bin/env node
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error('\n✖ ' + (err && err.message ? err.message : err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
