#!/usr/bin/env node
/** Entry point for the workbuddy-connect CLI. */
import { main } from '../src/cli.js'

main().catch(error => {
  console.error(`workbuddy-connect: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})