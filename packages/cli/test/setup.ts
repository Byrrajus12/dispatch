// Preloaded before every test file (see bunfig.toml): most tests call `init`
// or `doctor` only as setup and must not spawn whatever carto is installed
// here. Tests that need carto present clear this var and stub the binary.
process.env.DISPATCH_CARTO_DISABLED = '1';
// `dispatch mcp` with no dispatchd would start the machine hub; tests never.
process.env.DISPATCH_HUB = '0';
process.env.DISPATCH_NO_BROWSER = '1';
