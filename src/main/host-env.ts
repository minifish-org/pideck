import { terminalEnvironment } from "../host/shell-env";

export function hostEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = terminalEnvironment(source);
  for (const [name, value] of Object.entries(source)) {
    if (value && /(?:_API_KEY$|^(?:AWS_|AZURE_OPENAI_|ANTHROPIC_|CLOUDFLARE_|GOOGLE_|GCLOUD_|OPENAI_|RADIUS_|COPILOT_)|^(?:HF_TOKEN|GITHUB_TOKEN|GH_TOKEN|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS)$)/i.test(name)) {
      env[name] = value;
    }
  }
  return env;
}
