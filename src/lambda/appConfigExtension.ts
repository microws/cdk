import { AppConfigClient, StartDeploymentCommand } from "@aws-sdk/client-appconfig";
const client = new AppConfigClient({});

export async function handler(event: any, context): Promise<any> {
  const response = await client.send(
    new StartDeploymentCommand({
      ApplicationId: event.Application.Id,
      EnvironmentId: process.env.APPCONFIG_ENVIRONMENT_ID,
      DeploymentStrategyId: process.env.APPCONFIG_STRATEGY_ID,
      ConfigurationProfileId: event.ConfigurationProfile.Id,
      ConfigurationVersion: event.ContentVersion,
      Description: "Microws=true",
    }),
  );
}
