const serverUrl = process.argv[2];

if (!serverUrl) {
  console.error("Server URL is required");
  process.exit(2);
}

try {
  const response = await fetch(new URL("/api/health", serverUrl));
  if (!response.ok) {
    console.error(`Server health check returned HTTP ${response.status}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`Server TLS health check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
