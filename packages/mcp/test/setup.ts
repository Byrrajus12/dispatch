// Preloaded before every test file (see bunfig.toml): with no dispatchd, an
// MCP tool would start the machine hub as a detached process. Tests that
// exercise the hub start one in-process and set DISPATCH_HUB themselves.
process.env.DISPATCH_HUB ??= '0';
// Nothing under test opens a real browser.
process.env.DISPATCH_NO_BROWSER = '1';
