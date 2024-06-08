import { EventBus, IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { Bucket, BucketProps } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import targets from "aws-cdk-lib/aws-events-targets";

export function MicrowsS3(
  scope: Construct,
  id: string,
  props: BucketProps & {
    eventBus: IEventBus;
  },
) {
  const internalProps = { ...props };
  delete internalProps.eventBus;
  if (!internalProps.eventBridgeEnabled) {
    internalProps.eventBridgeEnabled = true;
  }

  const bucket = new Bucket(scope, id, internalProps);

  const awsEventBus = EventBus.fromEventBusName(scope, "AWSEventBus" + id, "default");
  new Rule(scope, id + "AWSEventForwarder", {
    eventBus: awsEventBus,
    eventPattern: {
      source: ["aws.s3"],
      detail: {
        bucket: {
          name: [bucket.bucketName],
        },
      },
    },
    targets: [new targets.EventBus(props.eventBus)],
  });
  return bucket;
}
