import { Construct } from "constructs";
import * as appconfig from "aws-cdk-lib/aws-appconfig";
import { CfnProject } from "aws-cdk-lib/aws-evidently";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { MicrowsDynamoDBTable } from "./dynamo.js";
import { MicrowsLambdaFunction } from "./lambda.js";
import { fileURLToPath } from "url";
import { Duration } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

interface MicrowsStaticProps {
  name: string;
}
export function MicrowsStatic(scope: Construct, props: MicrowsStaticProps) {
  const application = new appconfig.Application(scope, `${props.name}AppConfigApplication`, {});
  const environment = new appconfig.Environment(scope, `${props.name}AppConfigEnvironment`, {
    application,
  });
  const noBakeEnvironment = new appconfig.Environment(scope, `${props.name}AppConfigNoBakeEnvironment`, {
    application,
  });
  const deploymentStrategy = new appconfig.DeploymentStrategy(scope, `${props.name}DeploymentStrategy`, {
    rolloutStrategy: appconfig.RolloutStrategy.linear({
      growthFactor: 100,
      deploymentDuration: Duration.minutes(0),
      finalBakeTime: Duration.minutes(0),
    }),
  });

  const appConfigLambda = MicrowsLambdaFunction(scope, `${props.name}NoBakeTransferFunction`, {
    entry: fileURLToPath(new URL("../lambda/appConfigExtension.js", import.meta.url)),
    environment: {
      APPCONFIG_ENVIRONMENT_ID: noBakeEnvironment.environmentId,
      APPCONFIG_STRATEGY_ID: deploymentStrategy.deploymentStrategyId,
    },
    initialPolicy: [
      new PolicyStatement({
        actions: ["appconfig:StartDeployment"],
        resources: [
          application.applicationArn,
          application.applicationArn + "/*",
          deploymentStrategy.deploymentStrategyArn,
        ],
      }),
    ],
  });

  environment.addExtension(
    new appconfig.Extension(scope, `${props.name}NoBakeExtension`, {
      actions: [
        new appconfig.Action({
          actionPoints: [appconfig.ActionPoint.PRE_START_DEPLOYMENT],
          eventDestination: new appconfig.LambdaDestination(appConfigLambda),
        }),
      ],
    }),
  );
  let evidently = new CfnProject(scope, `${props.name}Evidently`, {
    name: props.name,
    appConfigResource: {
      applicationId: application.applicationId,
      environmentId: environment.environmentId,
    },
  });

  let bucket = new Bucket(scope, "MicrowsStaticBucket", {});
  let table = MicrowsDynamoDBTable(scope, "MicrowsStaticTable", {
    autoIndexes: 5,
    gsiIndexes: 3,
    headerIndex: true,
    projIndexes: 2,
  });

  new Bucket(scope, `${props.name}StaticBucket`, {});
  MicrowsDynamoDBTable(scope, `${props.name}StaticTable`, {
    autoIndexes: 5,
    gsiIndexes: 3,
    headerIndex: true,
    projIndexes: 2,
  });
  return {
    appConfig: {
      application,
      environment: noBakeEnvironment,
      configuration: `/applications/${application.applicationId}/environments/${noBakeEnvironment.environmentId}/configurations/${evidently.name}`,
    },
    evidently,
    bucket,
    table,
  };
}
