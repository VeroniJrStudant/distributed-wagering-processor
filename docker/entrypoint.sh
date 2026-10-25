#!/bin/sh
set -eu
bun src/infrastructure/persistence/migrate.ts up
exec bun src/main.ts
