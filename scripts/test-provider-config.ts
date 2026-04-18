import { createOpencodeClient } from "@opencode-ai/sdk";

async function testProviderConfig() {
  const client = createOpencodeClient({
    baseURL: "http://localhost:7777",
  });

  try {
    const config = await client.config.get({ throwOnError: true });
    console.log("Full config keys:", Object.keys(config.data));
    console.log("\nProvider field:", JSON.stringify(config.data.provider, null, 2));
    
    // Try to access provider
    const providers = (config.data as any).provider;
    if (providers) {
      console.log("\nProvider keys:", Object.keys(providers));
      const firstProvider = Object.keys(providers)[0];
      console.log("\nFirst provider:", firstProvider);
      console.log("Provider data:", JSON.stringify(providers[firstProvider], null, 2));
    } else {
      console.log("\nNo provider field found in config");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

testProviderConfig();
