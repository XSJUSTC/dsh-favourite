/** Run every dsh-favorites test file. */
for (const file of ['./host.test.mjs', './client.test.mjs']) {
  await import(file)
}
