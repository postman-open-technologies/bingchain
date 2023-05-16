#!/bin/sh
echo Starting paused. Open chrome://inspect or go to about:inspect to start.
node --experimental_vm_modules --predictable_gc_schedule --no-warnings --inspect-brk index.mjs
