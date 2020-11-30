import * as path from 'path';
import * as ec2 from '@aws-cdk/aws-ec2';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecsPatterns from '@aws-cdk/aws-ecs-patterns';
import * as iam from '@aws-cdk/aws-iam';
import * as kinesis from '@aws-cdk/aws-kinesis';
import * as firehose from '@aws-cdk/aws-kinesisfirehose';
import * as kms from '@aws-cdk/aws-kms';
import * as lambda from '@aws-cdk/aws-lambda';
import * as logs from '@aws-cdk/aws-logs';
import * as logsDestinations from '@aws-cdk/aws-logs-destinations';
import * as s3 from '@aws-cdk/aws-s3';
import { App, Construct, Duration, Stack, StackProps } from '@aws-cdk/core';

interface FargateStackProps extends StackProps {
  readonly memoryLimitMiB: number;
  readonly cpu: number;
}

export class FargateStack extends Stack {
  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 1,
    });

    const logCMK = new kms.Key(this, 'LogCMK', {
      alias: '/unicorn/log',
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
    });

    const dockerImageAsset = new DockerImageAsset(
      this, 'DockerImageAsset', {
        directory: path.join(__dirname, 'backend'),
        buildArgs: {
          JAR_FILE: 'build/libs/*.jar',
        },
      },
    );

    // Create a Lambda Function for filtering log ingested in KDFH
    const functionName = 'kinesis-lambda-processor';
    const lambdaExecRole = new iam.Role(this, 'LambdaExecRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    lambdaExecRole.addToPolicy(new iam.PolicyStatement({
      actions: ['firehose:*'],
      resources: ['*'],
    }));
    lambdaExecRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup'],
      resources: [`arn:aws:logs:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:*`],
    }));
    lambdaExecRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:log-group:/aws/lambda/${functionName}/*`],
    }));
    const processor = new lambda.Function(this, 'LambdaProcessor', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'processor')),
      role: lambdaExecRole,
      timeout: Duration.minutes(5),
      functionName,
      vpc,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE }),
    });

    // Create a S3 Bucket for archiving logs
    const bucket = new s3.Bucket(this, 'LogBucket', {
      encryptionKey: logCMK,
    });

    // Create a S3 Bucket for filtered logs
    const filteredBucket = new s3.Bucket(this, 'FilteredLogBucket', {
      encryptionKey: logCMK,
    });

    // Create a Kinesis Data Stream
    const sourceStream = new kinesis.Stream(this, 'KinesisStream', {
      encryptionKey: logCMK,
    });

    // Create a IAM Role
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    // Allows Firehose to access S3 buckets
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:AbortMultipartUpload',
        's3:GetBucketLocation',
        's3:GetObject',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:PutObject',
        's3:PutObjectAcl', // Add `s3:PutObjectAcl` if you don't own the bucket
      ],
      resources: [
        `${bucket.bucketArn}`,
        `${bucket.bucketArn}/*`,
        `${filteredBucket.bucketArn}`,
        `${filteredBucket.bucketArn}/*`,
      ],
    }));
    // Allows Firehose access to the source Data Streams
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kinesis:DescribeStream',
        'kinesis:GetShardIterator',
        'kinesis:GetRecords',
        'kinesis:ListShards',
      ],
      resources: ['*'],
    }));
    // Allows Firehose to access KMS CMK for decryption
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ],
      resources: [`${logCMK.keyArn}`],
      conditions: {
        StringEquals: {
          'kms:ViaService': `s3.${process.env.CDK_DEFAULT_REGION}.amazonaws.com`,
        },
        StringLike: {
          'kms:EncryptionContext:aws:s3:arn': [
            `${bucket.bucketArn}/logs*`,
            `${filteredBucket.bucketArn}/logs*`,
          ],
        },
      },
    }));
    // Allows Firehose to put log events in CloudWatch Log
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));
    // Allows Firehose invoke processor function and get function configuration
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'lambda:InvokeFunction',
        'lambda:GetFunctionConfiguration',
      ],
      resources: [`${processor.functionArn}*`],
    }));

    const s3DeliveryStreamName = 'logsDeliveryStream';
    const s3DeliveryLogGroup = new logs.LogGroup(this, 'S3DeliveryLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${s3DeliveryStreamName}`,
    });
    new logs.LogStream(this, 'S3DeliveryLogStream', {
      logGroup: s3DeliveryLogGroup,
      logStreamName: 'S3Delivery',
    });

    const extendedS3DeliveryStreamName = 'filteredLogsDeliveryStream';
    const extendedS3DeliveryLogGroup = new logs.LogGroup(this, 'ExtendedS3DeliveryLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${extendedS3DeliveryStreamName}`,
    });
    new logs.LogStream(this, 'ExtendedS3DeliveryLogStream', {
      logGroup: extendedS3DeliveryLogGroup,
      logStreamName: 'S3Delivery',
    });

    // Create a Kinesis Data Firehose with Kinesis Data Stream as Source
    // and S3 Bucket as Destination
    new firehose.CfnDeliveryStream(this, 'S3DeliveryStream', {
      deliveryStreamName: s3DeliveryStreamName,
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: sourceStream.streamArn,
        roleArn: firehoseRole.roleArn,
      },
      s3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        prefix: 'logs/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 1,
        },
        roleArn: firehoseRole.roleArn,
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: `/aws/kinesisfirehose/${s3DeliveryStreamName}`,
          logStreamName: 'S3Delivery',
        },
      },
    });

    // Create a Kinesis Data Firehose with Kinesis Data Stream as Source
    // and filter desired logs using Lambda Processor into a S3 Bucket
    new firehose.CfnDeliveryStream(this, 'ExtendedS3DeliveryStream', {
      deliveryStreamName: extendedS3DeliveryStreamName,
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: sourceStream.streamArn,
        roleArn: firehoseRole.roleArn,
      },
      extendedS3DestinationConfiguration: {
        bucketArn: filteredBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'logs/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 1,
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: processor.functionArn,
                },
              ],
            },
          ],
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: `/aws/kinesisfirehose/${extendedS3DeliveryStreamName}`,
          logStreamName: 'S3Delivery',
        },
      },
    });

    // Create a Kinesis Data Firehose with KDS as Source
    // and Splunk as Destination
    // new firehose.CfnDeliveryStream(this, 'SplunkDeliveryStream', {
    //   deliveryStreamName: 'filteredLogsDeliveryStream',
    //   deliveryStreamType: 'KinesisStreamAsSource',
    //   kinesisStreamSourceConfiguration: {
    //     kinesisStreamArn: stream.streamArn,
    //     roleArn: role.roleArn,
    //   },
    //   splunkDestinationConfiguration: {
    //     hecEndpoint: 'xxx',
    //     hecEndpointType: 'xxx',
    //     hecToken: 'xxx',
    //     s3Configuration: {
    //       bucketArn: 'xxx',
    //       roleArn: 'xxx'
    //     },
    //   },
    // });

    // new firehose.CfnDeliveryStream(this, 'SumoLogicDeliveryStream', {
    //   deliveryStreamName: 'sumologicDeliveryStream',
    //   deliveryStreamType: 'KinesisStreamAsSource',
    //   kinesisStreamSourceConfiguration: {
    //     kinesisStreamArn: stream.streamArn,
    //     roleArn: role.roleArn,
    //   },
    //   httpEndpointDestinationConfiguration: {
    //     bufferingHints: {
    //       intervalInSeconds: 60,
    //       sizeInMBs: 1,
    //     },
    //     endpointConfiguration: {
    //       url: 'xxx',
    //     },
    //     s3Configuration: {
    //       bucketArn: 'bucketarn',
    //       roleArn: role.roleArn,
    //     },
    //   },
    // });

    const logGroupName = 'ecsLogGroup';
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      encryptionKey: logCMK,
      retention: logs.RetentionDays.ONE_WEEK,
    });
    logCMK.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal(`logs.${process.env.CDK_DEFAULT_REGION}.amazonaws.com`)],
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*',
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:log-group:${logGroupName}`,
        },
      },
    }));
    logCMK.addToResourcePolicy(new iam.PolicyStatement({
      principals: [firehoseRole],
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*',
      ],
      resources: ['*'],
    }));

    logGroup.addSubscriptionFilter('SubscriptionFilter', {
      destination: new logsDestinations.KinesisDestination(sourceStream),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    const albTaskImageOptions: ecsPatterns.ApplicationLoadBalancedTaskImageOptions = {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImageAsset),
      containerPort: 8080,
      logDriver: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'ecs', // Do not provide trailing slash in `streamPrefix`
      }),
    };

    const fargateCurrentGen = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'CurrentGenService', {
      cluster,
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      taskImageOptions: albTaskImageOptions,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
    });

    fargateCurrentGen.targetGroup.configureHealthCheck({
      path: '/healthz',
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new FargateStack(app, 'fargate-stack-dev', {
  env: devEnv,
  memoryLimitMiB: 1024,
  cpu: 512,
});

app.synth();
