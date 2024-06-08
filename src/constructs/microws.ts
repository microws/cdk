import {
  CfnEgressOnlyInternetGateway,
  CfnSubnet,
  CfnVPCCidrBlock,
  GatewayVpcEndpointAwsService,
  IIpAddresses,
  IpAddresses,
  Peer,
  Port,
  RouterType,
  SecurityGroup,
  Subnet,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Duration, Fn, Tags, aws_kinesis } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AwsLogDriverMode,
  Cluster,
  CpuArchitecture,
  EcrImage,
  FargateService,
  FargateTaskDefinition,
  LinuxParameters,
  LogDrivers,
  OperatingSystemFamily,
  Secret,
} from "aws-cdk-lib/aws-ecs";
import { Construct } from "constructs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Archive, EventBus } from "aws-cdk-lib/aws-events";

type Env = "dev" | "prod";
export function MicrowsAWSAccount(
  scope: Construct & {
    account: string;
  },
  params: {
    /**
     * default: 10.0.0.X/16 where x depends on env
     * dev: 10.0.0.2/16
     * stage: 10.0.0.1/16
     * prod: 10.0.0.0/16
     */
    ipAddress?: IIpAddresses;
    /**
     * This will save on not needing nat Gateways and is still protected by security groups.
     * Not recomended for prod
     */
    publicWebServers?: boolean;
    env: Env;
    certificateArn: string;
  },
) {
  const ipMap = {
    dev: `10.0.0.2/16`,
    stage: `10.0.0.1/16`,
    prod: `10.0.0.0/16`,
  };
  const { ipAddress, publicWebServers, env } = {
    ipAddress: IpAddresses.cidr(ipMap[params.env]),
    publicWebServers: false,
    ...params,
  };

  const vpc = new Vpc(scope, "VPC", {
    ipAddresses: ipAddress,
    vpcName: `/microws/${env}`,
    maxAzs: 3,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    gatewayEndpoints: publicWebServers
      ? {}
      : {
          S3: {
            service: GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnetGroupName: "Application" }],
          },
          DynamoDB: {
            service: GatewayVpcEndpointAwsService.DYNAMODB,
            subnets: [{ subnetGroupName: "Application" }],
          },
        },
    //Just put them in public for now
    natGateways: publicWebServers ? 0 : 1,
    natGatewaySubnets: { subnetGroupName: "Public" },
    subnetConfiguration: [
      {
        name: "Public",
        cidrMask: 23,
        subnetType: SubnetType.PUBLIC,
      },
      {
        name: "Application",
        cidrMask: 23,
        subnetType: publicWebServers ? SubnetType.PUBLIC : SubnetType.PRIVATE_WITH_EGRESS,
        // subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    ],
  });
  const securityGroup = new SecurityGroup(scope, "SecurityGroup", {
    vpc: vpc,
    description: "security group for Load Balancer",
    securityGroupName: "LBSecurityGroup",
    allowAllOutbound: false,
  });
  securityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), "Allow outbound HTTPS");
  securityGroup.addEgressRule(Peer.anyIpv6(), Port.tcp(443), "Allow outbound HTTPS");

  const loadBalancer = new ApplicationLoadBalancer(scope, "ALB", {
    vpc,
    internetFacing: true,
    securityGroup,
    idleTimeout: Duration.seconds(180),
    vpcSubnets: { subnetGroupName: "Public" },
  });
  Tags.of(loadBalancer).add("microws", scope.account);
  Tags.of(loadBalancer).add("env", env);
  loadBalancer.addListener("Redirect", {
    port: 80,
    defaultAction: ListenerAction.redirect({
      port: "443",
      protocol: ApplicationProtocol.HTTPS,
    }),
  });

  const listener = loadBalancer.addListener("Listener", {
    port: 443,
    certificates: [Certificate.fromCertificateArn(scope, "Certificate", params.certificateArn)],
    defaultAction: ListenerAction.fixedResponse(500, {
      contentType: "text/html",
      messageBody: "Error",
    }),
  });
  const bus = new EventBus(scope, "Bus", {
    eventBusName: "Microws" + env,
  });
  const archive = new Archive(scope, `Microws${env.toUpperCase()}Archive`, {
    eventPattern: {
      source: [
        //@ts-ignore
        {
          prefix: "",
        },
      ],
    },
    sourceEventBus: bus,
    retention: Duration.days(7),
  });
  const amazonEventBus = EventBus.fromEventBusName(scope, "AWSEventBus", "default");

  //IPV6
  const ipv6CfnCidrBlock = new CfnVPCCidrBlock(scope, "Ipv6CfnCidrBlock", {
    vpcId: vpc.vpcId,
    amazonProvidedIpv6CidrBlock: true,
  });
  const ipv6CidrBlock = Fn.select(0, vpc.vpcIpv6CidrBlocks);
  const ipv6SubnetCidrBlocks = Fn.cidr(ipv6CidrBlock, 256, "64");
  [...vpc.publicSubnets, ...vpc.privateSubnets, ...vpc.isolatedSubnets].forEach((subnet, index) => {
    const cfnSubnet = subnet.node.defaultChild as CfnSubnet;
    // Assign the ipv6 cidr block to the subnet
    cfnSubnet.ipv6CidrBlock = Fn.select(index, ipv6SubnetCidrBlocks);
    // Enable auto assignment of ipv6 addresses
    cfnSubnet.assignIpv6AddressOnCreation = true;
    // Explicitly disable auto assignment of ipv4 addresses
    cfnSubnet.mapPublicIpOnLaunch = false;
    // Enable DNS64 for the subnet to allow ipv6-only clients to access ipv4 resources
    cfnSubnet.enableDns64 = true;
    // Do not create DNS records for instances on launch - downstream services will create DNS records
    cfnSubnet.privateDnsNameOptionsOnLaunch = {
      EnableResourceNameDnsAAAARecord: false,
      EnableResourceNameDnsARecord: false,
    };
    // Add dependency on the ipv6 cidr block
    cfnSubnet.node.addDependency(ipv6CfnCidrBlock);
    // Add ipv6 cidr block to the map
    // ipv6CidrBlockBySubnet[cfnSubnet.attrSubnetId] = Fn.select(index, ipv6SubnetCidrBlocks);
  });
  if (vpc.privateSubnets.length > 0) {
    // Create egress only internet gateway
    const egressOnlyInternetGateway = new CfnEgressOnlyInternetGateway(scope, "EgressOnlyInternetGateway", {
      vpcId: vpc.vpcId,
    });
    const egressOnlyInternetGatewayId = egressOnlyInternetGateway.ref;
    // Add Route for IPV6 in Private Subnets - Egress only internet gateway
    vpc.privateSubnets.forEach((subnet) => {
      (subnet as Subnet).addRoute("ipv6EgressRoute", {
        routerType: RouterType.EGRESS_ONLY_INTERNET_GATEWAY,
        routerId: egressOnlyInternetGatewayId!,
        destinationIpv6CidrBlock: "::/0",
        enablesInternetConnectivity: true,
      });
      // // Add route fpr DNS64 to allow ipv6-only clients to access ipv4 resources through NAT Translation
      // (subnet as Subnet).addRoute('ipv6Nat64Route', {
      //   routerType: RouterType.NAT_GATEWAY,
      //   routerId: natgatewayId,
      //   destinationIpv6CidrBlock: '64:ff9b::/96',
      // });
    });
  }
  return { vpc };
}

export function MicrowsService(
  scope: Construct & {
    account: string;
  },
  params: {
    /**
     * ex. "Users"
     */
    name: string;
    env: Env;
    image: EcrImage;
    priority: number;
    patterns: Array<ListenerCondition>;
    environmentVariables?: NodeJS.Dict<string>;
    secrets?: NodeJS.Dict<Secret>;
  },
) {
  const { name, env, image, priority, patterns, environmentVariables, secrets } = {
    environmentVariables: {},
    ...params,
  };

  const alb = ApplicationLoadBalancer.fromLookup(scope, "ALB", {
    loadBalancerTags: {
      microws: scope.account,
      env: env,
    },
  });
  const listener = ApplicationListener.fromLookup(scope, "Listener", {
    loadBalancerArn: alb.loadBalancerArn,
    listenerPort: 443,
    listenerProtocol: ApplicationProtocol.HTTPS,
  });
  const vpc = Vpc.fromLookup(scope, "VPC", {
    vpcName: `/microws/${env}`,
  });

  const cluster = new Cluster(scope, name, {
    vpc: vpc,
    enableFargateCapacityProviders: true,
  });

  const fargateTaskDefinition = new FargateTaskDefinition(scope, "Task", {
    memoryLimitMiB: 1024,
    cpu: 256,
    runtimePlatform: {
      // cpuArchitecture: CpuArchitecture.ARM64,
      cpuArchitecture: CpuArchitecture.X86_64,
      operatingSystemFamily: OperatingSystemFamily.LINUX,
    },
  });

  fargateTaskDefinition.addContainer("container", {
    image: image,

    logging: LogDrivers.awsLogs({
      streamPrefix: "website",
      mode: AwsLogDriverMode.NON_BLOCKING,
      logRetention: RetentionDays.ONE_MONTH,
    }),
    linuxParameters: new LinuxParameters(scope, "Parameters", {
      initProcessEnabled: true,
    }),

    environment: environmentVariables,
    secrets: secrets,
    portMappings: [
      {
        containerPort: 3000,
      },
    ],
  });

  const service = new FargateService(scope, "Service", {
    cluster,
    taskDefinition: fargateTaskDefinition,
    desiredCount: 1,
    //TODO fix this back to false or dependant on the vpcSubnet
    assignPublicIp: true,
    vpcSubnets: {
      subnetGroupName: "Application",
    },
  });

  const targetGroup = new ApplicationTargetGroup(scope, "TargetGroup", {
    vpc: vpc,
    port: 80,
    targets: [service],
    healthCheck: {
      path: "/health",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      timeout: Duration.seconds(4),
      interval: Duration.seconds(5),
    },
    deregistrationDelay: Duration.seconds(3),
    protocol: ApplicationProtocol.HTTP,
  });

  listener.addTargetGroups("Website", {
    targetGroups: [targetGroup],
    priority: priority,
    conditions: patterns,
  });

  return { fargateTaskDefinition };
}
