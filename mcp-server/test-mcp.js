
const readline = require("readline");
const crypto = require("crypto");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Enter your MCP token: ", async (token) => {
  try {
    const response = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-03-26"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "student-management-test",
            version: "1.0.0"
          }
        }
      })
    });

    console.log("Initialization HTTP status:", response.status);

    const sessionId = response.headers.get("mcp-session-id");
    const body = await response.text();
    console.log("Session ID received:", Boolean(sessionId));
    console.log("Initialization response:", body);

    if (!response.ok || !sessionId) {
      throw new Error("Initialization failed or no session ID was returned.");
    }

    const initialized = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-03-26",
        "MCP-Session-Id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      })
    });

    console.log("Initialized notification HTTP status:", initialized.status);
    await initialized.text();

    const toolsResponse = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-03-26",
        "MCP-Session-Id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });

    console.log("Tools/list HTTP status:", toolsResponse.status);
    console.log("Tools/list response:", await toolsResponse.text());

    if (!toolsResponse.ok) {
      throw new Error("The server did not successfully list its tools.");
    }

    console.log("Test completed. Check the response above.");
  } catch (error) {
    console.error("TEST FAILED:", error.message);
  } finally {
    rl.close();
  }
});
