/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';
import { Organization } from '@aws-accelerator/constructs';
import { Logger } from '../logger';

export class KeyStack extends AcceleratorStack {
  public static readonly CROSS_ACCOUNT_ACCESS_ROLE_NAME = 'AWSAccelerator-CrossAccount-SsmParameter-Role';
  public static readonly ACCELERATOR_KEY_ARN_PARAMETER_NAME = '/accelerator/kms/key-arn';
  public static readonly ACCELERATOR_S3_KEY_ARN_PARAMETER_NAME = '/accelerator/kms/s3/key-arn';

  private readonly organizationId: string;

  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    Logger.debug(`[key-stack] Region: ${cdk.Stack.of(this).region}`);

    this.organizationId = props.organizationConfig.enable ? new Organization(this, 'Organization').id : '';

    const key = new cdk.aws_kms.Key(this, 'AcceleratorKey', {
      alias: 'alias/accelerator/kms/key',
      description: 'AWS Accelerator Kms Key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (props.organizationConfig.enable) {
      // Allow Accelerator Role to use the encryption key
      key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Accelerator Role to use the encryption key`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'aws:PrincipalOrgID': this.organizationId,
            },
            ArnLike: {
              'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
            },
          },
        }),
      );
    }

    // Allow Cloudwatch logs to use the encryption key
    key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow Cloudwatch logs to use the encryption key`,
        principals: [new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Stack.of(this).region}:*:log-group:*`,
          },
        },
      }),
    );

    // Add all services we want to allow usage
    const allowedServicePrincipals: { name: string; principal: string }[] = [
      { name: 'Sns', principal: 'sns.amazonaws.com' },
      { name: 'Lambda', principal: 'lambda.amazonaws.com' },
      { name: 'Cloudwatch', principal: 'cloudwatch.amazonaws.com' },
      { name: 'Sqs', principal: 'sqs.amazonaws.com' },
      // Add similar objects for any other service principal needs access to this key
    ];

    // Deprecated
    if (props.securityConfig.centralSecurityServices.macie.enable) {
      allowedServicePrincipals.push({ name: 'Macie', principal: 'macie.amazonaws.com' });
    }
    // Deprecated
    if (props.securityConfig.centralSecurityServices.guardduty.enable) {
      allowedServicePrincipals.push({ name: 'Guardduty', principal: 'guardduty.amazonaws.com' });
    }
    // Deprecated
    if (props.securityConfig.centralSecurityServices.auditManager?.enable) {
      allowedServicePrincipals.push({ name: 'AuditManager', principal: 'auditmanager.amazonaws.com' });
      key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Audit Manager service to provision encryption key grants`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:CreateGrant'],
          conditions: {
            StringLike: { 'kms:ViaService': 'auditmanager.*.amazonaws.com', 'aws:PrincipalOrgID': this.organizationId },
            Bool: { 'kms:GrantIsForAWSResource': 'true' },
          },
          resources: ['*'],
        }),
      );
    }

    allowedServicePrincipals.forEach(item => {
      key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow ${item.name} service to use the encryption key`,
          principals: [new cdk.aws_iam.ServicePrincipal(item.principal)],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
        }),
      );
    });

    new cdk.aws_ssm.StringParameter(this, 'AcceleratorKmsArnParameter', {
      parameterName: '/accelerator/kms/key-arn',
      stringValue: key.keyArn,
    });

    // IAM Role to get access to accelerator organization level SSM parameters
    // Only create this role in the home region stack
    if (cdk.Stack.of(this).region === props.globalConfig.homeRegion && props.organizationConfig.enable) {
      new cdk.aws_iam.Role(this, 'CrossAccountAcceleratorSsmParamAccessRole', {
        roleName: KeyStack.CROSS_ACCOUNT_ACCESS_ROLE_NAME,
        assumedBy: new cdk.aws_iam.OrganizationPrincipal(this.organizationId),
        inlinePolicies: {
          default: new cdk.aws_iam.PolicyDocument({
            statements: [
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:GetParameters', 'ssm:GetParameter'],
                resources: [
                  `arn:${cdk.Stack.of(this).partition}:ssm:*:${
                    cdk.Stack.of(this).account
                  }:parameter/accelerator/kms/key-arn`,
                  `arn:${cdk.Stack.of(this).partition}:ssm:*:${
                    cdk.Stack.of(this).account
                  }:parameter/accelerator/kms/s3/key-arn`,
                ],
                conditions: {
                  StringEquals: {
                    'aws:PrincipalOrgID': this.organizationId,
                  },
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:DescribeParameters'],
                resources: ['*'],
                conditions: {
                  StringEquals: {
                    'aws:PrincipalOrgID': this.organizationId,
                  },
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
            ],
          }),
        },
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag
      // rule suppression with evidence for this permission.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}/CrossAccountAcceleratorSsmParamAccessRole/Resource`,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'This policy is required to give access to ssm parameters in every region where accelerator deployed. Various accelerator roles need permission to describe SSM parameters.',
          },
        ],
      );
    }

    // Create KMS Key for Security Audit account S3 Buckets
    this.createS3Key();
  }
  private createS3Key() {
    Logger.debug(`[key-stack] Create S3 Key`);
    const s3Key = new cdk.aws_kms.Key(this, 'AcceleratorAuditS3Key', {
      alias: 'alias/accelerator/kms/s3/key',
      description: 'AWS Accelerator S3 Kms Key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    s3Key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow S3 to use the encryption key`,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${cdk.Stack.of(this).region}.amazonaws.com`,
            'aws:PrincipalOrgId': `${this.organizationId}`,
          },
        },
      }),
    );

    s3Key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Allow services to confirm encryption',
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:PrincipalOrgId': `${this.organizationId}`,
          },
        },
      }),
    );

    const allowedServicePrincipals: { name: string; principal: string }[] = [];
    if (this.props.securityConfig.centralSecurityServices.macie.enable) {
      allowedServicePrincipals.push({ name: 'Macie', principal: 'macie.amazonaws.com' });
    }
    if (this.props.securityConfig.centralSecurityServices.guardduty.enable) {
      allowedServicePrincipals.push({ name: 'Guardduty', principal: 'guardduty.amazonaws.com' });
    }

    if (this.props.securityConfig.centralSecurityServices.auditManager?.enable) {
      allowedServicePrincipals.push({ name: 'AuditManager', principal: 'auditmanager.amazonaws.com' });
      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Audit Manager service to provision encryption key grants`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:CreateGrant'],
          conditions: {
            StringLike: { 'kms:ViaService': 'auditmanager.*.amazonaws.com', 'aws:PrincipalOrgID': this.organizationId },
            Bool: { 'kms:GrantIsForAWSResource': 'true' },
          },
          resources: ['*'],
        }),
      );
    }

    allowedServicePrincipals!.forEach(item => {
      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow ${item.name} service to use the encryption key`,
          principals: [new cdk.aws_iam.ServicePrincipal(item.principal)],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
        }),
      );
    });

    new cdk.aws_ssm.StringParameter(this, 'AcceleratorCloudWatchKmsArnParameter', {
      parameterName: KeyStack.ACCELERATOR_S3_KEY_ARN_PARAMETER_NAME,
      stringValue: s3Key.keyArn,
    });
  }
}
