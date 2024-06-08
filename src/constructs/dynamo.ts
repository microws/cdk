import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { IEventBus } from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Function } from "aws-cdk-lib/aws-lambda";
import { MicrowsLambdaFunction } from "./lambda.js";
import { fileURLToPath } from "url";

export function MicrowsDynamoDBTable(
  scope: Construct,
  id: string,
  props: {
    headerIndex: boolean;
    gsiIndexes: number;
    projIndexes: number;
    autoIndexes: number;
    eventBus?: IEventBus;
    environment?: {
      stage: "prod" | "dev";
      domain: string;
      service: string;
    };
  },
) {
  const table = new Table(scope, id, {
    partitionKey: {
      name: "PK",
      type: AttributeType.STRING,
    },
    sortKey: {
      name: "SK",
      type: AttributeType.STRING,
    },
    billingMode: BillingMode.PAY_PER_REQUEST,
    pointInTimeRecovery: true,
    removalPolicy: RemovalPolicy.RETAIN,
    stream: StreamViewType.NEW_AND_OLD_IMAGES,
    timeToLiveAttribute: "ttl",
  });
  table.addGlobalSecondaryIndex({
    indexName: "Type",
    partitionKey: {
      name: "TypePK",
      type: AttributeType.STRING,
    },
    sortKey: {
      name: "TypeSK",
      type: AttributeType.STRING,
    },
  });
  if (props.headerIndex !== false) {
    table.addGlobalSecondaryIndex({
      indexName: "Header",
      partitionKey: {
        name: "PK",
        type: AttributeType.STRING,
      },
      sortKey: {
        name: "HeaderSK",
        type: AttributeType.STRING,
      },
    });
  }

  for (let i = 0; i < props.projIndexes; i++) {
    let indexId = `Proj${i + 1}`;
    table.addGlobalSecondaryIndex({
      indexName: indexId,
      partitionKey: {
        name: `${indexId}PK`,
        type: AttributeType.STRING,
      },
      sortKey: {
        name: `${indexId}SK`,
        type: AttributeType.STRING,
      },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["id", indexId.toLowerCase()],
    });
  }

  for (let i = 0; i < props.autoIndexes; i++) {
    let indexId = `Auto${i + 1}`;
    table.addGlobalSecondaryIndex({
      indexName: indexId,
      partitionKey: {
        name: `${indexId}PK`,
        type: AttributeType.STRING,
      },
      sortKey: {
        name: `${indexId}SK`,
        type: AttributeType.STRING,
      },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["id", "auto"],
    });
  }

  for (let i = 0; i < props.gsiIndexes; i++) {
    let indexId = `GSI${i + 1}`;
    table.addGlobalSecondaryIndex({
      indexName: indexId,
      partitionKey: {
        name: `${indexId}PK`,
        type: AttributeType.STRING,
      },
      sortKey: {
        name: `${indexId}SK`,
        type: AttributeType.STRING,
      },
    });
  }

  if (props.eventBus) {
    const role = new Role(scope, `${id}PipesRole`, {
      assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    table.grantStreamRead(role);
    props.eventBus.grantPutEventsTo(role);

    const enrichment = MicrowsLambdaFunction(scope, `${id}EnrichmentFunction`, {
      entry: fileURLToPath(new URL("../lambda/dynamoDBStreamEnrichment.js", import.meta.url)),
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.minutes(5),
      environment: {
        NODE_ENV: props.environment.stage,
        DOMAIN: props.environment.domain,
        SERVICE: props.environment.service,
      },
    });
    enrichment.grantInvoke(role);

    const pipe = new CfnPipe(scope, `${id}Pipes`, {
      roleArn: role.roleArn,
      source: table.tableStreamArn,
      sourceParameters: {
        dynamoDbStreamParameters: {
          batchSize: 10,
          maximumBatchingWindowInSeconds: 1,
          startingPosition: "TRIM_HORIZON",
        },
      },
      target: props.eventBus.eventBusArn,
      enrichment: enrichment.functionArn,
      targetParameters: {
        eventBridgeEventBusParameters: {
          detailType: `MicrowsCDC`,
          source: `${props.environment.service}:${id}`,
        },
      },
    });
  }

  return table;
}
