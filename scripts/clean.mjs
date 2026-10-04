// Remove the build output before a build, so a package never ships files
// whose source is gone (tsc never deletes stale output).
import { rmSync } from 'node:fs'

for (const directory of ['lib', 'client']) rmSync(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true })
