// bun test preload (bunfig.toml): the environment every unit test process
// starts with. Q1TS_NOHOMEDIR=1 is COM_DefaultHomeDir's `-nohomedir`, so a boot
// that passes no -homedir writes into its basedir (a scratch tree in every
// suite) and never into the real per-user directory. `bun run test` exported it
// already; a bare `bun test <file>` did not, and left folders behind.
if (process.env["Q1TS_NOHOMEDIR"] === undefined) process.env["Q1TS_NOHOMEDIR"] = "1";
